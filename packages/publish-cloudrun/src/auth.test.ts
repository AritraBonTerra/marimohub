import { describe, expect, it } from 'vitest';
import { googleCredentials } from './auth';

const key = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({ client_email: 'pub@p.iam.gserviceaccount.com', private_key: 'x', ...extra });

describe('googleCredentials', () => {
	it('rejects a key whose token_uri is not Google’s token endpoint', () => {
		expect(() =>
			googleCredentials({ serviceAccountKey: key({ token_uri: 'https://evil.example/token' }) }),
		).toThrow('token_uri');
		expect(() =>
			googleCredentials({
				serviceAccountKey: key({ token_uri: 'https://oauth2.googleapis.com/token' }),
			}),
		).not.toThrow();
	});

	it('reads the key email without a network call', async () => {
		const credentials = googleCredentials({
			serviceAccountKey: key(),
			fetch: () => Promise.reject(new Error('no network')),
		});
		expect(await credentials.getEmail()).toBe('pub@p.iam.gserviceaccount.com');
	});

	it('reads the metadata identity with a bounded, non-redirecting request', async () => {
		const seen: RequestInit[] = [];
		const credentials = googleCredentials({
			fetch: async (input, init = {}) => {
				seen.push(init);
				const path = new URL(input.toString()).pathname;
				const flavor = { headers: { 'Metadata-Flavor': 'Google' } };
				return path.endsWith('/email')
					? new Response('hub@p.iam.gserviceaccount.com\n', flavor)
					: Response.json({ access_token: 'tok', expires_in: 3600 }, flavor);
			},
		});
		const controller = new AbortController();
		expect(await credentials.getEmail(controller.signal)).toBe('hub@p.iam.gserviceaccount.com');
		expect(await credentials.getToken(controller.signal)).toBe('tok');
		expect(seen.every((init) => init.redirect === 'error' && init.signal)).toBe(true);
		controller.abort();
		expect(seen.every((init) => init.signal?.aborted)).toBe(true);
	});

	it('rejects metadata responses without the Metadata-Flavor header', async () => {
		const credentials = googleCredentials({
			fetch: async () => Response.json({ access_token: 'tok' }),
		});
		await expect(credentials.getToken()).rejects.toThrow('Metadata-Flavor');
	});
});
