import { z } from 'zod';
import { DeepLinkSlugSchema, DeepLinkTargetSchema, isApprovedPublicAppOrigin } from './deepLinks';
import { UserIdSchema, VersionIdSchema } from './schema';
import { ulidString, utcTimestamp } from './stringFormats';
import { ValidationError } from './errors';

export const PUBLIC_RELEASE_SERVICE_PREFIX = 'marimo-public-';
const ReleaseIdSchema = ulidString();
const SHA256 = /^[0-9a-f]{64}$/;
const PUBLIC_PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const MAX_ASSET_PATH_BYTES = 200;
const pathEncoder = new TextEncoder();

/** Reserve generated Cloud Run service names for the managed lifecycle. */
export function isManagedPublicReleaseOrigin(origin: string, hostSuffix: string): boolean {
	const prefix = `https://${PUBLIC_RELEASE_SERVICE_PREFIX}`;
	return (
		origin.startsWith(prefix) &&
		origin.endsWith(hostSuffix) &&
		ReleaseIdSchema.safeParse(origin.slice(prefix.length, -hostSuffix.length).toUpperCase()).success
	);
}

/** Split an archive path into the byte-limited name and prefix fields of a ustar header. */
export function splitReleaseTarPath(path: string): { name: string; prefix: string } | null {
	if (pathEncoder.encode(path).byteLength <= 100) return { name: path, prefix: '' };
	for (let i = path.indexOf('/'); i !== -1 && i < path.length - 1; i = path.indexOf('/', i + 1)) {
		const prefix = path.slice(0, i);
		const name = path.slice(i + 1);
		if (pathEncoder.encode(prefix).byteLength <= 155 && pathEncoder.encode(name).byteLength <= 100)
			return { name, prefix };
	}
	return null;
}

/** The full path and each directory need their own archive headers under release/. */
export function isArchiveableReleasePath(path: string): boolean {
	const archivePath = `release/${path}`;
	for (let i = archivePath.indexOf('/'); i !== -1; i = archivePath.indexOf('/', i + 1)) {
		if (!splitReleaseTarPath(archivePath.slice(0, i + 1))) return false;
	}
	return splitReleaseTarPath(archivePath) !== null;
}

export const PublicReleaseStateSchema = z.enum([
	'publishing',
	'exposing',
	'active',
	'unpublishing',
	'unpublished',
	'failed',
]);
export type PublicReleaseState = z.infer<typeof PublicReleaseStateSchema>;
export const TERMINAL_PUBLIC_RELEASE_STATES: ReadonlySet<PublicReleaseState> = new Set([
	'unpublished',
	'failed',
]);

export const PublicReleaseWithdrawReasonSchema = z.enum([
	'user',
	'republish_superseded',
	'target_deleted',
	'security_labeled',
	'link_changed',
	'publish_failed',
]);
export type PublicReleaseWithdrawReason = z.infer<typeof PublicReleaseWithdrawReasonSchema>;

export const PublicReleaseAssetExposureSchema = z.enum(['public_http', 'runtime_only']);
export const PublicReleaseAssetSchema = z.strictObject({
	path: z.string(),
	sha256: z.string().regex(SHA256),
	size_bytes: z.number().int().nonnegative(),
	exposure: PublicReleaseAssetExposureSchema,
});
export type PublicReleaseAsset = z.infer<typeof PublicReleaseAssetSchema>;

const LeaseSchema = z.object({ owner: z.string(), token: z.string(), until: z.number().int() });

// Loose so a rolling deploy can add fields without older replicas rejecting the record.
export const PublicReleaseRecordSchema = z.looseObject({
	schema_version: z.number().int().positive(),
	release_id: ulidString(),
	slug: DeepLinkSlugSchema,
	registration_id: ulidString(),
	target: DeepLinkTargetSchema,
	version_id: VersionIdSchema,
	entrypoint: z.string().min(1),
	code_sha256: z.string().regex(SHA256),
	assets: z.array(PublicReleaseAssetSchema),
	service_name: z.string(),
	origin: z.string(),
	state: PublicReleaseStateSchema,
	withdraw_requested: z.boolean(),
	withdraw_reason: PublicReleaseWithdrawReasonSchema.optional(),
	image_digest: z.string().optional(),
	build_id: z.string().optional(),
	attempt: z.number().int().nonnegative(),
	lease: LeaseSchema.optional(),
	fenced_until: z.number().int().optional(),
	next_retry_at: z.number().int().optional(),
	deadline_at: z.number().int(),
	staging: z.literal(true).optional(),
	bundle_cleaned: z.boolean().optional(),
	error: z.object({ code: z.string(), message: z.string() }).optional(),
	created_by: UserIdSchema,
	created_at: utcTimestamp(),
	updated_at: utcTimestamp(),
	exposed_at: utcTimestamp().optional(),
	activated_at: utcTimestamp().optional(),
	unpublish_requested_at: utcTimestamp().optional(),
	unpublished_at: utcTimestamp().optional(),
});
export type PublicReleaseRecord = z.infer<typeof PublicReleaseRecordSchema>;

