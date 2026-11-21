import { gzipSync } from 'fflate';
import { splitReleaseTarPath } from '@marimo-hub/core';
import { PublicReleaseHostFatalError } from '@marimo-hub/core/ports/public-release-host';
import type { PublicReleaseBundleFile } from '@marimo-hub/core/ports/public-release-host';

const RUNTIME_UID = 10001;
const encoder = new TextEncoder();

export async function sha256Digest(bytes: Uint8Array): Promise<string> {
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
	return `sha256:${Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function octal(value: number, width: number): string {
	return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function header(path: string, size: number, directory: boolean): Uint8Array {
	const block = new Uint8Array(512);
	const write = (offset: number, value: string) => block.set(encoder.encode(value), offset);
	const parts = splitReleaseTarPath(path);
	if (!parts)
		throw new PublicReleaseHostFatalError('path_too_long', `Release path is too long: ${path}`);
	const { name, prefix } = parts;
	write(0, name);
	write(100, octal(directory ? 0o555 : 0o444, 8));
	write(108, octal(RUNTIME_UID, 8));
	write(116, octal(RUNTIME_UID, 8));
	write(124, octal(size, 12));
	write(136, octal(0, 12));
	write(148, '        ');
	write(156, directory ? '5' : '0');
	write(257, 'ustar\0');
	write(263, '00');
	write(345, prefix);
	const checksum = block.reduce((sum, byte) => sum + byte, 0);
	write(148, `${checksum.toString(8).padStart(6, '0')}\0 `);
	return block;
}

/**
 * A reproducible POSIX tar of the release under `release/`: read-only modes, the runtime
 * uid, zero mtimes and sorted entries, so the same bundle always yields the same digest.
 */
export function releaseTar(files: readonly PublicReleaseBundleFile[]): Uint8Array {
	const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const directories = new Set<string>(['release/']);
	for (const file of sorted) {
		const parts = file.path.split('/');
		for (let i = 1; i < parts.length; i++)
			directories.add(`release/${parts.slice(0, i).join('/')}/`);
	}
	const chunks: Uint8Array[] = [];
	for (const directory of [...directories].sort()) chunks.push(header(directory, 0, true));
	for (const file of sorted) {
		chunks.push(header(`release/${file.path}`, file.bytes.byteLength, false));
		chunks.push(file.bytes);
		const pad = (512 - (file.bytes.byteLength % 512)) % 512;
		if (pad) chunks.push(new Uint8Array(pad));
	}
	chunks.push(new Uint8Array(1024));
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export function gzipLayer(tar: Uint8Array): Uint8Array {
	return gzipSync(tar, { level: 6, mtime: 0 });
}

export interface ImageReference {
	host: string;
	name: string;
	digest: string;
}

/** Parse `HOST/NAME@sha256:...`; release images must be pinned by digest. */
export function parseImageReference(ref: string): ImageReference {
	const match = /^([a-z0-9.-]+(?::\d+)?)\/([a-z0-9._/-]+)@(sha256:[0-9a-f]{64})$/.exec(ref);
	if (!match) throw new Error('Expected an image reference of the form HOST/NAME@sha256:DIGEST');
	return { host: match[1], name: match[2], digest: match[3] };
}

const MANIFEST_TYPES = {
	ociIndex: 'application/vnd.oci.image.index.v1+json',
	ociManifest: 'application/vnd.oci.image.manifest.v1+json',
	dockerList: 'application/vnd.docker.distribution.manifest.list.v2+json',
	dockerManifest: 'application/vnd.docker.distribution.manifest.v2+json',
} as const;
const LAYER_TYPES: Record<string, string> = {
	[MANIFEST_TYPES.ociManifest]: 'application/vnd.oci.image.layer.v1.tar+gzip',
	[MANIFEST_TYPES.dockerManifest]: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
};

interface Descriptor {
	mediaType: string;
	digest: string;
	size: number;
	platform?: { os?: string; architecture?: string };
}
interface ImageManifest {
	schemaVersion: number;
	mediaType?: string;
	config: Descriptor;
	layers: Descriptor[];
	[key: string]: unknown;
}
interface ImageConfig {
	config?: { Labels?: Record<string, string>; [key: string]: unknown };
	rootfs: { type: string; diff_ids: string[] };
	history?: Record<string, unknown>[];
	[key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface RegistryOptions {
	/** Google OAuth access token used as the registry credential. */
	getToken: () => Promise<string>;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

/**
 * Minimal OCI distribution client: Docker bearer-token auth, manifest reads through an
 * image index, blob upload and cross-repository mount, and manifest push.
 */
export class RegistryClient {
	private readonly fetchImpl: typeof fetch;
	private readonly tokens = new Map<string, string>();
	private readonly configs = new Map<string, ImageConfig>();

	constructor(
		private readonly host: string,
		private readonly options: RegistryOptions,
	) {
		this.fetchImpl = options.fetch ?? fetch;
	}

	private url(path: string) {
		return path.startsWith('https://') || path.startsWith('http://')
			? path
			: `https://${this.host}/v2/${path}`;
	}

	private async registryToken(challenge: string, scope: string): Promise<string> {
		const params = Object.fromEntries(
			[...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
		);
		if (!params.realm) throw new Error('Registry sent no token realm');
		const url = new URL(params.realm);
		if (params.service) url.searchParams.set('service', params.service);
		url.searchParams.set('scope', scope);
		const basic = btoa(`oauth2accesstoken:${await this.options.getToken()}`);
		const response = await this.fetchImpl(url, { headers: { Authorization: `Basic ${basic}` } });
		if (!response.ok) throw new Error(`Registry token request failed: ${response.status}`);
		const body: unknown = await response.json();
		const token = isRecord(body) ? (body.token ?? body.access_token) : undefined;
		if (typeof token !== 'string') throw new Error('Registry token response had no token');
		return token;
	}

	async request(
		path: string,
		repository: string,
		init: RequestInit & { signal?: AbortSignal } = {},
	): Promise<Response> {
		const scope = `repository:${repository}:pull,push`;
		const send = (token?: string) => {
			const headers = new Headers(init.headers);
			if (token) headers.set('Authorization', `Bearer ${token}`);
			const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
			return this.fetchImpl(this.url(path), {
				...init,
				headers,
				redirect: 'follow',
				signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
			});
		};
		let response = await send(this.tokens.get(scope));
		if (response.status === 401) {
			const challenge = response.headers.get('www-authenticate') ?? '';
			const token = await this.registryToken(challenge, scope);
			this.tokens.set(scope, token);
			response = await send(token);
		}
		return response;
	}

	private async expectOk(response: Response, what: string) {
		if (response.ok) return response;
		throw new Error(`${what} failed: ${response.status}`);
	}

	/** Resolve a digest to its linux/amd64 image manifest. */
	async imageManifest(
		name: string,
		digest: string,
		signal?: AbortSignal,
	): Promise<{ manifest: ImageManifest; mediaType: string }> {
		const response = await this.expectOk(
			await this.request(`${name}/manifests/${digest}`, name, {
				headers: { Accept: Object.values(MANIFEST_TYPES).join(', ') },
				signal,
			}),
			'Reading the base image manifest',
		);
		const body: unknown = await response.json();
		if (!isRecord(body)) throw new Error('Malformed base image manifest');
		const mediaType =
			(typeof body.mediaType === 'string' ? body.mediaType : undefined) ??
			response.headers.get('content-type')?.split(';')[0] ??
			'';
		if (mediaType === MANIFEST_TYPES.ociIndex || mediaType === MANIFEST_TYPES.dockerList) {
			const manifests = Array.isArray(body.manifests) ? (body.manifests as Descriptor[]) : [];
			const platform = manifests.find(
				(m) => m.platform?.os === 'linux' && m.platform.architecture === 'amd64',
			);
			if (!platform)
				throw new PublicReleaseHostFatalError(
					'no_amd64_image',
					'Base image has no linux/amd64 build',
				);
			return this.imageManifest(name, platform.digest, signal);
		}
		if (!LAYER_TYPES[mediaType] || !isRecord(body.config) || !Array.isArray(body.layers))
			throw new PublicReleaseHostFatalError(
				'unsupported_manifest',
				`Unsupported base manifest type ${mediaType}`,
			);
		return { manifest: body as ImageManifest, mediaType };
	}

	async config(name: string, digest: string, signal?: AbortSignal): Promise<ImageConfig> {
		const cached = this.configs.get(digest);
		if (cached) return cached;
		const response = await this.expectOk(
			await this.request(`${name}/blobs/${digest}`, name, { signal }),
			'Reading the base image config',
		);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if ((await sha256Digest(bytes)) !== digest)
			throw new Error('Base image config digest mismatch');
		const config: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (!isRecord(config) || !isRecord(config.rootfs) || !Array.isArray(config.rootfs.diff_ids))
			throw new PublicReleaseHostFatalError('unsupported_config', 'Malformed base image config');
		this.configs.set(digest, config as ImageConfig);
		return config as ImageConfig;
	}

	async hasBlob(name: string, digest: string, signal?: AbortSignal): Promise<boolean> {
		const response = await this.request(`${name}/blobs/${digest}`, name, {
			method: 'HEAD',
			signal,
		});
		if (response.status === 404) return false;
		await this.expectOk(response, 'Checking a blob');
		return true;
	}

	async pushBlob(name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
		const digest = await sha256Digest(bytes);
		if (await this.hasBlob(name, digest, signal)) return digest;
		const start = await this.expectOk(
			await this.request(`${name}/blobs/uploads/`, name, { method: 'POST', signal }),
			'Starting a blob upload',
		);
		const location = start.headers.get('location');
		if (!location) throw new Error('Registry returned no upload location');
		const upload = new URL(location, `https://${this.host}`);
		upload.searchParams.set('digest', digest);
		await this.expectOk(
			await this.request(upload.toString(), name, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/octet-stream' },
				body: Uint8Array.from(bytes),
				signal,
			}),
			'Uploading a blob',
		);
		return digest;
	}

	/** Make a base layer available in `name`, mounting it from `from` when needed. */
	async ensureBlob(name: string, from: string, digest: string, signal?: AbortSignal) {
		if (name === from || (await this.hasBlob(name, digest, signal))) return;
		const mount = await this.request(
			`${name}/blobs/uploads/?mount=${encodeURIComponent(digest)}&from=${encodeURIComponent(from)}`,
			name,
			{ method: 'POST', signal },
		);
		if (mount.status === 201 || (await this.hasBlob(name, digest, signal))) return;
		throw new PublicReleaseHostFatalError(
			'base_layer_unavailable',
			'Push the base image into the release repository so its layers can be reused',
		);
	}

	async putManifest(
		name: string,
		tag: string,
		manifest: unknown,
		mediaType: string,
		signal?: AbortSignal,
	): Promise<string> {
		const bytes = encoder.encode(JSON.stringify(manifest));
		const digest = await sha256Digest(bytes);
		await this.expectOk(
			await this.request(`${name}/manifests/${tag}`, name, {
				method: 'PUT',
				headers: { 'Content-Type': mediaType },
				body: bytes,
				signal,
			}),
			'Pushing the release manifest',
		);
		return digest;
	}
}

