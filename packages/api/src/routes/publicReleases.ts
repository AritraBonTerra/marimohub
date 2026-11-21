import { createRoute, z } from '@hono/zod-openapi';
import { ulidString } from '@marimo-hub/core/string-formats';
import {
	DeepLinkSlugSchema,
	ForbiddenError,
	NotFoundError,
	PublicReleaseAssetExposureSchema,
	PublicReleaseRecordSchema,
	VersionIdSchema,
} from '@marimo-hub/core';
import type {
	NotebookId,
	ProjectId,
	PublicReleaseRecord,
	PublicReleaseService,
} from '@marimo-hub/core';
import type { Context } from 'hono';
import {
	assertProjectRole,
	assertSessionAuthenticated,
	commonErrors,
	createApp,
	errorResponses,
	jsonBody,
	jsonContent,
	loadAuthorizedNotebookMeta,
	loadVisibleProject,
	NotebookIdParam,
	SESSION_ONLY_SECURITY,
} from '../shared';
import type { HonoEnv } from '../context';

const INLINE_UNPUBLISH_MS = 8_000;
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);

const PublicReleaseSchema = z
	.strictObject(
		PublicReleaseRecordSchema.pick({
			release_id: true,
			slug: true,
			registration_id: true,
			version_id: true,
			entrypoint: true,
			code_sha256: true,
			assets: true,
			origin: true,
			state: true,
			withdraw_requested: true,
			withdraw_reason: true,
			error: true,
			image_digest: true,
			created_by: true,
			created_at: true,
			updated_at: true,
			activated_at: true,
			unpublish_requested_at: true,
			unpublished_at: true,
		}).shape,
	)
	.openapi('PublicRelease');

/** Explicit projection: leases, fences and storage keys stay internal. */
function toPublicRelease(record: PublicReleaseRecord): z.infer<typeof PublicReleaseSchema> {
	return {
		release_id: record.release_id,
		slug: record.slug,
		registration_id: record.registration_id,
		version_id: record.version_id,
		entrypoint: record.entrypoint,
		code_sha256: record.code_sha256,
		assets: record.assets,
		origin: record.origin,
		state: record.state,
		withdraw_requested: record.withdraw_requested,
		withdraw_reason: record.withdraw_reason,
		error: record.error,
		image_digest: record.image_digest,
		created_by: record.created_by,
		created_at: record.created_at,
		updated_at: record.updated_at,
		activated_at: record.activated_at,
		unpublish_requested_at: record.unpublish_requested_at,
		unpublished_at: record.unpublished_at,
	};
}

const ReleaseResponse = z.object({ success: z.literal(true), data: PublicReleaseSchema });
const errors = { ...commonErrors(), ...errorResponses(403, 404, 409, 422) };
const basePath = '/projects/{pid}/notebooks/{nid}/public-releases';

const list = createRoute({
	method: 'get',
	path: basePath,
	operationId: 'public-releases.list',
	tags: ['App links'],
	summary: 'List managed public releases for each app link of a notebook',
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.array(
					z.strictObject({
						registration_id: ulidString(),
						slug: DeepLinkSlugSchema,
						active_release_id: ulidString().nullable(),
						pending_release_id: ulidString().nullable(),
						releases: z.array(PublicReleaseSchema),
					}),
				),
			}),
			'Releases per app link, newest first',
		),
		...errors,
	},
});

const assets = createRoute({
	method: 'get',
	path: `${basePath}/assets`,
	operationId: 'public-releases.assets',
	tags: ['App links'],
	summary: 'List workspace files that can be approved for a public release',
	description:
		'Hidden files, generated caches, the notebook entrypoint and `pyproject.toml` are never listed. Only photos under `public/` are web-served; other files are readable from Python only.',
	security: SESSION_ONLY_SECURITY,
	request: { params: NotebookIdParam, query: z.object({ version_id: VersionIdSchema }) },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: z.strictObject({
					version_id: VersionIdSchema,
					entrypoint: z.string(),
					assets: z.array(
						z.strictObject({
							path: z.string(),
							size_bytes: z.number().int().nonnegative(),
							sha256: SHA256.nullable(),
							exposure: PublicReleaseAssetExposureSchema,
							selectable: z.boolean(),
							reason: z.literal('exceeds_max_file_bytes').optional(),
						}),
					),
				}),
			}),
			'Candidate files with their current hashes',
		),
		...errors,
	},
});