export const PublicReleaseHeadSchema = z.looseObject({
	schema_version: z.number().int().positive(),
	registration_id: ulidString(),
	slug: DeepLinkSlugSchema,
	target: DeepLinkTargetSchema,
	active_release_id: ulidString().nullable(),
	/** At most one publish in flight per registration; claimed by CAS. */
	pending_release_id: ulidString().nullable(),
	withdrawing_release_id: ulidString().optional(),
	cancelling_release_id: ulidString().optional(),
	managed_activated: z.literal(true).optional(),
	last_release_id: ulidString().nullable(),
	updated_at: utcTimestamp(),
});
export type PublicReleaseHead = z.infer<typeof PublicReleaseHeadSchema>;

export const PublicReleaseLiveIndexSchema = z.object({
	schema_version: z.literal(1),
	release_ids: z.array(ulidString()),
});

/** The `/release/release.json` manifest the runtime verifies at startup. */
export interface PublicReleaseManifest {
	schema_version: 1;
	release_id: string;
	entrypoint: string;
	files: { path: string; sha256: string; size_bytes: number }[];
}

export interface PublicReleaseLimits {
	maxLiveReleases: number;
	maxAssets: number;
	maxAssetBytes: number;
	maxTotalAssetBytes: number;
}

export const DEFAULT_PUBLIC_RELEASE_LIMITS: PublicReleaseLimits = {
	maxLiveReleases: 5,
	maxAssets: 50,
	maxAssetBytes: 25 * 1024 * 1024,
	maxTotalAssetBytes: 50 * 1024 * 1024,
};

function assetPathProblem(path: string, entrypoint: string): string | null {
	if (!path) return 'is empty';
	if (pathEncoder.encode(path).byteLength > MAX_ASSET_PATH_BYTES || !isArchiveableReleasePath(path))
		return 'is too long';
	if (path.startsWith('/') || path.endsWith('/')) return 'must be relative';
	// eslint-disable-next-line no-control-regex
	if (path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) return 'has invalid characters';
	for (const segment of path.split('/')) {
		if (!segment || segment === '.' || segment === '..') return 'has an invalid segment';
		// Covers .env*, .git/, .venv/ and every other hidden file or directory.
		if (segment.startsWith('.')) return 'is hidden';
		if (segment === '__marimo__' || segment === '__pycache__') return 'is generated';
	}
	if (path === entrypoint) return 'is the notebook itself';
	if (path === 'pyproject.toml' || path === 'release.json') return 'is reserved';
	return null;
}

/** Reject paths that could leak hidden or generated files, or collide with release files. */
export function normalizeApprovedAssetPath(raw: string, entrypoint: string): string {
	const problem = assetPathProblem(raw, entrypoint);
	if (problem) throw new ValidationError(`Asset path ${JSON.stringify(raw)} ${problem}`);
	return raw;
}

export function isEligibleAssetPath(path: string, entrypoint: string): boolean {
	return assetPathProblem(path, entrypoint) === null;
}

/** Only photos under `public/` are web-served by the runtime gateway. */
export function deriveAssetExposure(path: string): PublicReleaseAsset['exposure'] {
	const dot = path.lastIndexOf('.');
	const extension = dot === -1 ? '' : path.slice(dot).toLowerCase();
	return path.startsWith('public/') && PUBLIC_PHOTO_EXTENSIONS.has(extension)
		? 'public_http'
		: 'runtime_only';
}

/** Cloud Run service names are 63-char RFC 1035 labels; a lowercase ULID keeps them unique. */
export function publicReleaseServiceName(releaseId: string): string {
	return `${PUBLIC_RELEASE_SERVICE_PREFIX}${releaseId.toLowerCase()}`;
}

export function deriveDeterministicOrigin(serviceName: string, hostSuffix: string): string {
	const origin = `https://${serviceName}${hostSuffix}`;
	if (!isApprovedPublicAppOrigin(origin, hostSuffix)) {
		throw new ValidationError('The public release host suffix does not produce approved origins');
	}
	return origin;
}

/** PEP 503 normalized distribution name. */
export function normalizePackageName(name: string): string {
	return name.toLowerCase().replaceAll(/[-_.]+/g, '-');
}

/** Distribution name at the head of a PEP 508 requirement, or null when unparseable. */
export function requirementName(requirement: string): string | null {
	const match = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/.exec(requirement);
	return match ? normalizePackageName(match[1]) : null;
}
