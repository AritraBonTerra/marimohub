import { Hono } from 'hono';
import { NotFoundError } from '@marimo-hub/core';
import { describe, expect, it, vi } from 'vitest';
import { parsePublicAppReleases, redirectPublicAppLinks } from './publicAppLinks';

const registrationId = '01J00000000000000000000000';
const releaseOrigin = 'https://dashboard.example.com';
const link = {
	slug: 'sales/week',
	registration_id: registrationId,
};

function makeApp(registration = link) {
	const releases = parsePublicAppReleases(
		JSON.stringify({ [link.slug]: { registration_id: registrationId, origin: releaseOrigin } }),
	);
	const resolve = vi.fn(async () => registration);
	const app = new Hono();
	app.use('/app/*', redirectPublicAppLinks(releases, { resolve }));
	app.all('*', (c) => c.text('hub'));
	return { app, resolve };
}

describe('public app links', () => {
	it('redirects a published registration without forwarding query data', async () => {
		const { app, resolve } = makeApp();
		for (const path of ['/app/sales/week', '/app/sales%2Fweek']) {
			const response = await app.request(`${path}?token=private`);
			expect(response.status).toBe(302);
			expect(response.headers.get('location')).toBe(releaseOrigin);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		}
		expect(resolve).toHaveBeenCalledWith(link.slug);
	});

	it('preserves private links and APIs without consulting storage', async () => {
		const { app, resolve } = makeApp();
		expect(await (await app.request('/app/private')).text()).toBe('hub');
		expect(await (await app.request('/api/v1/projects')).text()).toBe('hub');
		expect(await (await app.request('/app/sales/week', { method: 'POST' })).text()).toBe('hub');
		expect(resolve).not.toHaveBeenCalled();
	});

	it('falls through when a slug is removed or reused', async () => {
		const { app, resolve } = makeApp({ ...link, registration_id: 'another' });
		expect(await (await app.request('/app/sales/week')).text()).toBe('hub');
		resolve.mockRejectedValueOnce(new NotFoundError('App link'));
		expect(await (await app.request('/app/sales/week')).text()).toBe('hub');
	});

	it.each(['http://example.com', 'https://example.com/path', 'https://user@example.com'])(
		'rejects invalid release origin %s',
		(origin) => {
			expect(() =>
				parsePublicAppReleases(
					JSON.stringify({ sales: { registration_id: registrationId, origin } }),
				),
			).toThrow('Invalid MARIMOHUB_PUBLIC_APP_RELEASES');
		},
	);
});

it('redirects a published origin on the approved host and stops after unpublishing', async () => {
	const approved = 'https://marimo-public-sales-123.us-west1.run.app';
	const resolve = vi.fn().mockResolvedValue({ ...link, public_origin: approved });
	const app = new Hono();
	app.use('/app/*', redirectPublicAppLinks(new Map(), { resolve }, '-123.us-west1.run.app'));
	app.get('*', (c) => c.text('sign in'));
	expect((await app.request('/app/sales/week')).headers.get('location')).toBe(approved);
	resolve.mockResolvedValue({ ...link, public_origin: null });
	expect(await (await app.request('/app/sales/week')).text()).toBe('sign in');
	resolve.mockResolvedValue({
		...link,
		public_origin: 'https://marimo-public-sales-456.us-west1.run.app',
	});
	expect(await (await app.request('/app/sales/week')).text()).toBe('sign in');
});
