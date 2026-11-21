import { importPKCS8, SignJWT } from 'jose';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const METADATA_TOKEN_URL =
	'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

interface ServiceAccountKey {
	client_email: string;
	private_key: string;
	token_uri?: string;
}

function parseKey(raw: string): ServiceAccountKey {
	const parsed: unknown = JSON.parse(raw);
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('client_email' in parsed) ||
		!('private_key' in parsed) ||
		typeof parsed.client_email !== 'string' ||
		typeof parsed.private_key !== 'string'
	)
		throw new Error('Invalid service account key: expected client_email and private_key');
	const tokenUri =
		'token_uri' in parsed && typeof parsed.token_uri === 'string' ? parsed.token_uri : undefined;
	return {
		client_email: parsed.client_email,
		private_key: parsed.private_key,
		token_uri: tokenUri,
	};
}

async function readToken(response: Response): Promise<{ token: string; expiresIn: number }> {
	if (!response.ok) throw new Error(`Google token request failed: ${response.status}`);
	const body: unknown = await response.json();
	if (
		typeof body !== 'object' ||
		body === null ||
		!('access_token' in body) ||
		typeof body.access_token !== 'string'
	)
		throw new Error('Google token response had no access_token');
	const expiresIn =
		'expires_in' in body && typeof body.expires_in === 'number' ? body.expires_in : 300;
	return { token: body.access_token, expiresIn };
}

/**
 * Cached Google access token from a service-account key, or from the GCE/Cloud Run
 * metadata server when no key is configured.
 */
export function googleAccessToken(
	options: { serviceAccountKey?: string; fetch?: typeof fetch } = {},
): () => Promise<string> {
	const fetchImpl = options.fetch ?? fetch;
	const key = options.serviceAccountKey ? parseKey(options.serviceAccountKey) : undefined;
	let cached: { token: string; expiresAt: number } | undefined;
	return async () => {
		if (cached && cached.expiresAt > Date.now()) return cached.token;
		let result;
		if (key) {
			const tokenUri = key.token_uri || DEFAULT_TOKEN_URI;
			const assertion = await new SignJWT({ scope: SCOPE })
				.setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
				.setIssuer(key.client_email)
				.setSubject(key.client_email)
				.setAudience(tokenUri)
				.setIssuedAt()
				.setExpirationTime('1h')
				.sign(await importPKCS8(key.private_key.replaceAll('\\n', '\n'), 'RS256'));
			result = await readToken(
				await fetchImpl(tokenUri, {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({
						grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
						assertion,
					}),
				}),
			);
		} else {
			result = await readToken(
				await fetchImpl(`${METADATA_TOKEN_URL}?scopes=${encodeURIComponent(SCOPE)}`, {
					headers: { 'Metadata-Flavor': 'Google' },
				}),
			);
		}
		cached = { token: result.token, expiresAt: Date.now() + (result.expiresIn - 60) * 1000 };
		return result.token;
	};
}
