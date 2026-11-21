import { ulidString } from '@marimo-hub/core/string-formats';
import { createRoute, z } from '@hono/zod-openapi';
import {
	DeepLinkAccessSchema,
	DeepLinkSchema,
	DeepLinkSlugSchema,
	PublicAppOriginSchema,
	ConflictError,
	ForbiddenError,
	isApprovedPublicAppOrigin,
	isManagedPublicReleaseOrigin,
	NotFoundError,
	ValidationError,
} from '@marimo-hub/core';
import type { Context } from 'hono';
import type { ApiDeps, HonoEnv } from '../context';
import { appendAudit } from '../log';
import {
	assertProjectRole,
	assertSessionAuthenticated,
	authorizationService,
	commonErrors,
	createApp,
	errorResponses,
	jsonBody,
	jsonContent,
	loadAuthorizedNotebookMeta,
	loadVisibleProject,
	loadSessionProject,
	NotebookIdParam,
} from '../shared';
import { AppSummarySchema, appSummary } from './apps';
import type { DeepLink, DeepLinkTarget, NotebookMeta, Project } from '@marimo-hub/core';

const SlugParam = z.object({ slug: DeepLinkSlugSchema });
const LinkSchema = z.strictObject(DeepLinkSchema.shape).openapi('DeepLink');
const LinkResponse = z.object({ success: z.literal(true), data: LinkSchema });
const errors = { ...commonErrors(), ...errorResponses(403, 404, 409, 422) };
const notebookPath = '/projects/{pid}/notebooks/{nid}/deep-links';
const resolve = createRoute({
	method: 'get',
	path: '/deep-links/{slug}',
	operationId: 'deep-links.resolve',
	tags: ['App links'],
	summary: 'Resolve an app link using notebook permissions',
	request: { params: SlugParam },
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				// NotebookApp is a shared component, so the `app` note lives on this inline object.
				data: z
					.strictObject({ ...LinkSchema.shape, app: AppSummarySchema })
					.describe(
						'The app link. `app` is the app summary for the link target. App users and callers whose token grants `app.read` need `app.read` on the project and notebook; other callers need `project.read`.',
					),
			}),
			'Authorized app link',
		),
		...errors,
	},
});
const list = createRoute({
	method: 'get',
	path: notebookPath,
	operationId: 'deep-links.list',
	tags: ['App links'],
	summary: 'List notebook app links',
	request: { params: NotebookIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.array(LinkSchema) }),
			'App links',
		),
		...errors,
	},
});
const register = createRoute({
	method: 'post',
	path: notebookPath,
	operationId: 'deep-links.register',
	tags: ['App links'],
	summary: 'Register a globally unique app slug',
	description:
		'With `publication`, attaches or disconnects a legacy manual release URL instead. Both need a browser session as the project owner and are audited. Attaching also needs an unlabeled notebook and an approved non-managed release URL, and is refused while managed publishing is enabled. Disconnecting (`origin: null`) only clears a legacy URL, never a managed release.',
	request: {
		params: NotebookIdParam,
		body: jsonBody(
			z.strictObject({
				slug: DeepLinkSlugSchema,
				kind: z.literal('app').default('app'),
				access: DeepLinkAccessSchema.default({ mode: 'inherit' }),
				publication: z
					.object({
						registration_id: ulidString(),
						origin: PublicAppOriginSchema.nullable(),
					})
					.optional(),
			}),
		),
	},
	responses: {
		200: jsonContent(LinkResponse, 'New or existing app link for this notebook'),
		...errors,
	},
});
const release = createRoute({
	method: 'delete',
	path: `${notebookPath}/{slug}`,
	operationId: 'deep-links.release',
	tags: ['App links'],
	summary: 'Release an app slug for immediate reuse',
	description:
		'Releases the slug only when the notebook and registration ID match. The slug is immediately available for reuse. Old shared URLs can then open another notebook. App sessions and notebook permissions stay unchanged.',
	request: {
		params: NotebookIdParam.extend(SlugParam.shape),
		query: z.object({ registration_id: ulidString() }),
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.null() }),
			'Registration released, absent, or replaced',
		),
		...errors,
	},
});

/**
 * Signed-in responses report the release head's managed origin (null once withdrawn); the
 * stored `public_origin` is legacy-only and shown just for registrations with no managed history.
 */
async function withManagedOrigin(deps: ApiDeps, link: DeepLink): Promise<DeepLink> {
	const managed = await deps.services.publicReleases?.resolveManagedOrigin(link);
	return managed === undefined ? link : { ...link, public_origin: managed };
}

/**
 * Attach or disconnect a legacy manual release URL. Managed releases never pass through
 * here: their redirect authority is the release head, so a reserved managed origin can be
 * neither attached nor cleared, and disconnect only CAS-clears the exact legacy origin.
 */
