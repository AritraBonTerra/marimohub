import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { FakePublicReleaseHost } from '@marimo-hub/core/testing/public-release-host';
import { createServices } from '../index';
import { ACTOR } from '../../testing';
import { PublicReleaseService } from './PublicReleaseService';
import type { DeepLinkTarget } from '../../deepLinks';
import { ConflictError, ForbiddenError, ValidationError } from '../../errors';
import { paths } from '../../paths';
import { sha256Hex } from '../../internal/sha256';
import { normalizeApprovedAssetPath, deriveAssetExposure } from '../../publicReleases';
import type { PublicReleaseManifest, PublicReleaseRecord } from '../../publicReleases';

let bucket: MemoryBucket;
let services: ReturnType<typeof createServices>;
let host: FakePublicReleaseHost;
let releases: PublicReleaseService;
let target: DeepLinkTarget;
let versionId: string;
let clock: number;

function makeService(
	overrides: Partial<ConstructorParameters<typeof PublicReleaseService>[0]> = {},
) {
	return new PublicReleaseService({
		bucket,
		host,
		deepLinks: services.deepLinks,
		notebooks: services.notebooks,
		projects: services.projects,
		catalog: services.catalog,
		events: services.events,
		fenceMarginMs: 0,
		now: () => clock,
		...overrides,
	});
}

const workspace = (path: string) =>
	paths.project(target.project_id).notebook(target.notebook_id).workspaceFile(path);

async function putAsset(path: string, body: string) {
	await bucket.put(workspace(path), body);
	const bytes = new TextEncoder().encode(body);
	return { path, sha256: await sha256Hex(bytes), size_bytes: bytes.byteLength };
}

async function link(slug = 'sales') {
	return services.deepLinks.register(slug, target, ACTOR);
}

async function publish(
	assets: { path: string; sha256: string; size_bytes: number }[] = [],
	slug = 'sales',
	service = releases,
) {
	const registered = await services.deepLinks.resolve(slug).catch(() => link(slug));
	return service.publish({
		projectId: target.project_id,
		notebookId: target.notebook_id,
		slug,
		registrationId: registered.registration_id,
		versionId,
		assets,
		actor: ACTOR,
	});
}

/** Advance repeatedly, moving the clock past retry delays, until the release settles. */
async function settle(releaseId: string, service = releases, rounds = 20) {
	let record: PublicReleaseRecord | null = null;
	for (let i = 0; i < rounds; i++) {
		record = await service.advance(releaseId, 'worker-a');
		if (record && ['active', 'unpublished', 'failed'].includes(record.state)) return record;
		clock += 6_000;
	}
	return record;
}

async function bundleKeys(releaseId: string) {
	return (await bucket.list({ prefix: paths.publicReleaseBundlePrefix(releaseId) })).objects.map(
		(o) => o.key.slice(paths.publicReleaseBundlePrefix(releaseId).length),
	);
}

beforeEach(async () => {
	clock = Date.parse('2026-11-20T00:00:00Z');
	bucket = new MemoryBucket();
	host = new FakePublicReleaseHost();
	services = createServices(bucket);
	await services.catalog.initialize(ACTOR);
	const project = await services.projects.createProject({ name: 'Sales', description: '' }, ACTOR);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'Sales', description: '', code: 'import marimo\napp = marimo.App()\n' },
		ACTOR,
	);
	target = { kind: 'app', project_id: project.id, notebook_id: notebook.id };
	const detail = await services.notebooks.getNotebook(project.id, notebook.id);
	versionId = detail.source.current_version_id!;
	releases = makeService();
});

describe('asset path rules', () => {
	it.each([
		'.env',
		'.env.local',
		'.git/config',
		'sub/.hidden',
		'__marimo__/x',
		'__pycache__/x.pyc',
		'../escape',
		'a/./b',
		'a\\b',
		'/abs',
		'notebook.py',
		'pyproject.toml',
		'release.json',
		`data/${'a'.repeat(101)}.csv`,
	])('rejects %s', (path) => {
		expect(() => normalizeApprovedAssetPath(path, 'notebook.py')).toThrow(ValidationError);
	});

	it('serves only photos under public/', () => {
		expect(deriveAssetExposure('public/chart.PNG')).toBe('public_http');
		expect(deriveAssetExposure('public/data.csv')).toBe('runtime_only');
		expect(deriveAssetExposure('images/chart.png')).toBe('runtime_only');
	});
});

