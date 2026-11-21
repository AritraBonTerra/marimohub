import { ulid } from 'ulidx';
import { parse as parseToml } from 'smol-toml';
import type { Bucket } from '../../ports/bucket';
import type { PublicReleaseBundleFile, PublicReleaseHost } from '../../ports/publicReleaseHost';
import { PublicReleaseHostFatalError } from '../../ports/publicReleaseHost';
import type { DeepLink, DeepLinkTarget } from '../../deepLinks';
import {
	ConflictError,
	ForbiddenError,
	NotFoundError,
	PreconditionFailedError,
	ValidationError,
} from '../../errors';
import { SYSTEM_ACTOR, VersionId } from '../../ids';
import type { NotebookId, ProjectId, UserId } from '../../ids';
import { paths } from '../../paths';
import { readStored } from '../../schema';
import { sha256Hex } from '../../internal/sha256';
import { logEvent } from '../../logs';
import { logOperationalError } from '../../operationalLog';
import { mapWithConcurrency } from '../../concurrency';
import {
	isWorkspaceDirectoryMarkerPath,
	remoteWorkspaceEntry,
	workspaceSourcePolicy,
} from '../../integrations/remoteWorkspace';
import { listAllKeys, listAllObjects } from '../catalog/storage';
import {
	DEFAULT_PUBLIC_RELEASE_LIMITS,
	deriveAssetExposure,
	deriveDeterministicOrigin,
	isArchiveableReleasePath,
	isEligibleAssetPath,
	normalizeApprovedAssetPath,
	normalizePackageName,
	isManagedPublicReleaseOrigin,
	PublicReleaseHeadSchema,
	PublicReleaseLiveIndexSchema,
	PublicReleaseRecordSchema,
	publicReleaseServiceName,
	requirementName,
	TERMINAL_PUBLIC_RELEASE_STATES,
} from '../../publicReleases';
import type {
	PublicReleaseAsset,
	PublicReleaseHead,
	PublicReleaseLimits,
	PublicReleaseManifest,
	PublicReleaseRecord,
	PublicReleaseWithdrawReason,
} from '../../publicReleases';
import type { DeepLinkService } from './DeepLinkService';
import type { NotebookService } from './NotebookService';
import type { ProjectService } from './ProjectService';
import type { CatalogService } from '../catalog/CatalogService';
import type { EventService } from '../catalog/EventService';

const LEASE_MS = 90_000;
const PUBLISH_DEADLINE_MS = 10 * 60_000;
const POLL_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_CANDIDATES = 500;
const MAX_PREVIEW_OBJECTS = 1_000;
const MAX_STEPS_PER_ADVANCE = 4;
const RECONCILE_CONCURRENCY = 3;
const MAX_NOTEBOOK_BYTES = 10 * 1024 * 1024;

export interface PublicReleaseServiceDeps {
	bucket: Bucket;
	host: PublicReleaseHost;
	deepLinks: Pick<DeepLinkService, 'resolve' | 'clearPublicOrigin' | 'list'>;
	notebooks: Pick<NotebookService, 'getNotebookSource' | 'getNotebookMeta' | 'getVersion'>;
	projects: Pick<ProjectService, 'getProject'>;
	catalog: Pick<CatalogService, 'getCurrentSnapshot'>;
	events: Pick<EventService, 'append'>;
	limits?: Partial<PublicReleaseLimits>;
	/**
	 * Delay after a withdrawal before revocation can be confirmed, covering cloud requests
	 * that were sent before the withdrawal but land after the first revoke.
	 */
	fenceMarginMs?: number;
	now?: () => number;
}

export interface PublicReleaseAssetCandidate {
	path: string;
	size_bytes: number;
	sha256: string | null;
	exposure: PublicReleaseAsset['exposure'];
	selectable: boolean;
	reason?: 'exceeds_max_file_bytes';
}

export interface PublishPublicReleaseInput {
	projectId: ProjectId;
	notebookId: NotebookId;
	slug: string;
	registrationId: string;
	versionId: string;
	assets: readonly { path: string; sha256: string; size_bytes: number }[];
	actor: UserId;
}

export interface PublicAppLinkReleases {
	registration_id: string;
	slug: string;
	active_release_id: string | null;
	pending_release_id: string | null;
	releases: PublicReleaseRecord[];
}

type Stored = { record: PublicReleaseRecord; etag: string };
type Step = Stored | null;

function sameTarget(a: DeepLinkTarget, b: DeepLinkTarget): boolean {
	return a.kind === b.kind && a.project_id === b.project_id && a.notebook_id === b.notebook_id;
}

function isTerminal(record: PublicReleaseRecord): boolean {
	return TERMINAL_PUBLIC_RELEASE_STATES.has(record.state);
}

function sanitizedError(error: unknown): { code: string; message: string } {
	const code =
		error instanceof PublicReleaseHostFatalError
			? error.code
			: error instanceof Error && error.name === 'AbortError'
				? 'timeout'
				: 'host_error';
	const message =
		error instanceof PublicReleaseHostFatalError
			? error.message.slice(0, 300)
			: code === 'timeout'
				? 'The publishing operation timed out'
				: 'The publishing service could not complete the operation';
	return { code, message };
}