async function setLegacyPublicOrigin(
	c: Context<HonoEnv>,
	input: {
		project: Project;
		meta: NotebookMeta;
		slug: string;
		target: DeepLinkTarget;
		registration_id: string;
		origin: string | null;
	},
): Promise<DeepLink> {
	const deps = c.get('deps');
	const user = c.get('user');
	const { project, meta, slug, target, origin } = input;
	const suffix = deps.publicAppReleaseHostSuffix;
	const managed = deps.services.publicReleases;
	const managedSuffix = managed?.host.hostSuffix ?? suffix;
	const isManaged = (value: string) =>
		managedSuffix !== undefined && isManagedPublicReleaseOrigin(value, managedSuffix);
	const current = (await deps.services.deepLinks.list(target)).find(
		(link) => link.slug === slug && link.registration_id === input.registration_id,
	);
	if (!current) throw new NotFoundError('App link not found');
	assertSessionAuthenticated(
		c,
		origin === null ? 'disconnect a public release URL' : 'publish an app link',
	);
	if (project.owner !== user.id)
		throw new ForbiddenError('Only the project owner can change a public release URL');
	let link: DeepLink;
	if (origin === null) {
		// No label check: an owner must be able to stop a release that was labeled later.
		const attached = current.public_origin;
		if (
			(attached && isManaged(attached)) ||
			(!attached && managed && typeof (await managed.resolveManagedOrigin(current)) === 'string')
		)
			throw new ConflictError('Unpublish the managed public dashboard instead');
		if (attached === null) return withManagedOrigin(deps, current);
		// Undefined allows the server's configured fallback. Fence that fallback with an
		// explicit null, without clearing a manual URL attached in the meantime.
		if (
			!(await deps.services.deepLinks.clearPublicOrigin(
				slug,
				target,
				current.registration_id,
				attached,
			))
		)
			throw new ConflictError('The app link changed; refresh before disconnecting it');
		link = { ...current, public_origin: null };
	} else {
		if (managed)
			throw new ConflictError(
				'Manual public release URLs are disabled while managed publishing is enabled',
			);
		const snapshot = await deps.services.catalog.getCurrentSnapshot();
		const entry = snapshot.projects.find((p) => p.id === project.id);
		if (
			project.security_labels ||
			meta.security_labels ||
			entry?.security_labels_pending ||
			entry?.notebooks.find((n) => n.id === meta.id)?.security_labels_pending
		)
			throw new ForbiddenError('Notebooks with security labels cannot be published publicly');
		if (!isApprovedPublicAppOrigin(origin, suffix) || isManaged(origin))
			throw new ValidationError('Use an approved Marimo public release URL');
		link = await deps.services.deepLinks.setPublicOrigin(
			slug,
			target,
			current.registration_id,
			origin,
		);
	}
	const event = origin === null ? 'deep_link.public_origin_cleared' : 'deep_link.public_origin_set';
	await appendAudit(
		deps,
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		event,
		() =>
			deps.services.events.append({
				event,
				actor: user.id,
				project_id: project.id,
				notebook_id: meta.id,
				slug,
				registration_id: current.registration_id,
				origin: origin ?? current.public_origin ?? null,
			}),
	);
	return withManagedOrigin(deps, link);
}

const app = createApp();
// Proxies can decode %2F before routing; OpenAPI still describes one slug parameter.
app.openAPIRegistry.registerPath(resolve);
app.openAPIRegistry.registerPath(release);
app.openapi({ ...resolve, path: '/deep-links/:slug{[\\s\\S]+}', hide: true }, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const link = await deps.services.deepLinks.resolve(c.req.valid('param').slug);
	const project = await loadSessionProject(
		deps.services.projects,
		link.target.project_id,
		user,
		deps,
	);
	const meta = await loadAuthorizedNotebookMeta(
		deps,
		project,
		link.target.notebook_id,
		user,
		authorizationService(deps).appReadAction(user, project),
	);
	return c.json(
		{
			success: true as const,
			data: {
				...(await withManagedOrigin(deps, link)),
				app: await appSummary(deps, user, project, meta, meta.security_labels ?? null),
			},
		},
		200,
	);
});
app.openapi(list, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const project = await loadVisibleProject(deps.services.projects, pid, user, deps);
	await loadAuthorizedNotebookMeta(deps, project, nid, user, 'project.read');
	return c.json(
		{
			success: true as const,
			data: await Promise.all(
				(
					await deps.services.deepLinks.list({ kind: 'app', project_id: pid, notebook_id: nid })
				).map((link) => withManagedOrigin(deps, link)),
			),
		},
		200,
	);
});
app.openapi(register, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid } = c.req.valid('param');
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		user,
		'deep-link.manage',
		deps,
	);
	const meta = await loadAuthorizedNotebookMeta(deps, project, nid, user, 'deep-link.manage');
	const { slug, publication } = c.req.valid('json');
	const target = { kind: 'app' as const, project_id: pid, notebook_id: nid };
	const link = publication
		? await setLegacyPublicOrigin(c, { project, meta, slug, target, ...publication })
		: await deps.services.deepLinks.register(slug, target, user.id);
	return c.json({ success: true as const, data: link }, 200);
});
app.openapi({ ...release, path: `${notebookPath}/:slug{[\\s\\S]+}`, hide: true }, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, nid, slug } = c.req.valid('param');
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		user,
		'deep-link.manage',
		deps,
	);
	await loadAuthorizedNotebookMeta(deps, project, nid, user, 'deep-link.manage');
	const registrationId = c.req.valid('query').registration_id;
	if (await deps.services.publicReleases?.hasNonTerminalForRegistration(registrationId))
		throw new ConflictError('Unpublish this app link before removing it');
	await deps.services.deepLinks.release(
		slug,
		{ kind: 'app', project_id: pid, notebook_id: nid },
		registrationId,
	);
	return c.json({ success: true as const, data: null }, 200);
});
export default app;
