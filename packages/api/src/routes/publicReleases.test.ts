import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServices, paths } from '@marimo-hub/core';
import type { DeepLink, NotebookId, ProjectId, PublicReleaseRecord } from '@marimo-hub/core';
import type { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { FakePublicReleaseHost } from '@marimo-hub/core/testing/public-release-host';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

let bucket: MemoryBucket;
let host: FakePublicReleaseHost;
let services: ReturnType<typeof createServices>;
let api: ReturnType<typeof createTestApi>;
let pid: ProjectId;
let nid: NotebookId;
let versionId: string;
let link: DeepLink;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const notebookPath = () => `/projects/${pid}/notebooks/${nid}`;
const releasesPath = () => `${notebookPath()}/public-releases`;

function apiAs(userId = ACTOR, credential?: { kind: 'personal-access-token'; id: string }) {
	return createTestApi({
		bucket,
		userId,
		...(credential ? { subject: { credential } } : {}),
		deps: { services },
	});
}

async function settle(releaseId: string) {
	const service = services.publicReleases!;
	for (let i = 0; i < 10; i++) {
		const record = await service.advance(releaseId, 'test-worker');
		if (record && ['active', 'unpublished', 'failed'].includes(record.state)) return record;
	}
	throw new Error('release did not settle');
}

beforeEach(async () => {
	bucket = await createInitializedBucket();
	host = new FakePublicReleaseHost();
	services = createServices(bucket, undefined, { publicReleases: { host } });
	const project = await services.projects.createProject({ name: 'Apps', description: '' }, ACTOR);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'Sales', description: '', code: 'import marimo' },
		ACTOR,
	);
	pid = project.id;
	nid = notebook.id;
	versionId = (await services.notebooks.getNotebook(project.id, notebook.id)).source
		.current_version_id!;
	api = apiAs();
	link = await expectOk<DeepLink>(
		await api.request('POST', `${notebookPath()}/deep-links`, { slug: 'sales' }),
	);
});