const publish = createRoute({
	method: 'post',
	path: basePath,
	operationId: 'public-releases.publish',
	tags: ['App links'],
	summary: 'Publish a saved notebook version as an anonymous public dashboard',
	description:
		'Freezes the version and the approved files, then deploys them privately before granting anonymous access. The app link keeps its current target until the new release answers anonymously. Browser sessions only.',
	security: SESSION_ONLY_SECURITY,
	request: {
		params: NotebookIdParam,
		body: jsonBody(
			z.strictObject({
				slug: DeepLinkSlugSchema,
				registration_id: ulidString(),
				version_id: VersionIdSchema,
				assets: z
					.array(
						z.strictObject({
							path: z.string(),
							sha256: SHA256,
							size_bytes: z.number().int().nonnegative(),
						}),
					)
					.default([]),
			}),
		),
	},
	responses: { 202: jsonContent(ReleaseResponse, 'Release queued'), ...errors },
});

const unpublish = createRoute({
	method: 'post',
	path: `${basePath}/{release_id}/unpublish`,
	operationId: 'public-releases.unpublish',
	tags: ['App links'],
	summary: 'Stop a public dashboard',
	description:
		'Clears the app link redirect immediately. Returns 200 once the host confirms the direct release URL refuses anonymous visitors, or 202 while revocation continues in the background.',
	security: SESSION_ONLY_SECURITY,
	request: { params: NotebookIdParam.extend({ release_id: ulidString() }) },
	responses: {
		200: jsonContent(ReleaseResponse, 'Release revoked'),
		202: jsonContent(ReleaseResponse, 'Revocation in progress'),
		...errors,
	},
});

function managed(c: Context<HonoEnv>): PublicReleaseService {
	const service = c.get('deps').services.publicReleases;
	if (!service) throw new NotFoundError('Managed public publishing is not enabled');
	return service;
}

async function authorizeManage(
	c: Context<HonoEnv>,
	pid: ProjectId,
	nid: NotebookId,
	action: string,
) {
	assertSessionAuthenticated(c, action);
	const deps = c.get('deps');
	const user = c.get('user');
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		user,
		'deep-link.manage',
		deps,
	);
	if (project.owner !== user.id)
		throw new ForbiddenError('Only the project owner can manage public dashboard releases');
	await loadAuthorizedNotebookMeta(deps, project, nid, user, 'deep-link.manage');
}

const app = createApp();

app.openapi(list, async (c) => {
	const deps = c.get('deps');
	const { pid, nid } = c.req.valid('param');
	const service = managed(c);
	const project = await loadVisibleProject(deps.services.projects, pid, c.get('user'), deps);
	await loadAuthorizedNotebookMeta(deps, project, nid, c.get('user'), 'project.read');
	const links = await service.listForNotebook(pid, nid);
	return c.json(
		{
			success: true as const,
			data: links.map((link) => ({ ...link, releases: link.releases.map(toPublicRelease) })),
		},
		200,
	);
});

app.openapi(assets, async (c) => {
	const { pid, nid } = c.req.valid('param');
	const service = managed(c);
	await authorizeManage(c, pid, nid, 'publish a public app link');
	const data = await service.listAssetCandidates(pid, nid, c.req.valid('query').version_id);
	return c.json({ success: true as const, data }, 200);
});

app.openapi(publish, async (c) => {
	const { pid, nid } = c.req.valid('param');
	const service = managed(c);
	await authorizeManage(c, pid, nid, 'publish a public app link');
	const body = c.req.valid('json');
	const record = await service.publish({
		projectId: pid,
		notebookId: nid,
		slug: body.slug,
		registrationId: body.registration_id,
		versionId: body.version_id,
		assets: body.assets,
		actor: c.get('user').id,
	});
	return c.json({ success: true as const, data: toPublicRelease(record) }, 202);
});

app.openapi(unpublish, async (c) => {
	const { pid, nid, release_id } = c.req.valid('param');
	const service = managed(c);
	await authorizeManage(c, pid, nid, 'unpublish a public app link');
	const existing = await service.getRelease(release_id);
	if (!existing || existing.target.project_id !== pid || existing.target.notebook_id !== nid)
		throw new NotFoundError('Public release not found');
	let record = await service.requestUnpublish(release_id, 'user', c.get('user').id);
	// One bounded attempt so a quick revoke confirms in the same request; the reconciler
	// finishes anything left over.
	try {
		record =
			(await service.advance(
				release_id,
				`api-${crypto.randomUUID()}`,
				AbortSignal.timeout(INLINE_UNPUBLISH_MS),
			)) ?? record;
	} catch {
		// Revocation continues on the maintenance replica.
	}
	const done = record.state === 'unpublished' || record.state === 'failed';
	return done
		? c.json({ success: true as const, data: toPublicRelease(record) }, 200)
		: c.json({ success: true as const, data: toPublicRelease(record) }, 202);
});

export default app;