describe('PublicReleaseService', () => {
	it('lists eligible assets with hashes and never preselects anything', async () => {
		await putAsset('public/photo.jpg', 'jpg');
		await putAsset('data/table.csv', 'a,b');
		await putAsset('.env', 'SECRET=1');
		await putAsset('__marimo__/session.json', '{}');
		const candidates = await releases.listAssetCandidates(
			target.project_id,
			target.notebook_id,
			versionId,
		);
		expect(candidates.entrypoint).toBe('notebook.py');
		expect(candidates.assets.map((a) => [a.path, a.exposure, a.selectable])).toEqual([
			['data/table.csv', 'runtime_only', true],
			['public/photo.jpg', 'public_http', true],
		]);
	});

	it('publishes privately, exposes behind the fence, then swaps the link', async () => {
		const photo = await putAsset('public/photo.jpg', 'jpg');
		const table = await putAsset('data/table.parquet', 'parquet');
		await putAsset('secret.csv', 'do not publish');
		const release = await publish([photo, table]);
		expect(release.state).toBe('publishing');
		expect(host.calls).toEqual([]);
		expect((await bundleKeys(release.release_id)).sort()).toEqual([
			'data/table.parquet',
			'notebook.py',
			'public/photo.jpg',
			'release.json',
		]);

		const active = await settle(release.release_id);
		expect(active).toMatchObject({ state: 'active', image_digest: expect.any(String) });
		const order = host.calls.map((c) => c.method);
		expect(order.indexOf('deployPrivate')).toBeLessThan(order.indexOf('expose'));
		expect((await services.deepLinks.resolve('sales')).public_origin).toBe(release.origin);
		expect(release.origin).toBe(
			`https://marimo-public-${release.release_id.toLowerCase()}-123456.us-west1.run.app`,
		);
		const files = host.services
			.get(release.service_name)!
			.files.map((f) => f.path)
			.sort();
		expect(files).toEqual([
			'data/table.parquet',
			'notebook.py',
			'public/photo.jpg',
			'release.json',
		]);
		expect(await bundleKeys(release.release_id)).toEqual([]);
		const manifest = JSON.parse(
			new TextDecoder().decode(
				host.services.get(release.service_name)!.files.find((f) => f.path === 'release.json')!
					.bytes,
			),
		) as PublicReleaseManifest;
		expect(manifest.files.map((f) => f.path).sort()).toEqual([
			'data/table.parquet',
			'notebook.py',
			'public/photo.jpg',
		]);
	});

	it('pins bytes so later saves and workspace edits do not change the release', async () => {
		const table = await putAsset('data/table.csv', 'v1');
		const release = await publish([table]);
		await bucket.put(workspace('data/table.csv'), 'v2');
		await services.notebooks.updateNotebook(
			target.project_id,
			target.notebook_id,
			{ code: 'import marimo\n# changed\n' },
			ACTOR,
		);
		await settle(release.release_id);
		const deployed = host.services.get(release.service_name)!.files;
		expect(new TextDecoder().decode(deployed.find((f) => f.path === 'data/table.csv')!.bytes)).toBe(
			'v1',
		);
		expect(
			new TextDecoder().decode(deployed.find((f) => f.path === 'notebook.py')!.bytes),
		).not.toContain('changed');
	});

	it('rejects changed, oversize and excess assets before any host call', async () => {
		const table = await putAsset('data/table.csv', 'v1');
		await expect(publish([{ ...table, sha256: 'f'.repeat(64) }])).rejects.toBeInstanceOf(
			ConflictError,
		);
		await expect(publish([{ ...table, size_bytes: 99 }])).rejects.toBeInstanceOf(ConflictError);
		await expect(publish([{ ...table, path: '.env' }])).rejects.toBeInstanceOf(ValidationError);
		await expect(publish([table, table])).rejects.toBeInstanceOf(ValidationError);
		const limited = makeService({ limits: { maxAssets: 1, maxAssetBytes: 1 } });
		await expect(publish([table], 'sales', limited)).rejects.toBeInstanceOf(ValidationError);
		expect(host.calls).toEqual([]);
		expect(await bucket.list({ prefix: paths.publicReleasesPrefix })).toMatchObject({
			objects: [],
		});
	});

	it('enforces the live release cap', async () => {
		const capped = makeService({ limits: { maxLiveReleases: 1 } });
		const results = await Promise.allSettled([
			publish([], 'one', capped),
			publish([], 'two', capped),
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.find((result) => result.status === 'rejected')?.reason).toBeInstanceOf(
			ConflictError,
		);
	});

	it('requires a pending replacement to be cancelled before withdrawing the active app', async () => {
		const initial = await publish();
		await settle(initial.release_id);
		const replacement = await publish();
		await expect(releases.requestUnpublish(initial.release_id, 'user')).rejects.toThrow(
			'Cancel the replacement',
		);
		await releases.requestUnpublish(replacement.release_id, 'user');
		await settle(replacement.release_id);
		await releases.requestUnpublish(initial.release_id, 'user');
		expect((await services.deepLinks.resolve(initial.slug)).public_origin).toBeNull();
		await expect(publish()).rejects.toThrow('Unpublishing is already in progress');
	});

	it('names runtime packages the notebook needs but the base image lacks', async () => {
		host.installedPackages = new Set(['marimo']);
		await services.notebooks.updateNotebook(
			target.project_id,
			target.notebook_id,
			{
				code: '# /// script\n# dependencies = ["polars>=1", "marimo"]\n# ///\nimport marimo\n',
				deps: '[project]\nname = "x"\ndependencies = ["Pandas_Extra==2"]\n',
			},
			ACTOR,
		);
		versionId = (await services.notebooks.getNotebook(target.project_id, target.notebook_id)).source
			.current_version_id!;
		await expect(publish()).rejects.toThrow('does not include: pandas-extra, polars');
	});

	it('refuses labeled notebooks', async () => {
		await services.projects.setSecurityLabels(
			target.project_id,
			{ classification: 'secret', compartments: [] },
			ACTOR,
		);
		await expect(publish()).rejects.toBeInstanceOf(ForbiddenError);
	});

	it('allows one in-flight publish per link', async () => {
		const release = await publish();
		await expect(publish()).rejects.toBeInstanceOf(ConflictError);
		const [entry] = await releases.listForNotebook(target.project_id, target.notebook_id);
		expect(entry.releases.map((record) => record.release_id)).toEqual([release.release_id]);
	});

	it('keeps the old release live until the new one takes over, then retires it', async () => {
		const first = await publish();
		await settle(first.release_id);
		const second = await publish();
		host.hooks.expose = () => {
			throw new Error('cold start failed');
		};
		await releases.advance(second.release_id, 'worker-a');
		expect((await services.deepLinks.resolve('sales')).public_origin).toBe(first.origin);
		host.hooks.expose = undefined;
		clock += 60_000;
		expect(await settle(second.release_id)).toMatchObject({ state: 'active' });
		expect((await services.deepLinks.resolve('sales')).public_origin).toBe(second.origin);
		expect(await releases.getRelease(first.release_id)).toMatchObject({
			state: 'unpublishing',
			withdraw_reason: 'republish_superseded',
		});
		expect(await settle(first.release_id)).toMatchObject({ state: 'unpublished' });
		await expect(releases.requestUnpublish(first.release_id, 'user')).rejects.toThrow(
			'The dashboard has changed',
		);
		expect((await services.deepLinks.resolve('sales')).public_origin).toBe(second.origin);
		expect(host.services.has(first.service_name)).toBe(false);
	});

	it('rolls back a deploy that misses its deadline and leaves the old release untouched', async () => {
		const first = await publish();
		await settle(first.release_id);
		const second = await publish();
		host.pollsUntilReady = 1_000;
		await releases.advance(second.release_id, 'worker-a');
		clock += 11 * 60_000;
		expect(await settle(second.release_id)).toMatchObject({
			state: 'failed',
			withdraw_reason: 'publish_failed',
		});
		expect(host.services.has(second.service_name)).toBe(false);
		expect((await services.deepLinks.resolve('sales')).public_origin).toBe(first.origin);
		expect(await releases.getRelease(first.release_id)).toMatchObject({ state: 'active' });
	});

	it('withdraws an exposed service when the link disappears before the swap', async () => {
		const release = await publish();
		host.hooks.expose = async () => {
			const current = await services.deepLinks.resolve('sales');
			await services.deepLinks.release('sales', target, current.registration_id);
		};
		expect(await settle(release.release_id)).toMatchObject({
			state: 'failed',
			withdraw_reason: 'link_changed',
		});
		expect(host.services.size).toBe(0);
	});

	it('never exposes after a withdrawal reaches a paused worker', async () => {
		const release = await publish();
		host.hooks.deployPrivate = async () => {
			await releases.requestUnpublish(release.release_id, 'user', ACTOR);
		};
		await releases.advance(release.release_id, 'worker-a');
		expect(host.called('expose')).toBe(0);
		expect(await releases.getRelease(release.release_id)).toMatchObject({
			state: 'unpublishing',
		});
	});

	it('holds unpublishing open until the in-flight lease fence passes and the probe is refused', async () => {
		const fenced = makeService({ fenceMarginMs: 60_000 });
		const release = await publish();
		await settle(release.release_id, fenced);
		const republish = await publish([], 'sales', fenced);
		// Unpublish lands while worker A holds the lease inside its deploy call.
		host.hooks.deployPrivate = async () => {
			host.hooks.deployPrivate = undefined;
			await fenced.requestUnpublish(republish.release_id, 'user', ACTOR);
		};
		await fenced.advance(republish.release_id, 'worker-a');
		expect(host.called('expose')).toBe(1);
		const withdrawn = await fenced.getRelease(republish.release_id);
		expect(withdrawn).toMatchObject({ state: 'unpublishing' });
		expect(withdrawn!.fenced_until).toBeGreaterThan(clock + 60_000);
		expect((await services.deepLinks.resolve('sales')).public_origin).toBe(release.origin);

		expect(await fenced.advance(republish.release_id, 'worker-b')).toMatchObject({
			state: 'unpublishing',
		});
		expect(host.services.has(republish.service_name)).toBe(false);
		// A delayed create from the stalled worker lands after the first revoke.
		host.services.set(republish.service_name, {
			releaseId: republish.release_id,
			origin: republish.origin,
			ready: true,
			polls: 1,
			publicInvoker: true,
			deleting: false,
			files: [],
		});
		clock += 200_000;
		host.probe = () => ({ status: 200 });
		await fenced.advance(republish.release_id, 'worker-b');
		expect(await fenced.getRelease(republish.release_id)).toMatchObject({ state: 'unpublishing' });
		host.probe = undefined;
		clock += 6_000;
		expect(await fenced.advance(republish.release_id, 'worker-b')).toMatchObject({
			state: 'failed',
		});
		expect(host.services.has(republish.service_name)).toBe(false);
		const index = await bucket.get(paths.publicReleaseLiveIndex);
		expect(await index?.text()).not.toContain(republish.release_id);
		expect((await services.deepLinks.resolve('sales')).public_origin).toBe(release.origin);
	});

	it('confirms a clean unpublish immediately and records audit events', async () => {
		const from = new Date().toISOString().slice(0, 10);
		const release = await publish();
		await settle(release.release_id);
		await releases.requestUnpublish(release.release_id, 'user', ACTOR);
		expect((await services.deepLinks.resolve('sales')).public_origin).toBeNull();
		expect(await releases.advance(release.release_id, 'worker-b')).toMatchObject({
			state: 'unpublished',
		});
		const { items: events } = await services.events.listEvents({
			from,
			to: new Date().toISOString().slice(0, 10),
			limit: 50,
		});
		expect(events.map((e) => e.event).filter((e) => e.startsWith('public_release.'))).toEqual(
			expect.arrayContaining([
				'public_release.publish_requested',
				'public_release.published',
				'public_release.unpublish_requested',
				'public_release.unpublished',
			]),
		);
	});

	it('records a failed revoke and confirms on a later retry', async () => {
		const release = await publish();
		await settle(release.release_id);
		await releases.requestUnpublish(release.release_id, 'user', ACTOR);
		host.hooks.revoke = () => {
			throw new Error('Cloud Run unavailable');
		};
		expect(await releases.advance(release.release_id, 'worker-a')).toMatchObject({
			state: 'unpublishing',
			error: { message: 'Cloud Run unavailable' },
		});
		host.hooks.revoke = undefined;
		expect(await settle(release.release_id)).toMatchObject({ state: 'unpublished' });
	});

	it('resumes after a crash without creating a second service', async () => {
		host.pollsUntilReady = 2;
		const release = await publish();
		await releases.advance(release.release_id, 'worker-a');
		const restarted = makeService();
		clock += 6_000;
		expect(await settle(release.release_id, restarted)).toMatchObject({ state: 'active' });
		expect(host.services.size).toBe(1);
	});

	it('skips a release leased by another live worker', async () => {
		const release = await publish();
		host.hooks.deployPrivate = async () => {
			expect(await releases.advance(release.release_id, 'worker-b')).toMatchObject({
				lease: { owner: 'worker-a' },
			});
		};
		await releases.advance(release.release_id, 'worker-a');
		expect(host.called('deployPrivate')).toBe(1);
	});

	it.each([
		[
			'labels',
			() =>
				services.notebooks.setSecurityLabels(
					target.project_id,
					target.notebook_id,
					{ classification: 'secret', compartments: [] },
					ACTOR,
				),
			'security_labeled',
		],
		[
			'origin drift',
			() =>
				services.deepLinks
					.resolve('sales')
					.then((l) =>
						services.deepLinks.setPublicOrigin('sales', target, l.registration_id, null),
					),
			'link_changed',
		],
		[
			'deletion',
			() => services.notebooks.deleteNotebook(target.project_id, target.notebook_id, ACTOR),
			'target_deleted',
		],
	] as const)('withdraws an active release on %s', async (_name, change, reason) => {
		const release = await publish();
		await settle(release.release_id);
		await change();
		await releases.reconcileTick('worker-a');
		expect(await releases.getRelease(release.release_id)).toMatchObject({
			state: expect.stringMatching(/unpublishing|unpublished|failed/),
			withdraw_reason: reason,
		});
		expect(host.services.size).toBe(0);
	});

	it('revokes orphaned or unexpectedly public services and ignores manual origins', async () => {
		const manual = await link('manual');
		await services.deepLinks.setPublicOrigin(
			'manual',
			target,
			manual.registration_id,
			'https://marimo-public-manual-123456.us-west1.run.app',
		);
		host.services.set('marimo-public-orphan', {
			releaseId: '01JORPHAN0000000000000000',
			origin: 'https://marimo-public-orphan-123456.us-west1.run.app',
			ready: true,
			polls: 1,
			publicInvoker: true,
			deleting: false,
			files: [],
		});
		const release = await publish();
		host.pollsUntilReady = 5;
		await releases.advance(release.release_id, 'worker-a');
		host.services.get(release.service_name)!.publicInvoker = true;
		clock += 6_000;
		await releases.reconcileTick('worker-a');
		expect(host.services.has('marimo-public-orphan')).toBe(false);
		expect(await releases.getRelease(release.release_id)).toMatchObject({
			withdraw_reason: 'publish_failed',
		});
		expect((await services.deepLinks.resolve('manual')).public_origin).toBe(
			'https://marimo-public-manual-123456.us-west1.run.app',
		);
	});

	it('withdraws every release for a deleted project and blocks notebook moves', async () => {
		const release = await publish();
		expect(await releases.hasNonTerminalForNotebook(target.project_id, target.notebook_id)).toBe(
			true,
		);
		expect(await releases.withdrawTarget({ projectId: target.project_id }, 'target_deleted')).toBe(
			1,
		);
		expect(await releases.getRelease(release.release_id)).toMatchObject({
			state: 'unpublishing',
			withdraw_reason: 'target_deleted',
		});
		expect(await settle(release.release_id)).toMatchObject({ state: 'failed' });
		expect(await releases.hasNonTerminalForNotebook(target.project_id, target.notebook_id)).toBe(
			false,
		);
	});

	it('reports releases per link for the dialog', async () => {
		const release = await publish();
		await settle(release.release_id);
		const [entry] = await releases.listForNotebook(target.project_id, target.notebook_id);
		expect(entry).toMatchObject({
			slug: 'sales',
			active_release_id: release.release_id,
			pending_release_id: null,
			releases: [{ release_id: release.release_id, state: 'active' }],
		});
	});
});