describe('public release routes', () => {
	it('reports managed mode and limits in capabilities', async () => {
		expect(await expectOk(await api.request('GET', '/capabilities'))).toMatchObject({
			public_app_links: {
				available: true,
				mode: 'managed',
				max_live_releases: 5,
				max_assets: 50,
				max_asset_bytes: 26214400,
				max_total_asset_bytes: 52428800,
			},
		});
		const manual = createTestApi({ deps: { publicAppReleaseHostSuffix: '-1.us-west1.run.app' } });
		expect(await expectOk(await manual.request('GET', '/capabilities'))).toMatchObject({
			public_app_links: { mode: 'manual', max_live_releases: null },
		});
		const disabled = createTestApi();
		expect(await expectOk(await disabled.request('GET', '/capabilities'))).toMatchObject({
			public_app_links: { available: false, mode: 'disabled' },
		});
	});

	it('publishes selected files, then unpublishes only after the direct origin is gone', async () => {
		const bytes = new TextEncoder().encode('png');
		await bucket.put(paths.project(pid).notebook(nid).workspaceFile('public/a.png'), bytes);
		const candidates = await expectOk(
			await api.request('GET', `${releasesPath()}/assets?version_id=${versionId}`),
		);
		expect(candidates.assets).toEqual([
			{
				path: 'public/a.png',
				size_bytes: 3,
				sha256: sha256(bytes),
				exposure: 'public_http',
				selectable: true,
			},
		]);
		const release = await expectOk<PublicReleaseRecord>(
			await api.request('POST', releasesPath(), {
				slug: 'sales',
				registration_id: link.registration_id,
				version_id: versionId,
				assets: [{ path: 'public/a.png', sha256: sha256(bytes), size_bytes: 3 }],
			}),
			202,
		);
		expect(release).toMatchObject({ state: 'publishing', assets: [{ exposure: 'public_http' }] });
		expect(release).not.toHaveProperty('lease');

		await expectError(
			await api.request(
				'DELETE',
				`${notebookPath()}/deep-links/sales?registration_id=${link.registration_id}`,
			),
			409,
		);
		await settle(release.release_id);
		const [entry] = await expectOk(await api.request('GET', releasesPath()));
		expect(entry).toMatchObject({ active_release_id: release.release_id });
		expect(
			(await expectOk<DeepLink[]>(await api.request('GET', `${notebookPath()}/deep-links`)))[0]
				.public_origin,
		).toBe(release.origin);

		const done = await expectOk<PublicReleaseRecord>(
			await api.request('POST', `${releasesPath()}/${release.release_id}/unpublish`),
			200,
		);
		expect(done.state).toBe('unpublished');
		expect(host.services.size).toBe(0);
		expect(
			(await expectOk<DeepLink[]>(await api.request('GET', `${notebookPath()}/deep-links`)))[0]
				.public_origin,
		).toBeNull();
		await expectOk(
			await api.request(
				'DELETE',
				`${notebookPath()}/deep-links/sales?registration_id=${link.registration_id}`,
			),
		);
	});

	it('returns 202 while revocation is still in progress', async () => {
		const release = await services.publicReleases!.publish({
			projectId: pid,
			notebookId: nid,
			slug: 'sales',
			registrationId: link.registration_id,
			versionId,
			assets: [],
			actor: ACTOR,
		});
		await settle(release.release_id);
		host.pollsUntilDeleted = 5;
		const pending = await expectOk<PublicReleaseRecord>(
			await api.request('POST', `${releasesPath()}/${release.release_id}/unpublish`),
			202,
		);
		expect(pending.state).toBe('unpublishing');
		expect(
			(await expectOk<DeepLink[]>(await api.request('GET', `${notebookPath()}/deep-links`)))[0]
				.public_origin,
		).toBeNull();
	});

	it('rejects tokens, non-managers and stale asset hashes', async () => {
		const body = { slug: 'sales', registration_id: link.registration_id, version_id: versionId };
		const pat = apiAs(ACTOR, { kind: 'personal-access-token', id: 'tok' });
		expect(
			(await expectError(await pat.request('POST', releasesPath(), body), 403)).message,
		).toContain('Personal access tokens cannot');
		await expectError(
			await pat.request('GET', `${releasesPath()}/assets?version_id=${versionId}`),
			403,
		);
		await services.projects.addMember(pid, { user_id: uid('editor') }, 'editor', ACTOR);
		await expectError(await apiAs(uid('editor')).request('POST', releasesPath(), body), 403);
		await expectError(await apiAs(uid('outsider')).request('POST', releasesPath(), body), 403);
		await expectError(
			await api.request('POST', releasesPath(), {
				...body,
				assets: [{ path: 'public/a.png', sha256: 'a'.repeat(64), size_bytes: 1 }],
			}),
			409,
		);
		expect(host.calls).toEqual([]);
	});

	it('rejects manual release URLs in managed mode', async () => {
		await expectError(
			await api.request('POST', `${notebookPath()}/deep-links`, {
				slug: 'sales',
				publication: {
					registration_id: link.registration_id,
					origin: 'https://marimo-public-x-123456.us-west1.run.app',
				},
			}),
			409,
		);
	});

	it('reserves managed releases for the project owner', async () => {
		const body = { slug: 'sales', registration_id: link.registration_id, version_id: versionId };
		const release = await expectOk<PublicReleaseRecord>(
			await api.request('POST', releasesPath(), body),
			202,
		);
		await services.projects.addMember(pid, { user_id: uid('manager') }, 'manager', ACTOR);
		const manager = apiAs(uid('manager'));
		await expectError(await manager.request('POST', releasesPath(), body), 403);
		await expectError(
			await manager.request('GET', `${releasesPath()}/assets?version_id=${versionId}`),
			403,
		);
		await expectError(
			await manager.request('POST', `${releasesPath()}/${release.release_id}/unpublish`),
			403,
		);
		expect((await services.publicReleases!.getRelease(release.release_id))?.state).toBe(
			'publishing',
		);
	});

	it('withdraws releases when the notebook is deleted', async () => {
		const release = await expectOk<PublicReleaseRecord>(
			await api.request('POST', releasesPath(), {
				slug: 'sales',
				registration_id: link.registration_id,
				version_id: versionId,
			}),
			202,
		);
		await expectOk(await api.request('DELETE', notebookPath()));
		expect(await services.publicReleases!.getRelease(release.release_id)).toMatchObject({
			state: 'unpublishing',
			withdraw_reason: 'target_deleted',
		});
	});

	it('is absent when managed publishing is off', async () => {
		const plain = createTestApi({ bucket });
		await expectError(await plain.request('GET', releasesPath()), 404);
	});
});