/**
 * Append the release as one read-only layer on top of the pinned base image and push it
 * as `target:tag`. No build step runs, so nothing from the notebook executes here.
 */
export async function appendReleaseLayer(input: {
	registry: RegistryClient;
	base: ImageReference;
	targetName: string;
	tag: string;
	releaseId: string;
	files: readonly PublicReleaseBundleFile[];
	signal?: AbortSignal;
}): Promise<string> {
	const { registry, base, targetName, signal } = input;
	const { manifest, mediaType } = await registry.imageManifest(base.name, base.digest, signal);
	const config = await registry.config(base.name, manifest.config.digest, signal);
	for (const layer of manifest.layers)
		await registry.ensureBlob(targetName, base.name, layer.digest, signal);

	const tar = releaseTar(input.files);
	const layer = gzipLayer(tar);
	const layerDigest = await registry.pushBlob(targetName, layer, signal);
	const nextConfig: ImageConfig = {
		...config,
		config: {
			...config.config,
			Labels: {
				...config.config?.Labels,
				'io.marimohub.release-id': input.releaseId.toLowerCase(),
			},
		},
		rootfs: { ...config.rootfs, diff_ids: [...config.rootfs.diff_ids, await sha256Digest(tar)] },
		history: [
			...(config.history ?? []),
			{ created_by: 'marimohub public release layer', comment: input.releaseId },
		],
	};
	const configBytes = encoder.encode(JSON.stringify(nextConfig));
	const configDigest = await registry.pushBlob(targetName, configBytes, signal);
	return registry.putManifest(
		targetName,
		input.tag,
		{
			...manifest,
			config: { ...manifest.config, digest: configDigest, size: configBytes.byteLength },
			layers: [
				...manifest.layers,
				{ mediaType: LAYER_TYPES[mediaType], digest: layerDigest, size: layer.byteLength },
			],
		},
		mediaType,
		signal,
	);
}