/** PEP 723 inline dependencies, or an empty list when the notebook declares none. */
function inlineScriptDependencies(code: string): string[] {
	const lines = code.split(/\r?\n/);
	const start = lines.indexOf('# /// script');
	if (start === -1) return [];
	const end = lines.findIndex((line, index) => index > start && line === '# ///');
	if (end === -1) throw new ValidationError('The notebook has an unterminated script block');
	const body = lines
		.slice(start + 1, end)
		.map((line) => line.replace(/^# ?/, ''))
		.join('\n');
	return dependencyList(body, (table) => table.dependencies);
}

function dependencyList(toml: string, pick: (table: Record<string, unknown>) => unknown): string[] {
	let parsed: Record<string, unknown>;
	try {
		parsed = parseToml(toml) as Record<string, unknown>;
	} catch {
		throw new ValidationError('The notebook dependency metadata is not valid TOML');
	}
	const value = pick(parsed);
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
		throw new ValidationError('Notebook dependencies must be a list of requirement strings');
	return value as string[];
}

export async function assertPublicReleaseTarget(
	deps: {
		projects: PublicReleaseServiceDeps['projects'];
		notebooks: Pick<NotebookService, 'getNotebookMeta'>;
		catalog: PublicReleaseServiceDeps['catalog'];
	},
	target: DeepLinkTarget,
) {
	const [project, notebook, snapshot] = await Promise.all([
		deps.projects.getProject(target.project_id, { consistency: 'fresh' }),
		deps.notebooks.getNotebookMeta(target.project_id, target.notebook_id, { consistency: 'fresh' }),
		deps.catalog.getCurrentSnapshot(),
	]);
	if (project.status === 'deleted' || notebook.status === 'deleted')
		throw new NotFoundError('Notebook not found');
	const entry = snapshot.projects.find((p) => p.id === target.project_id);
	const notebookEntry = entry?.notebooks.find((n) => n.id === target.notebook_id);
	if (
		project.security_labels ||
		notebook.security_labels ||
		entry?.security_labels_pending ||
		notebookEntry?.security_labels_pending
	) {
		throw new ForbiddenError('Notebooks with security labels cannot be published publicly');
	}
}

/**
 * Owns the release records, registration heads and live release index.
 * Publishing freezes exact bytes, and a leased reconciler
 * deploys privately, exposes behind a CAS fence, and swaps the app link only after the
 * anonymous origin answers. Withdrawal clears the link first and is confirmed only once
 * the host reports the service gone and an anonymous probe is refused.
 */
export class PublicReleaseService {
	readonly host: PublicReleaseHost;
	readonly limits: PublicReleaseLimits;
	private readonly bucket: Bucket;
	private readonly deps: PublicReleaseServiceDeps;
	private readonly now: () => number;
	private readonly fenceMarginMs: number;
	private lastSweepAt = 0;
	private tickOffset = 0;

	constructor(deps: PublicReleaseServiceDeps) {
		this.deps = deps;
		this.bucket = deps.bucket;
		this.host = deps.host;
		this.limits = { ...DEFAULT_PUBLIC_RELEASE_LIMITS };
		for (const [key, value] of Object.entries(deps.limits ?? {}) as [
			keyof PublicReleaseLimits,
			number | undefined,
		][])
			if (value !== undefined) this.limits[key] = value;
		this.now = deps.now ?? Date.now;
		this.fenceMarginMs = deps.fenceMarginMs ?? 30_000;
	}

	// --- storage ------------------------------------------------------------

	async getRelease(releaseId: string): Promise<PublicReleaseRecord | null> {
		return (await this.read(releaseId))?.record ?? null;
	}

	/**
	 * The registration head selects the only managed release allowed to serve the app link.
	 * Undefined means no managed dashboard has activated, so the legacy setting still applies.
	 */
	async resolveManagedOrigin(
		link: Pick<DeepLink, 'registration_id' | 'target'>,
	): Promise<string | null | undefined> {
		const head = (await this.readHead(link.registration_id))?.head;
		if (!head?.active_release_id) return head?.managed_activated ? null : undefined;
		if (
			head.withdrawing_release_id === head.active_release_id ||
			!sameTarget(head.target, link.target)
		)
			return null;
		const release = await this.getRelease(head.active_release_id);
		if (
			release?.registration_id !== link.registration_id ||
			!sameTarget(release.target, link.target) ||
			release.withdraw_requested ||
			release.state !== 'active' ||
			release.origin !==
				deriveDeterministicOrigin(
					publicReleaseServiceName(release.release_id),
					this.host.hostSuffix,
				)
		)
			return null;
		return release.origin;
	}

	async resolvePublicOrigin(
		link: Pick<DeepLink, 'registration_id' | 'target'>,
		legacyOrigin: string | null | undefined,
	): Promise<string | null> {
		const managedOrigin = await this.resolveManagedOrigin(link);
		const origin = managedOrigin === undefined ? legacyOrigin : managedOrigin;
		if (!origin) return null;
		// A stale pointer written by an older server cannot reactivate a managed release.
		if (managedOrigin === undefined && isManagedPublicReleaseOrigin(origin, this.host.hostSuffix))
			return null;
		try {
			await assertPublicReleaseTarget(this.deps, link.target);
		} catch (error) {
			if (error instanceof ForbiddenError || error instanceof NotFoundError) return null;
			throw error;
		}
		return origin;
	}

	private async read(releaseId: string): Promise<Stored | null> {
		const key = paths.publicRelease(releaseId);
		const object = await this.bucket.get(key);
		if (!object) return null;
		return { record: await readStored(PublicReleaseRecordSchema, object, key), etag: object.etag };
	}

	/** CAS-replace a release; null when another writer changed it first. */
	private async write(current: Stored, next: PublicReleaseRecord): Promise<Step> {
		const record = { ...next, updated_at: new Date(this.now()).toISOString() };
		try {
			const object = await this.bucket.put(
				paths.publicRelease(record.release_id),
				JSON.stringify(record),
				{ onlyIfEtagMatches: current.etag },
			);
			return { record, etag: object.etag };
		} catch (error) {
			if (error instanceof PreconditionFailedError) return null;
			throw error;
		}
	}

	private async readHead(registrationId: string) {
		const key = paths.publicReleaseHead(registrationId);
		const object = await this.bucket.get(key);
		if (!object) return null;
		return { head: await readStored(PublicReleaseHeadSchema, object, key), etag: object.etag };
	}

	/** Retried read-modify-write of a head; `mutate` returning null leaves it unchanged. */
	private async updateHead(
		registrationId: string,
		seed: () => PublicReleaseHead,
		mutate: (head: PublicReleaseHead) => PublicReleaseHead | null,
	): Promise<PublicReleaseHead | null> {
		for (let attempt = 0; attempt < 8; attempt++) {
			const current = await this.readHead(registrationId);
			const next = mutate(current?.head ?? seed());
			if (!next) return current?.head ?? null;
			try {
				await this.bucket.put(
					paths.publicReleaseHead(registrationId),
					JSON.stringify({ ...next, updated_at: new Date(this.now()).toISOString() }),
					current ? { onlyIfEtagMatches: current.etag } : { onlyIfNotExists: true },
				);
				return next;
			} catch (error) {
				if (!(error instanceof PreconditionFailedError)) throw error;
			}
		}
		throw new ConflictError('Public release state changed concurrently; try again');
	}

	private async readLiveIndex(): Promise<{ ids: string[]; etag?: string }> {
		const key = paths.publicReleaseLiveIndex;
		const object = await this.bucket.get(key);
		if (!object) return { ids: [], etag: undefined };
		const index = await readStored(PublicReleaseLiveIndexSchema, object, key);
		return { ids: index.release_ids, etag: object.etag };
	}

	private async assertPublishCapacity(ids: readonly string[]): Promise<void> {
		if (ids.length < this.limits.maxLiveReleases) return;
		// Terminal releases may still be indexed for stale pointer cleanup, but their
		// Cloud Run services are gone (or never created). Only reserve capacity for live work.
		const records = await mapWithConcurrency(ids, 8, (id) => this.getRelease(id));
		if (
			records.filter((record) => !record || !isTerminal(record)).length >=
			this.limits.maxLiveReleases
		)
			throw new ConflictError('The public release limit for this hub has been reached');
	}

	/** The index both reserves concurrency-limited capacity and makes releases discoverable. */
	private async updateLiveIndex(releaseId: string, add: boolean): Promise<void> {
		for (let attempt = 0; attempt < 8; attempt++) {
			const { ids, etag } = await this.readLiveIndex();
			if (ids.includes(releaseId) === add) return;
			if (add) await this.assertPublishCapacity(ids);
			try {
				await this.bucket.put(
					paths.publicReleaseLiveIndex,
					JSON.stringify({
						schema_version: 1,
						release_ids: add ? [...ids, releaseId] : ids.filter((id) => id !== releaseId),
					}),
					etag ? { onlyIfEtagMatches: etag } : { onlyIfNotExists: true },
				);
				return;
			} catch (error) {
				if (!(error instanceof PreconditionFailedError)) throw error;
			}
		}
		throw new ConflictError('Public release capacity changed concurrently; try again');
	}

	private async liveReleases(skipUnreadable = false): Promise<PublicReleaseRecord[]> {
		const { ids } = await this.readLiveIndex();
		const records = await mapWithConcurrency(ids, 8, async (id) => {
			try {
				return await this.getRelease(id);
			} catch (error) {
				if (!skipUnreadable) throw error;
				logOperationalError('public_release_list_read_failed', { release_id: id }, error);
				return null;
			}
		});
		return records.filter(
			(record): record is PublicReleaseRecord => record !== null && !isTerminal(record),
		);
	}

	private async readBundle(releaseId: string): Promise<PublicReleaseBundleFile[]> {
		const prefix = paths.publicReleaseBundlePrefix(releaseId);
		const objects = await listAllObjects(this.bucket, prefix);
		if (objects.length === 0)
			throw new PublicReleaseHostFatalError('bundle_missing', 'Bundle missing');
		return mapWithConcurrency(objects, 4, async ({ key }) => {
			const object = await this.bucket.get(key);
			if (!object) throw new PublicReleaseHostFatalError('bundle_missing', 'Bundle missing');
			const bytes = await object.bytes();
			return { path: key.slice(prefix.length), bytes, sha256: await sha256Hex(bytes) };
		});
	}

	private async deleteBundle(releaseId: string): Promise<void> {
		const keys = await listAllKeys(this.bucket, paths.publicReleaseBundlePrefix(releaseId));
		if (keys.length > 0) await this.bucket.delete(keys);
	}

	private async event(
		name: string,
		record: PublicReleaseRecord,
		actor: UserId = SYSTEM_ACTOR,
		extra: Record<string, unknown> = {},
	): Promise<void> {
		try {
			await this.deps.events.append(
				{
					event: `public_release.${name}`,
					actor,
					project_id: record.target.project_id,
					notebook_id: record.target.notebook_id,
					release_id: record.release_id,
					slug: record.slug,
					...extra,
				},
				{ id: `public-release-${record.release_id}-${name}`, onlyIfAbsent: true },
			);
		} catch (error) {
			logOperationalError('public_release_event_failed', { release_id: record.release_id }, error);
		}
	}

	// --- reads for the API --------------------------------------------------

	async listForNotebook(
		projectId: ProjectId,
		notebookId: NotebookId,
	): Promise<PublicAppLinkReleases[]> {
		const target: DeepLinkTarget = { kind: 'app', project_id: projectId, notebook_id: notebookId };
		const [links, live] = await Promise.all([
			this.deps.deepLinks.list(target),
			this.liveReleases(true),
		]);
		return mapWithConcurrency(links, 4, async (link) => {
			const head = (await this.readHead(link.registration_id))?.head;
			const ids = new Set(
				[head?.pending_release_id, head?.active_release_id, head?.last_release_id].filter(
					(id): id is string => typeof id === 'string',
				),
			);
			const headRecords = await mapWithConcurrency([...ids], 4, (id) => this.getRelease(id));
			const incidental = live.filter(
				(record) => record.registration_id === link.registration_id && !ids.has(record.release_id),
			);
			const releases = [...headRecords, ...incidental]
				.filter(
					(record): record is PublicReleaseRecord =>
						record !== null && sameTarget(record.target, target),
				)
				.sort((a, b) => b.release_id.localeCompare(a.release_id));
			return {
				registration_id: link.registration_id,
				slug: link.slug,
				active_release_id: head?.active_release_id ?? null,
				pending_release_id: head?.pending_release_id ?? null,
				releases,
			};
		});
	}

	async hasNonTerminalForNotebook(projectId: ProjectId, notebookId: NotebookId): Promise<boolean> {
		return (await this.liveReleases()).some(
			(record) =>
				record.target.project_id === projectId && record.target.notebook_id === notebookId,
		);
	}

	async hasNonTerminalForRegistration(registrationId: string): Promise<boolean> {
		return (await this.liveReleases()).some((record) => record.registration_id === registrationId);
	}

	// --- publish ------------------------------------------------------------

	private async sourceLayout(projectId: ProjectId, notebookId: NotebookId, versionId: string) {
		if (!VersionId.is(versionId)) throw new NotFoundError(`Version ${versionId} not found`);
		await assertPublicReleaseTarget(this.deps, {
			kind: 'app',
			project_id: projectId,
			notebook_id: notebookId,
		});
		const source = await this.deps.notebooks.getNotebookSource(projectId, notebookId);
		const nb = paths.project(projectId).notebook(notebookId);
		const version = nb.version(versionId);
		const synced = remoteWorkspaceEntry(source);
		const entrypoint = synced ?? workspaceSourcePolicy(source).entryNotebook;
		if (!isArchiveableReleasePath(entrypoint))
			throw new ValidationError('The notebook path is too long for public publishing');
		const codeKey = synced ? version.workspaceFile(synced) : version.code;
		const code = await this.bucket.head(codeKey);
		if (!code) throw new NotFoundError(`Version ${versionId} not found`);
		if (code.size > MAX_NOTEBOOK_BYTES)
			throw new ValidationError('The saved notebook exceeds the 10 MiB publishing limit');
		// Validates the saved version, including the local publication's committed version list.
		await this.deps.notebooks.getVersion(projectId, notebookId, versionId);
		return {
			versionId,
			entrypoint,
			codeKey,
			depsKey: synced ? version.workspaceFile('pyproject.toml') : version.deps,
			// Synced notebooks pin assets to the version; local notebooks only have the live mirror.
			assetPrefix: synced ? version.workspacePrefix : nb.workspacePrefix,
		};
	}

	async listAssetCandidates(projectId: ProjectId, notebookId: NotebookId, versionId: string) {
		const layout = await this.sourceLayout(projectId, notebookId, versionId);
		const page = await this.bucket.list({ prefix: layout.assetPrefix, limit: MAX_PREVIEW_OBJECTS });
		let truncated = page.truncated;
		let remainingBytes = Math.max(this.limits.maxAssetBytes, this.limits.maxTotalAssetBytes);
		const candidates = page.objects
			.map((object) => ({ ...object, path: object.key.slice(layout.assetPrefix.length) }))
			.filter(
				(object) =>
					!isWorkspaceDirectoryMarkerPath(object.path) &&
					isEligibleAssetPath(object.path, layout.entrypoint),
			)
			.sort((a, b) => a.path.localeCompare(b.path));
		const objects = candidates.slice(0, MAX_CANDIDATES).filter((object) => {
			if (object.size > this.limits.maxAssetBytes) return true; // The UI shows it disabled.
			if (object.size > remainingBytes) {
				truncated = true;
				return false;
			}
			remainingBytes -= object.size;
			return true;
		});
		truncated ||= candidates.length > MAX_CANDIDATES;

		const assets = await mapWithConcurrency(
			objects,
			4,
			async (object): Promise<PublicReleaseAssetCandidate | null> => {
				const exposure = deriveAssetExposure(object.path);
				if (object.size > this.limits.maxAssetBytes)
					return {
						path: object.path,
						size_bytes: object.size,
						sha256: null,
						exposure,
						selectable: false,
						reason: 'exceeds_max_file_bytes',
					};
				const body = await this.bucket.get(object.key);
				if (!body || body.size !== object.size) return null;
				const bytes = await body.bytes();
				return {
					path: object.path,
					size_bytes: bytes.byteLength,
					sha256: await sha256Hex(bytes),
					exposure,
					selectable: true,
				};
			},
		);
		return {
			version_id: layout.versionId,
			entrypoint: layout.entrypoint,
			assets: assets.filter((asset) => asset !== null),
			truncated: truncated || assets.includes(null),
		};
	}

	private async assertDependenciesInstalled(code: string, depsKey: string): Promise<void> {
		const installed = await this.host.getInstalledPackages?.();
		if (!installed) return;
		const depsObject = await this.bucket.get(depsKey);
		const requirements = [
			...(depsObject
				? dependencyList(await depsObject.text(), (table) => {
						const project = table.project;
						return project && typeof project === 'object'
							? (project as Record<string, unknown>).dependencies
							: undefined;
					})
				: []),
			...inlineScriptDependencies(code),
		];
		const missing = [
			...new Set(
				requirements
					.map(requirementName)
					.filter(
						(name): name is string => name !== null && !installed.has(normalizePackageName(name)),
					),
			),
		].sort();
		if (missing.length > 0)
			throw new ValidationError(
				`The public dashboard runtime does not include: ${missing.join(', ')}`,
			);
	}

	/**
	 * Freeze the chosen version and approved assets into an immutable bundle and queue a
	 * private deploy. Nothing reaches the host until the reconciler picks up the release.
	 */
	async publish(input: PublishPublicReleaseInput): Promise<PublicReleaseRecord> {
		const target: DeepLinkTarget = {
			kind: 'app',
			project_id: input.projectId,
			notebook_id: input.notebookId,
		};
		const link = await this.deps.deepLinks.resolve(input.slug);
		if (link.registration_id !== input.registrationId || !sameTarget(link.target, target))
			throw new NotFoundError('App link not found');
		const layout = await this.sourceLayout(input.projectId, input.notebookId, input.versionId);

		if (input.assets.length > this.limits.maxAssets)
			throw new ValidationError(`Select at most ${this.limits.maxAssets} files`);
		const seen = new Set<string>();
		let total = 0;
		for (const asset of input.assets) {
			const path = normalizeApprovedAssetPath(asset.path, layout.entrypoint);
			if (seen.has(path)) throw new ValidationError(`Asset ${path} is listed twice`);
			seen.add(path);
			if (asset.size_bytes > this.limits.maxAssetBytes)
				throw new ValidationError(`Asset ${path} exceeds the per-file limit`);
			total += asset.size_bytes;
		}
		if (total > this.limits.maxTotalAssetBytes)
			throw new ValidationError('Selected files exceed the total size limit');
		await this.assertPublishCapacity((await this.readLiveIndex()).ids);

		const codeObject = await this.bucket.get(layout.codeKey);
		if (!codeObject) throw new NotFoundError(`Version ${input.versionId} not found`);
		if (codeObject.size > MAX_NOTEBOOK_BYTES)
			throw new ValidationError('The saved notebook exceeds the 10 MiB publishing limit');
		const code = await codeObject.bytes();
		await this.assertDependenciesInstalled(new TextDecoder().decode(code), layout.depsKey);

		const releaseId = ulid(this.now());
		const files: { path: string; bytes: Uint8Array; sha256: string }[] = [
			{ path: layout.entrypoint, bytes: code, sha256: await sha256Hex(code) },
		];
		const assets: PublicReleaseAsset[] = [];
		for (const asset of input.assets) {
			const object = await this.bucket.get(`${layout.assetPrefix}${asset.path}`);
			const bytes = object?.size === asset.size_bytes ? await object.bytes() : null;
			if (
				!bytes ||
				bytes.byteLength !== asset.size_bytes ||
				(await sha256Hex(bytes)) !== asset.sha256
			)
				throw new ConflictError(
					`Asset ${asset.path} changed since preview; refresh and re-approve`,
				);
			files.push({ path: asset.path, bytes, sha256: asset.sha256 });
			assets.push({ ...asset, exposure: deriveAssetExposure(asset.path) });
		}
		const manifest: PublicReleaseManifest = {
			schema_version: 1,
			release_id: releaseId,
			entrypoint: layout.entrypoint,
			files: files.map((file) => ({
				path: file.path,
				sha256: file.sha256,
				size_bytes: file.bytes.byteLength,
			})),
		};
		const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
		files.push({
			path: 'release.json',
			bytes: manifestBytes,
			sha256: await sha256Hex(manifestBytes),
		});
		const serviceName = publicReleaseServiceName(releaseId);
		const now = this.now();
		const iso = new Date(now).toISOString();
		const record: PublicReleaseRecord = {
			schema_version: 1,
			release_id: releaseId,
			slug: link.slug,
			registration_id: link.registration_id,
			target,
			version_id: layout.versionId,
			entrypoint: layout.entrypoint,
			code_sha256: files[0].sha256,
			assets,
			service_name: serviceName,
			origin: deriveDeterministicOrigin(serviceName, this.host.hostSuffix),
			state: 'publishing',
			staging: true,
			withdraw_requested: false,
			attempt: 0,
			deadline_at: now + PUBLISH_DEADLINE_MS,
			created_by: input.actor,
			created_at: iso,
			updated_at: iso,
		};
		await this.bucket.put(paths.publicRelease(releaseId), JSON.stringify(record), {
			onlyIfNotExists: true,
		});

		const staleCandidates: string[] = [];
		let assigningHead = false;
		try {
			await this.updateLiveIndex(releaseId, true);
			const failures = await mapWithConcurrency(files, 4, async (file) => {
				try {
					await this.bucket.put(paths.publicReleaseBundleFile(releaseId, file.path), file.bytes);
					return null;
				} catch (error) {
					return { error };
				}
			});
			const failure = failures.find((result) => result !== null);
			if (failure) throw failure.error;

			const current = await this.read(releaseId);
			if (!current?.record.staging || current.record.withdraw_requested)
				throw new ConflictError('Publishing stopped before the files were saved');
			const ready = await this.write(current, { ...current.record, staging: undefined });
			if (!ready) throw new ConflictError('Public release changed concurrently; try again');

			const pending = (await this.readHead(link.registration_id))?.head.pending_release_id;
			if (pending && (await this.isStalePending(pending))) staleCandidates.push(pending);
			assigningHead = true;
			await this.updateHead(
				link.registration_id,
				() => this.emptyHead(record),
				(head) => {
					if (head.withdrawing_release_id)
						throw new ConflictError('Unpublishing is already in progress for this link');
					if (head.pending_release_id && !staleCandidates.includes(head.pending_release_id))
						throw new ConflictError('A publish or unpublish is already in progress for this link');
					return { ...head, slug: link.slug, target, pending_release_id: releaseId };
				},
			);
			for (const stale of staleCandidates) await this.abandon(stale);
			await this.event('publish_requested', ready.record, input.actor, {
				version_id: input.versionId,
			});
			return ready.record;
		} catch (error) {
			if (!assigningHead || error instanceof ConflictError) {
				await this.abandon(releaseId);
				await this.updateLiveIndex(releaseId, false);
			} else {
				// The head update might have committed. Reconcile withdrawal before freeing the slot.
				await this.requestUnpublish(releaseId, 'publish_failed');
			}
			throw error;
		}
	}

	/** Legacy pending records without a reservation never reached the reconciler. */
	private async isStalePending(releaseId: string): Promise<boolean> {
		const current = await this.read(releaseId);
		if (!current || isTerminal(current.record)) return true;
		if ((await this.readLiveIndex()).ids.includes(releaseId)) return false;
		return this.now() - Date.parse(current.record.created_at) > 60_000;
	}

	private async abandon(releaseId: string): Promise<void> {
		const current = await this.read(releaseId);
		if (current && !isTerminal(current.record))
			await this.write(current, {
				...current.record,
				state: 'failed',
				withdraw_requested: true,
				withdraw_reason: 'publish_failed',
				error: { code: 'abandoned', message: 'Publishing did not start' },
			});
		await this.deleteBundle(releaseId);
	}

	// --- withdrawal ---------------------------------------------------------

	/**
	 * Stop a release. The app link redirect is cleared before returning; the reconciler then
	 * revokes the service. An in-flight cloud call holding the lease extends the fence.
	 */
	async requestUnpublish(
		releaseId: string,
		reason: PublicReleaseWithdrawReason,
		actor: UserId = SYSTEM_ACTOR,
	): Promise<PublicReleaseRecord> {
		for (let attempt = 0; attempt < 8; attempt++) {
			const current = await this.read(releaseId);
			if (!current) throw new NotFoundError('Public release not found');
			const { record } = current;
			if (isTerminal(record) || record.state === 'unpublishing') {
				if (reason === 'user' && record.activated_at) {
					const head = (await this.readHead(record.registration_id))?.head;
					if (
						(head?.pending_release_id || head?.active_release_id) &&
						head.active_release_id !== releaseId &&
						head.pending_release_id !== releaseId
					)
						throw new ConflictError('The dashboard has changed; refresh before unpublishing');
				}
				return record;
			}
			if (reason !== 'republish_superseded') {
				await this.updateHead(
					record.registration_id,
					() => this.emptyHead(record),
					(head) => {
						const isActive = head.active_release_id === releaseId;
						const isPending = head.pending_release_id === releaseId;
						if (reason === 'user' && !isActive && !isPending)
							throw new ConflictError('The dashboard has changed; refresh before unpublishing');
						if (
							reason === 'user' &&
							isActive &&
							head.pending_release_id &&
							head.cancelling_release_id !== head.pending_release_id &&
							head.withdrawing_release_id !== head.pending_release_id
						)
							throw new ConflictError('Cancel the replacement before unpublishing this dashboard');
						if (isActive)
							return {
								...head,
								managed_activated: true,
								withdrawing_release_id: releaseId,
								// Preserve the cancellation fence written by older workers.
								cancelling_release_id:
									head.withdrawing_release_id === head.pending_release_id
										? head.withdrawing_release_id
										: head.cancelling_release_id,
							};
						return isPending && head.cancelling_release_id !== releaseId
							? { ...head, cancelling_release_id: releaseId }
							: null;
					},
				);
			}
			const now = this.now();
			// A lease means a worker may still have a cloud call in flight, even past expiry.
			const fence = record.lease ? Math.max(record.lease.until, now) + this.fenceMarginMs : now;
			const next = await this.write(current, {
				...record,
				state: 'unpublishing',
				withdraw_requested: true,
				withdraw_reason: reason,
				unpublish_requested_at: new Date(now).toISOString(),
				fenced_until: Math.max(
					record.fenced_until ?? 0,
					record.staging ? record.deadline_at + this.fenceMarginMs : fence,
				),
				lease: undefined,
				next_retry_at: undefined,
			});
			if (!next) continue;
			await this.event('unpublish_requested', next.record, actor, { reason });
			return next.record;
		}
		throw new ConflictError('Public release changed concurrently; try again');
	}

	private async clearLink(record: PublicReleaseRecord): Promise<void> {
		await this.deps.deepLinks.clearPublicOrigin(
			record.slug,
			record.target,
			record.registration_id,
			record.origin,
		);
	}

	/** Withdraw every non-terminal release for a project, or one notebook in it. */
	async withdrawTarget(
		target: { projectId: ProjectId; notebookId?: NotebookId },
		reason: PublicReleaseWithdrawReason,
		actor: UserId = SYSTEM_ACTOR,
	): Promise<number> {
		const { ids } = await this.readLiveIndex();
		const withdrawn = await mapWithConcurrency(ids, RECONCILE_CONCURRENCY, async (id) => {
			try {
				const record = await this.getRelease(id);
				if (
					!record ||
					isTerminal(record) ||
					record.target.project_id !== target.projectId ||
					(target.notebookId !== undefined && record.target.notebook_id !== target.notebookId)
				)
					return false;
				await this.requestUnpublish(id, reason, actor);
				return true;
			} catch (error) {
				logOperationalError('public_release_target_withdraw_failed', { release_id: id }, error);
				return false;
			}
		});
		return withdrawn.filter(Boolean).length;
	}

	// --- reconciliation -----------------------------------------------------

	async shouldRun(): Promise<boolean> {
		if (this.now() - this.lastSweepAt >= SWEEP_INTERVAL_MS) return true;
		return (await this.readLiveIndex()).ids.length > 0;
	}

	/** Run withdrawals first; rotate the order so later releases get time in each budget. */
	async reconcileTick(holder: string, signal?: AbortSignal): Promise<void> {
		const { ids } = await this.readLiveIndex();
		const offset = ids.length > 0 ? this.tickOffset++ % ids.length : 0;
		const ordered = [...ids.slice(offset), ...ids.slice(0, offset)];
		const states = await mapWithConcurrency(ordered, RECONCILE_CONCURRENCY, async (id) => {
			if (signal?.aborted) return null;
			try {
				return { id, state: (await this.getRelease(id))?.state };
			} catch (error) {
				if (!signal?.aborted)
					logOperationalError('public_release_reconcile_read_failed', { release_id: id }, error);
				return null;
			}
		});
		signal?.throwIfAborted();
		const entries = states.filter((entry) => entry !== null);
		for (const withdrawals of [true, false]) {
			await mapWithConcurrency(
				entries.filter(({ state }) => (state === 'unpublishing') === withdrawals),
				RECONCILE_CONCURRENCY,
				async ({ id }) => {
					if (signal?.aborted) return;
					try {
						if (!(await this.advance(id, holder, signal))) await this.updateLiveIndex(id, false);
					} catch (error) {
						if (!signal?.aborted)
							logOperationalError('public_release_reconcile_failed', { release_id: id }, error);
					}
				},
			);
			signal?.throwIfAborted();
		}
		if (this.now() - this.lastSweepAt >= SWEEP_INTERVAL_MS) {
			await this.sweepHost(signal);
			this.lastSweepAt = this.now();
		}
	}

	private async sweepHost(signal?: AbortSignal): Promise<void> {
		const services = await this.host.listManagedServices(signal);
		await mapWithConcurrency(services, RECONCILE_CONCURRENCY, async (service) => {
			if (signal?.aborted) return;
			try {
				const releaseId = service.releaseId?.toUpperCase();
				const record = releaseId ? await this.getRelease(releaseId) : null;
				if (!record || isTerminal(record)) {
					logEvent({
						level: 'warn',
						event: 'public_release_orphan_service',
						service_name: service.serviceName,
						public_invoker: service.publicInvoker,
					});
					await this.host.revoke({
						releaseId: releaseId ?? '',
						serviceName: service.serviceName,
						signal,
					});
				} else if (service.publicInvoker && record.state === 'publishing') {
					logEvent({
						level: 'error',
						event: 'public_release_unexpected_public_invoker',
						service_name: service.serviceName,
						release_id: record.release_id,
						state: record.state,
					});
					await this.requestUnpublish(record.release_id, 'publish_failed');
				}
			} catch (error) {
				if (!signal?.aborted)
					logOperationalError(
						'public_release_sweep_failed',
						{ service_name: service.serviceName },
						error,
					);
			}
		});
		signal?.throwIfAborted();
	}

	/**
	 * Run up to a few state transitions for one release under a CAS lease. Every write is
	 * conditional on the record ETag, so a withdrawal or another worker stops this one.
	 */
	async advance(
		releaseId: string,
		holder: string,
		signal?: AbortSignal,
	): Promise<PublicReleaseRecord | null> {
		signal?.throwIfAborted();
		let current = await this.read(releaseId);
		if (!current) return null;
		if (isTerminal(current.record)) {
			await this.finishTerminal(current.record, signal);
			return current.record;
		}
		// Active checks make no host calls and every write is ETag-guarded, so they skip the
		// lease and avoid two writes per tick for each live dashboard.
		if (current.record.state === 'active') {
			await this.stepActive(current);
			current = await this.read(releaseId);
			if (current?.record.state !== 'unpublishing') return current?.record ?? null;
		}
		const now = this.now();
		const { lease, next_retry_at, staging, state, deadline_at } = current.record;
		if (staging && state === 'publishing' && now <= deadline_at) return current.record;
		if (lease && lease.until > now) return current.record;
		if (next_retry_at && next_retry_at > now) return current.record;
		const token = ulid();
		const until = now + LEASE_MS;
		const leased = await this.write(current, {
			...current.record,
			lease: { owner: holder, token, until },
		});
		if (!leased) return (await this.read(releaseId))?.record ?? null;
		current = leased;
		const leaseSignal = AbortSignal.timeout(until - now);
		const stepSignal = signal ? AbortSignal.any([signal, leaseSignal]) : leaseSignal;
		let steps = 0;
		try {
			let next: Step = current;
			while (next && steps < MAX_STEPS_PER_ADVANCE) {
				stepSignal.throwIfAborted();
				current = next;
				steps++;
				next = await this.step(current, stepSignal);
			}
			if (next) current = next;
		} catch (error) {
			// Preserve the lease on cancellation so withdrawal still fences any late host writes.
			signal?.throwIfAborted();
			return this.recordFailure(releaseId, token, error);
		}
		const latest = await this.read(releaseId);
		if (latest?.record.lease?.token === token) {
			const released = await this.write(latest, { ...latest.record, lease: undefined });
			return released?.record ?? latest.record;
		}
		return latest?.record ?? null;
	}

	private step(current: Stored, signal: AbortSignal): Promise<Step> {
		switch (current.record.state) {
			case 'publishing':
				return this.stepPublishing(current, signal);
			case 'exposing':
				return this.stepExposing(current, signal);
			case 'active':
				return this.stepActive(current);
			case 'unpublishing':
				return this.stepUnpublishing(current, signal);
			case 'unpublished':
			case 'failed':
				return Promise.resolve(null);
		}
	}

	private async recordFailure(releaseId: string, token: string, error: unknown) {
		const current = await this.read(releaseId);
		if (!current || current.record.lease?.token !== token) return current?.record ?? null;
		const { record } = current;
		const fatal = error instanceof PublicReleaseHostFatalError;
		const expired = this.now() > record.deadline_at;
		if ((fatal || expired) && (record.state === 'publishing' || record.state === 'exposing')) {
			const withdrawn = await this.withdrawFromStep(
				current,
				'publish_failed',
				sanitizedError(error),
			);
			if (!withdrawn) return record;
			await this.event('publish_failed', withdrawn.record);
			return (
				(await this.write(withdrawn, { ...withdrawn.record, lease: undefined }))?.record ??
				withdrawn.record
			);
		}
		const attempt = record.attempt + 1;
		const maxBackoff = record.state === 'unpublishing' ? 30_000 : MAX_BACKOFF_MS;
		const delay = Math.min(POLL_MS * 2 ** Math.min(attempt, 6), maxBackoff);
		logOperationalError(
			'public_release_step_failed',
			{ release_id: releaseId, state: record.state, attempt },
			error,
		);
		const next = await this.write(current, {
			...record,
			attempt,
			next_retry_at: this.now() + delay,
			error: sanitizedError(error),
			lease: undefined,
		});
		return next?.record ?? record;
	}

	/** Withdraw from inside a leased step; nothing of ours is in flight, only the margin applies. */
	private async withdrawFromStep(
		current: Stored,
		reason: PublicReleaseWithdrawReason,
		error?: { code: string; message: string },
	): Promise<Step> {
		const { record } = current;
		await this.updateHead(
			record.registration_id,
			() => this.emptyHead(record),
			(head) =>
				head.pending_release_id === record.release_id &&
				head.cancelling_release_id !== record.release_id
					? { ...head, cancelling_release_id: record.release_id }
					: null,
		);
		const now = this.now();
		return this.write(current, {
			...current.record,
			state: 'unpublishing',
			withdraw_requested: true,
			withdraw_reason: current.record.withdraw_reason ?? reason,
			unpublish_requested_at: new Date(now).toISOString(),
			fenced_until: Math.max(current.record.fenced_until ?? 0, now + this.fenceMarginMs),
			next_retry_at: undefined,
			...(error ? { error } : {}),
		});
	}

	/** Why a release must be withdrawn, or null while its link, target and labels still allow it. */
	private async invalidation(
		record: PublicReleaseRecord,
	): Promise<PublicReleaseWithdrawReason | null> {
		try {
			await assertPublicReleaseTarget(this.deps, record.target);
		} catch (error) {
			if (error instanceof ForbiddenError) return 'security_labeled';
			if (error instanceof NotFoundError) return 'target_deleted';
			throw error;
		}
		let link;
		try {
			link = await this.deps.deepLinks.resolve(record.slug);
		} catch (error) {
			if (error instanceof NotFoundError) return 'link_changed';
			throw error;
		}
		if (link.registration_id !== record.registration_id || !sameTarget(link.target, record.target))
			return 'link_changed';
		return null;
	}

	private async guardPublishing(current: Stored): Promise<Step | 'ok'> {
		if (this.now() > current.record.deadline_at) {
			const next = await this.withdrawFromStep(current, 'publish_failed', {
				code: 'deadline_exceeded',
				message: 'The release did not become ready in time',
			});
			if (next) await this.event('publish_failed', next.record);
			return next;
		}
		const { record } = current;
		const head = (await this.readHead(record.registration_id))?.head;
		if (
			head?.withdrawing_release_id === record.release_id ||
			head?.cancelling_release_id === record.release_id
		)
			return this.withdrawFromStep(current, 'user');
		if (record.staging || head?.pending_release_id !== record.release_id) return null;
		const reason = await this.invalidation(record);
		return reason ? this.withdrawFromStep(current, reason) : 'ok';
	}

	private async stepPublishing(current: Stored, signal: AbortSignal): Promise<Step> {
		const guard = await this.guardPublishing(current);
		if (guard !== 'ok') return guard;
		const { record } = current;
		const result = await this.host.deployPrivate({
			releaseId: record.release_id,
			serviceName: record.service_name,
			origin: record.origin,
			entrypoint: record.entrypoint,
			files: () => this.readBundle(record.release_id),
			imageDigest: record.image_digest,
			buildId: record.build_id,
			signal,
		});
		if (result.status === 'in_progress') {
			await this.write(current, {
				...record,
				image_digest: result.imageDigest ?? record.image_digest,
				build_id: result.buildId ?? record.build_id,
				next_retry_at: this.now() + POLL_MS,
				error: undefined,
			});
			return null;
		}
		// The exposure fence: only a writer whose ETag still matches may move to `exposing`.
		return this.write(current, {
			...record,
			state: 'exposing',
			image_digest: result.imageDigest,
			build_id: result.buildId ?? record.build_id,
			attempt: 0,
			error: undefined,
		});
	}

	private async stepExposing(current: Stored, signal: AbortSignal): Promise<Step> {
		const guard = await this.guardPublishing(current);
		if (guard !== 'ok') return guard;
		const { record } = current;
		await this.host.expose({
			releaseId: record.release_id,
			serviceName: record.service_name,
			origin: record.origin,
			signal,
		});
		const after = await this.read(record.release_id);
		if (!after || after.etag !== current.etag) return null;
		const reason = await this.invalidation(record);
		if (reason) return this.withdrawFromStep(after, reason);
		const iso = new Date(this.now()).toISOString();
		return this.write(after, {
			...record,
			state: 'active',
			exposed_at: record.exposed_at ?? iso,
			activated_at: iso,
			attempt: 0,
			error: undefined,
		});
	}

	private async stepActive(current: Stored): Promise<Step> {
		const { record } = current;
		const reason = await this.invalidation(record);
		if (reason) return this.withdrawFromStep(current, reason);

		let previous: string | null = null;
		let activated = false;
		const result = await this.updateHead(
			record.registration_id,
			() => this.emptyHead(record),
			(head) => {
				previous = null;
				activated = false;
				if (
					head.pending_release_id !== record.release_id ||
					head.withdrawing_release_id ||
					head.cancelling_release_id === record.release_id
				)
					return null;
				previous = head.active_release_id;
				activated = true;
				return {
					...head,
					managed_activated: true,
					active_release_id: record.release_id,
					pending_release_id: null,
					last_release_id: previous ?? head.last_release_id,
				};
			},
		);
		if (
			result?.withdrawing_release_id === record.release_id ||
			result?.cancelling_release_id === record.release_id
		) {
			await this.requestUnpublish(record.release_id, 'user');
			return null;
		}
		if (result?.active_release_id !== record.release_id) {
			await this.requestUnpublish(record.release_id, 'republish_superseded');
			return null;
		}
		if (activated) await this.event('published', record);
		if (previous) await this.requestUnpublish(previous, 'republish_superseded');
		if (!record.bundle_cleaned) {
			await this.deleteBundle(record.release_id);
			await this.write(current, { ...record, bundle_cleaned: true });
		}
		return null;
	}

	private emptyHead(record: PublicReleaseRecord): PublicReleaseHead {
		return {
			schema_version: 1,
			registration_id: record.registration_id,
			slug: record.slug,
			target: record.target,
			active_release_id: null,
			pending_release_id: null,
			last_release_id: null,
			updated_at: record.updated_at,
		};
	}

	private async stepUnpublishing(current: Stored, signal: AbortSignal): Promise<Step> {
		const { record } = current;
		const revoked = await this.host.revoke({
			releaseId: record.release_id,
			serviceName: record.service_name,
			signal,
		});
		const now = this.now();
		const retryAt = Math.max(now + POLL_MS, record.fenced_until ?? 0);
		const confirmed =
			revoked === 'absent' &&
			now >= (record.fenced_until ?? 0) &&
			(await this.confirmRevoked(record, signal));
		if (!confirmed) {
			await this.write(current, { ...record, next_retry_at: retryAt });
			return null;
		}
		const terminal = await this.write(current, {
			...record,
			state: record.activated_at ? 'unpublished' : 'failed',
			unpublished_at: new Date(now).toISOString(),
			lease: undefined,
			next_retry_at: undefined,
		});
		if (!terminal) return null;
		await this.event(
			terminal.record.activated_at ? 'unpublished' : 'publish_failed',
			terminal.record,
		);
		await this.finishTerminal(terminal.record, signal);
		return null;
	}

	private async confirmRevoked(record: PublicReleaseRecord, signal: AbortSignal): Promise<boolean> {
		const inspection = await this.host.inspect(record.service_name, signal);
		if (inspection.state !== 'absent' || inspection.publicInvoker) return false;
		const probe = await this.host.probeAnonymous(record.origin, signal);
		return 'status' in probe && (probe.status === 403 || probe.status === 404);
	}

	/** Idempotent cleanup after a terminal transition; safe to repeat after a crash. */
	private async finishTerminal(record: PublicReleaseRecord, signal?: AbortSignal): Promise<void> {
		await this.updateHead(
			record.registration_id,
			() => this.emptyHead(record),
			(head) =>
				head.active_release_id !== record.release_id &&
				head.pending_release_id !== record.release_id &&
				head.withdrawing_release_id !== record.release_id &&
				head.cancelling_release_id !== record.release_id &&
				head.last_release_id === record.release_id
					? null
					: {
							...head,
							active_release_id:
								head.active_release_id === record.release_id ? null : head.active_release_id,
							pending_release_id:
								head.pending_release_id === record.release_id ? null : head.pending_release_id,
							withdrawing_release_id:
								head.withdrawing_release_id === record.release_id
									? undefined
									: head.withdrawing_release_id,
							cancelling_release_id:
								head.cancelling_release_id === record.release_id
									? undefined
									: head.cancelling_release_id,
							last_release_id: record.release_id,
						},
		);
		await this.deleteBundle(record.release_id);
		if (record.unpublished_at && this.host.markImageRetired) {
			try {
				await this.host.markImageRetired(record.release_id, record.image_digest, signal);
			} catch (error) {
				signal?.throwIfAborted();
				// Release capacity even if registry retention needs operator attention.
				logOperationalError(
					'public_release_image_retirement_failed',
					{ release_id: record.release_id },
					error,
				);
			}
		}
		// A legacy pointer is cleanup only. Even a malformed link must not delay Cloud Run
		// revocation. Keeping the terminal record indexed makes this cleanup retryable.
		await this.clearLink(record);
		await this.updateLiveIndex(record.release_id, false);
	}
}
