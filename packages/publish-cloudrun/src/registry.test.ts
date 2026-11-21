import { describe, expect, it } from 'vitest';
import { pullScope, RegistryClient } from './oci';

const HOST = 'us-west1-docker.pkg.dev';
const DIGEST = `sha256:${'b'.repeat(64)}`;

interface Sent {
	url: string;
	method: string;
	authorization: string | null;
	redirect?: RequestRedirect;
}

/** A registry that answers each request with the next scripted response. */
function scripted(responses: ((url: URL) => Response)[]) {
	const sent: Sent[] = [];
	const fetchImpl: typeof fetch = async (input, init = {}) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		sent.push({
			url: url.toString(),
			method: init.method ?? 'GET',
			authorization: new Headers(init.headers).get('authorization'),
			redirect: init.redirect,
		});
		const next = responses.shift();
		if (!next) throw new Error(`unexpected ${url}`);
		return next(url);
	};
	return {
		sent,
		client: new RegistryClient(HOST, { getToken: async () => 'g', fetch: fetchImpl }),
	};
}

const challenge = (realm: string) => () =>
	new Response('', {
		status: 401,
		headers: { 'WWW-Authenticate': `Bearer realm="${realm}",service="${HOST}"` },
	});

describe('RegistryClient', () => {
	it('refuses a token realm off the registry host', async () => {
		const { sent, client } = scripted([challenge('https://tokens.example.com/v2/token')]);
		await expect(
			client.request(`p/r/base/blobs/${DIGEST}`, [pullScope('p/r/base')]),
		).rejects.toThrow('token realm');
		expect(sent).toHaveLength(1);
		expect(sent[0].authorization).toBeNull();
	});

	it('refuses request URLs outside the registry origin', async () => {
		const { sent, client } = scripted([]);
		await expect(
			client.request('https://uploads.example.com/v2/p/r/x', [pullScope('p/r/x')], {
				method: 'PUT',
			}),
		).rejects.toThrow('outside');
		expect(sent).toEqual([]);
	});

	it('follows blob redirects to storage without the registry credential', async () => {
		const { sent, client } = scripted([
			challenge(`https://${HOST}/v2/token`),
			() => Response.json({ token: 'registry-token' }),
			() =>
				new Response('', {
					status: 302,
					headers: { Location: 'https://storage.example.com/signed?x=1' },
				}),
			() => new Response('blob'),
		]);
		const response = await client.request(`p/r/base/blobs/${DIGEST}`, [pullScope('p/r/base')]);
		expect(await response.text()).toBe('blob');
		expect(sent.map((s) => [new URL(s.url).host, s.authorization?.split(' ')[0] ?? null])).toEqual([
			[HOST, null],
			[HOST, 'Basic'],
			[HOST, 'Bearer'],
			['storage.example.com', null],
		]);
		expect(new URL(sent[1].url).searchParams.getAll('scope')).toEqual(['repository:p/r/base:pull']);
		expect(sent[1].redirect).toBe('error');
	});

	it('passes the caller signal to the Google token request', async () => {
		const controller = new AbortController();
		const seen: (AbortSignal | undefined)[] = [];
		const client = new RegistryClient(HOST, {
			getToken: async (signal) => {
				seen.push(signal);
				return 'g';
			},
			fetch: async (input) =>
				new URL(input.toString()).pathname === '/v2/token'
					? Response.json({ token: 't' })
					: seen.length > 0
						? new Response('ok')
						: challenge(`https://${HOST}/v2/token`)(),
		});
		await client.request(`p/r/base/blobs/${DIGEST}`, [pullScope('p/r/base')], {
			signal: controller.signal,
		});
		expect(seen).toEqual([controller.signal]);
	});
});
