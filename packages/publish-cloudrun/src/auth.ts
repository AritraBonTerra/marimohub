import { importPKCS8, SignJWT } from 'jose';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const METADATA_ACCOUNT_URL =
	'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default';
/** The only OAuth endpoint a signed service-account assertion may be sent to. */
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const REQUEST_TIMEOUT_MS = 15_000;

interface ServiceAccountKey {
	client_email: string;
	private_key: string;
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
	// A key file chooses where its signed assertion goes; accept only Google's token endpoint.
	if (
		'token_uri' in parsed &&
		parsed.token_uri !== undefined &&
		parsed.token_uri !== GOOGLE_TOKEN_URI
	)
		throw new Error(`Invalid service account key: token_uri must be ${GOOGLE_TOKEN_URI}`);
	return { client_email: parsed.client_email, private_key: parsed.private_key };
}

/** Combine the caller's signal with a per-request timeout. */
export function bounded(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** The metadata server answers only with `Metadata-Flavor: Google` and never redirects. */
async function metadata(path: string, fetchImpl: typeof fetch, signal?: AbortSignal) {
	const response = await fetchImpl(`${METADATA_ACCOUNT_URL}/${path}`, {
		headers: { 'Metadata-Flavor': 'Google' },
		redirect: 'error',
		signal: bounded(signal, REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`Metadata server request failed: ${response.status}`);
	if (response.headers.get('metadata-flavor') !== 'Google')
		throw new Error('Metadata server response had no Metadata-Flavor header');
	return response;
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

export interface GoogleCredentials {
	/** Cached cloud-platform access token. */
	getToken(signal?: AbortSignal): Promise<string>;
	/** Email of the identity `getToken` acts as. */
	getEmail(signal?: AbortSignal): Promise<string>;
}

/**
 * Google credentials from a service-account key, or from the GCE/Cloud Run metadata
 * server when no key is configured. Every request is bounded by the caller's signal
 * and a timeout, and credentials go only to Google's fixed endpoints.
 */
export function googleCredentials(
	options: { serviceAccountKey?: string; fetch?: typeof fetch } = {},
): GoogleCredentials {
	const fetchImpl = options.fetch ?? fetch;
	const key = options.serviceAccountKey ? parseKey(options.serviceAccountKey) : undefined;
	let cached: { token: string; expiresAt: number } | undefined;
	let email: string | undefined;
	return {
		async getToken(signal) {
			if (cached && cached.expiresAt > Date.now()) return cached.token;
			let result;
			if (key) {
				const assertion = await new SignJWT({ scope: SCOPE })
					.setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
					.setIssuer(key.client_email)
					.setSubject(key.client_email)
					.setAudience(GOOGLE_TOKEN_URI)
					.setIssuedAt()
					.setExpirationTime('1h')
					.sign(await importPKCS8(key.private_key.replaceAll('\\n', '\n'), 'RS256'));
				result = await readToken(
					await fetchImpl(GOOGLE_TOKEN_URI, {
						method: 'POST',
						headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
						body: new URLSearchParams({
							grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
							assertion,
						}),
						redirect: 'error',
						signal: bounded(signal, REQUEST_TIMEOUT_MS),
					}),
				);
			} else {
				result = await readToken(
					await metadata(`token?scopes=${encodeURIComponent(SCOPE)}`, fetchImpl, signal),
				);
			}
			cached = { token: result.token, expiresAt: Date.now() + (result.expiresIn - 60) * 1000 };
			return result.token;
		},
		async getEmail(signal) {
			if (key) return key.client_email;
			if (email) return email;
			const value = (await (await metadata('email', fetchImpl, signal)).text()).trim();
			if (!value) throw new Error('Metadata server returned no service account email');
			email = value;
			return email;
		},
	};
}
