import { Hono } from 'hono';
import {
	createServices,
	ForbiddenError,
	NotebookId,
	NotFoundError,
	ProjectId,
} from '@marimo-hub/core';
import { ACTOR } from '@marimo-hub/core/testing';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { FakePublicReleaseHost } from '@marimo-hub/core/testing/public-release-host';
import { describe, expect, it, vi } from 'vitest';
import { parsePublicAppReleases, redirectPublicAppLinks } from './publicAppLinks';

const registrationId = '01J00000000000000000000000';
const releaseOrigin = 'https://dashboard.example.com';
const link = {
	slug: 'sales/week',
	registration_id: registrationId,
	target: {
		kind: 'app' as const,
		project_id: ProjectId.create(),
		notebook_id: NotebookId.create(),
	},
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

	it('bounds anonymous storage lookups', async () => {
		const { app, resolve } = makeApp();
		for (let i = 0; i < 300; i++) {
			expect((await app.request('/app/sales/week', { method: 'HEAD' })).status).toBe(302);
		}
		const response = await app.request('/app/sales/week');
		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('10');
		expect(resolve).toHaveBeenCalledTimes(300);
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

it('checks classification before serving a configured legacy redirect', async () => {
	const app = new Hono();
	const releases = parsePublicAppReleases(
		JSON.stringify({ [link.slug]: { registration_id: registrationId, origin: releaseOrigin } }),
	);
	const assertPublic = vi.fn().mockRejectedValue(new ForbiddenError('Security labels'));
	app.use(
		'/app/*',
		redirectPublicAppLinks(
			releases,
			{ resolve: async () => link },
			undefined,
			undefined,
			assertPublic,
		),
	);
	app.get('*', (c) => c.text('sign in'));
	expect(await (await app.request('/app/sales/week')).text()).toBe('sign in');
	expect(assertPublic).toHaveBeenCalledWith(link.target);
});

it('redirects a managed release until it is unpublished', async () => {
	const host = new FakePublicReleaseHost();
	const services = createServices(new MemoryBucket(), undefined, { publicReleases: { host } });
	await services.catalog.initialize(ACTOR);
	const project = await services.projects.createProject({ name: 'P', description: '' }, ACTOR);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'N', description: '', code: 'import marimo' },
		ACTOR,
	);
	const registered = await services.deepLinks.register(
		'sales',
		{ kind: 'app', project_id: project.id, notebook_id: notebook.id },
		ACTOR,
	);
	const release = await services.publicReleases!.publish({
		projectId: project.id,
		notebookId: notebook.id,
		slug: 'sales',
		registrationId: registered.registration_id,
		versionId: (await services.notebooks.getNotebook(project.id, notebook.id)).source
			.current_version_id!,
		assets: [],
		actor: ACTOR,
	});
	const app = new Hono();
	app.use(
		'/app/*',
		redirectPublicAppLinks(new Map(), services.deepLinks, host.hostSuffix, services.publicReleases),
	);
	app.all('*', (c) => c.text('sign in'));
	expect(await (await app.request('/app/sales')).text()).toBe('sign in');
	await services.publicReleases!.advance(release.release_id, 'worker');
	for (const method of ['GET', 'HEAD']) {
		const response = await app.request('/app/sales?secret=1', { method });
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe(release.origin);
		expect(response.headers.get('cache-control')).toBe('no-store');
	}
	await services.notebooks.setSecurityLabels(
		project.id,
		notebook.id,
		{ classification: 'secret', compartments: [] },
		ACTOR,
	);
	expect(await (await app.request('/app/sales')).text()).toBe('sign in');
	await services.notebooks.setSecurityLabels(project.id, notebook.id, undefined, ACTOR);
	await services.publicReleases!.requestUnpublish(release.release_id, 'user', ACTOR);
	expect(await (await app.request('/app/sales')).text()).toBe('sign in');
	// A worker that started before Unpublish can finish writing the origin afterward.
	await services.deepLinks.setPublicOrigin(
		release.slug,
		release.target,
		release.registration_id,
		release.origin,
	);
	expect(await (await app.request('/app/sales')).text()).toBe('sign in');
});
