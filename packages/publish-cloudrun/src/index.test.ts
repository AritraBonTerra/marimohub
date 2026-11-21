import { gunzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { PublicReleaseHostFatalError } from '@marimo-hub/core/ports/public-release-host';
import { CloudRunPublicReleaseHost, releaseTar } from './index';
import { sha256Digest } from './oci';

const REGISTRY = 'us-west1-docker.pkg.dev';
const BASE_NAME = 'proj/marimo-public-releases/base';
const TARGET_NAME = 'proj/marimo-public-releases/dashboard';
const RUN = 'https://run.test';
const SERVICES = `${RUN}/v2/projects/proj/locations/us-west1/services`;
const RELEASE_ID = '01JRELEASE0000000000000000';
const SERVICE = `marimo-public-${RELEASE_ID.toLowerCase()}`;
const ORIGIN = `https://${SERVICE}-123.us-west1.run.app`;
const encoder = new TextEncoder();

interface Stored {
	bytes: Uint8Array;
	mediaType?: string;
}

/** An OCI distribution registry plus the Cloud Run v2 and anonymous endpoints, all in memory. */
class FakeGoogle {
	blobs = new Map<string, Map<string, Uint8Array>>();
	manifests = new Map<string, Map<string, Stored>>();
	services = new Map<string, Record<string, unknown>>();
	policies = new Map<string, { bindings: { role: string; members: string[] }[]; etag: string }>();
	iamConflicts = 0;
	requests: { method: string; url: string }[] = [];
	baseDigest = '';
	private uploads = 0;

	repo(map: Map<string, Map<string, Uint8Array>>, name: string) {
		let repo = map.get(name);
		if (!repo) map.set(name, (repo = new Map()));
		return repo;
	}

	async seedBase(labels: Record<string, string>) {
		const layer = encoder.encode('base layer');
		const config = encoder.encode(
			JSON.stringify({
				architecture: 'amd64',
				os: 'linux',
				config: { Labels: labels, User: '10001' },
				rootfs: { type: 'layers', diff_ids: [await sha256Digest(encoder.encode('base tar'))] },
				history: [{ created_by: 'base' }],
			}),
		);
		const blobs = this.repo(this.blobs, BASE_NAME);
		blobs.set(await sha256Digest(layer), layer);
		blobs.set(await sha256Digest(config), config);
		const manifest = encoder.encode(
			JSON.stringify({
				schemaVersion: 2,
				mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
				config: {
					mediaType: 'application/vnd.docker.container.image.v1+json',
					digest: await sha256Digest(config),
					size: config.byteLength,
				},
				layers: [
					{
						mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
						digest: await sha256Digest(layer),
						size: layer.byteLength,
					},
				],
			}),
		);
		const index = encoder.encode(
			JSON.stringify({
				schemaVersion: 2,
				mediaType: 'application/vnd.oci.image.index.v1+json',
				manifests: [
					{ digest: `sha256:${'a'.repeat(64)}`, platform: { os: 'linux', architecture: 'arm64' } },
					{
						mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
						digest: await sha256Digest(manifest),
						size: manifest.byteLength,
						platform: { os: 'linux', architecture: 'amd64' },
					},
				],
			}),
		);
		const manifests = new Map<string, Stored>();
		manifests.set(await sha256Digest(manifest), {
			bytes: manifest,
			mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
		});
		this.baseDigest = await sha256Digest(index);
		manifests.set(this.baseDigest, {
			bytes: index,
			mediaType: 'application/vnd.oci.image.index.v1+json',
		});
		this.manifests.set(BASE_NAME, manifests);
	}

	fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		const method = init.method ?? 'GET';
		this.requests.push({ method, url: url.toString() });
		const headers = new Headers(init.headers);
		const body = init.body instanceof Uint8Array ? init.body : undefined;
		if (url.host === REGISTRY) return this.registry(url, method, headers, body);
		if (url.origin === RUN) return this.run(url, method, headers, init.body);
		if (url.hostname.endsWith('.run.app')) {
			const name = url.hostname.split('-123.')[0];
			const policy = this.policies.get(name);
			if (!this.services.has(name)) return new Response('', { status: 404 });
			const open = policy?.bindings.some((b) => b.members.includes('allUsers'));
			return new Response('ok', { status: open ? 200 : 403 });
		}
		throw new Error(`unexpected ${url}`);
	};

	private async registry(url: URL, method: string, headers: Headers, body?: Uint8Array) {
		if (url.pathname === '/v2/token') {
			const basic = headers.get('authorization');
			if (basic !== `Basic ${btoa('oauth2accesstoken:google-token')}`)
				return new Response('', { status: 403 });
			expect(url.searchParams.get('scope')).toMatch(/^repository:.+:pull,push$/);
			return Response.json({ token: 'registry-token' });
		}
		if (headers.get('authorization') !== 'Bearer registry-token')
			return new Response('', {
				status: 401,
				headers: {
					'WWW-Authenticate': `Bearer realm="https://${REGISTRY}/v2/token",service="${REGISTRY}"`,
				},
			});
		const match = /^\/v2\/(.+)\/(manifests|blobs)\/(.+)$/.exec(url.pathname);
		if (!match) throw new Error(`unexpected registry path ${url.pathname}`);
		const [, name, kind, ref] = match as unknown as [string, string, string, string];
		if (kind === 'manifests') {
			const manifests = this.manifests.get(name) ?? new Map<string, Stored>();
			this.manifests.set(name, manifests);
			if (method === 'PUT') {
				const digest = await sha256Digest(body!);
				const stored = { bytes: body!, mediaType: headers.get('content-type')! };
				const parsed = JSON.parse(new TextDecoder().decode(body)) as {
					config: { digest: string };
					layers: { digest: string }[];
				};
				for (const d of [parsed.config.digest, ...parsed.layers.map((l) => l.digest)])
					if (!this.repo(this.blobs, name).has(d))
						return new Response('missing blob', { status: 400 });
				manifests.set(ref, stored);
				manifests.set(digest, stored);
				return new Response('', { status: 201, headers: { 'Docker-Content-Digest': digest } });
			}
			const stored = manifests.get(ref);
			if (!stored) return new Response('', { status: 404 });
			return new Response(Uint8Array.from(stored.bytes), {
				headers: { 'Content-Type': stored.mediaType ?? '' },
			});
		}
		const blobs = this.repo(this.blobs, name);
		if (ref === 'uploads/' && method === 'POST') {
			const from = url.searchParams.get('from');
			const mount = url.searchParams.get('mount');
			if (from && mount) {
				const source = this.repo(this.blobs, from).get(mount);
				if (source) {
					blobs.set(mount, source);
					return new Response('', { status: 201 });
				}
			}
			return new Response('', {
				status: 202,
				headers: { Location: `/v2/${name}/blobs/uploads/u${++this.uploads}` },
			});
		}
		if (ref.startsWith('uploads/') && method === 'PUT') {
			const digest = url.searchParams.get('digest')!;
			if ((await sha256Digest(body!)) !== digest)
				return new Response('bad digest', { status: 400 });
			blobs.set(digest, body!);
			return new Response('', { status: 201 });
		}
		const blob = blobs.get(ref);
		if (!blob) return new Response('', { status: 404 });
		return new Response(method === 'HEAD' ? null : Uint8Array.from(blob));
	}

	private async run(url: URL, method: string, headers: Headers, body: RequestInit['body']) {
		expect(headers.get('authorization')).toBe('Bearer google-token');
		const path = url.pathname.slice(new URL(SERVICES).pathname.length);
		if (path === '' && method === 'POST') {
			const id = url.searchParams.get('serviceId')!;
			if (this.services.has(id)) return new Response('', { status: 409 });
			this.services.set(id, {
				...(JSON.parse(body as string) as Record<string, unknown>),
				name: `projects/proj/locations/us-west1/services/${id}`,
				reconciling: true,
				terminalCondition: { state: 'CONDITION_PENDING' },
				urls: [`https://${id}-123.us-west1.run.app`, `https://${id}-hash-uw.a.run.app`],
			});
			this.policies.set(id, { bindings: [], etag: 'e0' });
			return Response.json({ name: 'operations/create' });
		}
		if (path === '' && method === 'GET')
			return Response.json({ services: [...this.services.values()] });
		const [name, verb] = path.slice(1).split(':') as [string, string | undefined];
		const service = this.services.get(name);
		if (!service) return new Response('', { status: 404 });
		if (verb === 'getIamPolicy') return Response.json(this.policies.get(name));
		if (verb === 'setIamPolicy') {
			if (this.iamConflicts > 0) {
				this.iamConflicts--;
				this.policies.get(name)!.etag += 'x';
				return new Response('', { status: 409 });
			}
			const { policy } = JSON.parse(body as string) as {
				policy: { bindings: { role: string; members: string[] }[]; etag: string };
			};
			if (policy.etag !== this.policies.get(name)!.etag) return new Response('', { status: 412 });
			if (policy.bindings.some((binding) => binding.members.length === 0))
				return new Response('', { status: 400 });
			this.policies.set(name, { ...policy, etag: `${policy.etag}1` });
			return Response.json(policy);
		}
		if (method === 'DELETE') {
			this.services.delete(name);
			this.policies.delete(name);
			return Response.json({ name: 'operations/delete' });
		}
		return Response.json(service);
	}

	markReady(name = SERVICE) {
		Object.assign(this.services.get(name)!, {
			reconciling: false,
			terminalCondition: { state: 'CONDITION_SUCCEEDED' },
		});
	}
}

function untar(tar: Uint8Array) {
	const entries: {
		path: string;
		mode: number;
		uid: number;
		mtime: number;
		type: string;
		body: string;
	}[] = [];
	const text = (from: number, to: number) =>
		new TextDecoder().decode(tar.subarray(from, to)).split(String.fromCharCode(0))[0];
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const name = text(offset, offset + 100);
		if (!name) break;
		const prefix = text(offset + 345, offset + 500);
		const size = Number.parseInt(text(offset + 124, offset + 136), 8);
		entries.push({
			path: prefix ? `${prefix}/${name}` : name,
			mode: Number.parseInt(text(offset + 100, offset + 108), 8),
			uid: Number.parseInt(text(offset + 108, offset + 116), 8),
			mtime: Number.parseInt(text(offset + 136, offset + 148), 8),
			type: text(offset + 156, offset + 157),
			body: new TextDecoder().decode(tar.subarray(offset + 512, offset + 512 + size)),
		});
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return entries;
}

let google: FakeGoogle;
let host: CloudRunPublicReleaseHost;
const files = [
	{ path: 'notebook.py', bytes: encoder.encode('import marimo'), sha256: 'x' },
	{ path: 'public/photo.png', bytes: encoder.encode('png'), sha256: 'y' },
	{ path: 'release.json', bytes: encoder.encode('{}'), sha256: 'z' },
];
const deployInput = () => ({
	releaseId: RELEASE_ID,
	serviceName: SERVICE,
	origin: ORIGIN,
	entrypoint: 'notebook.py',
	files: async () => files,
});

beforeEach(async () => {
	google = new FakeGoogle();
	await google.seedBase({ 'io.marimohub.installed-packages': '["marimo","Pandas"]' });
	host = new CloudRunPublicReleaseHost({
		projectId: 'proj',
		projectNumber: '123',
		region: 'us-west1',
		repository: 'marimo-public-releases',
		baseImage: `${REGISTRY}/${BASE_NAME}@${google.baseDigest}`,
		runtimeServiceAccount: 'mh-public-runtime@proj.iam.gserviceaccount.com',
		instance: 'staging',
		getToken: async () => 'google-token',
		fetch: google.fetch,
		runApiEndpoint: RUN,
		probeDelayMs: 1,
	});
});

describe('release layer', () => {
	it('is reproducible, read-only and owned by the runtime user', async () => {
		const tar = releaseTar(files);
		expect(await sha256Digest(releaseTar([...files].reverse()))).toBe(await sha256Digest(tar));
		const entries = untar(tar);
		expect(entries.map((e) => [e.path, e.type, e.mode.toString(8)])).toEqual([
			['release/', '5', '555'],
			['release/public/', '5', '555'],
			['release/notebook.py', '0', '444'],
			['release/public/photo.png', '0', '444'],
			['release/release.json', '0', '444'],
		]);
		expect(entries.every((e) => e.uid === 10001 && e.mtime === 0)).toBe(true);
	});

	it('splits long paths into the ustar prefix', () => {
		const path = `${'d'.repeat(60)}/${'e'.repeat(60)}/file.csv`;
		const entry = untar(releaseTar([{ path, bytes: encoder.encode('1'), sha256: '' }])).at(-1)!;
		expect(entry.path).toBe(`release/${path}`);
	});
});

describe('CloudRunPublicReleaseHost', () => {
	it('reads installed packages from the base image label', async () => {
		expect([...(await host.getInstalledPackages())!]).toEqual(['marimo', 'pandas']);
	});

	it('appends one layer to the pinned base and creates a private, zero-grant service', async () => {
		const first = await host.deployPrivate(deployInput());
		expect(first).toMatchObject({
			status: 'in_progress',
			imageDigest: expect.stringMatching(/^sha256:/),
		});
		const pushed = google.manifests.get(TARGET_NAME)!.get(first.imageDigest!)!;
		const manifest = JSON.parse(new TextDecoder().decode(pushed.bytes)) as {
			layers: { digest: string }[];
			config: { digest: string };
		};
		expect(manifest.layers).toHaveLength(2);
		const layer = google.blobs.get(TARGET_NAME)!.get(manifest.layers[1].digest)!;
		expect(untar(gunzipSync(layer)).map((e) => e.path)).toContain('release/notebook.py');
		const config = JSON.parse(
			new TextDecoder().decode(google.blobs.get(TARGET_NAME)!.get(manifest.config.digest)),
		) as { rootfs: { diff_ids: string[] }; config: { User: string } };
		expect(config.rootfs.diff_ids).toHaveLength(2);
		expect(config.config.User).toBe('10001');

		const service = google.services.get(SERVICE)!;
		expect(service).toMatchObject({
			ingress: 'INGRESS_TRAFFIC_ALL',
			labels: {
				'marimohub-managed': 'true',
				'marimohub-instance': 'staging',
				'marimohub-release-id': RELEASE_ID.toLowerCase(),
			},
			template: {
				serviceAccount: 'mh-public-runtime@proj.iam.gserviceaccount.com',
				scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
				timeout: '300s',
				maxInstanceRequestConcurrency: 24,
				containers: [
					{
						image: `${REGISTRY}/${TARGET_NAME}@${first.imageDigest}`,
						startupProbe: { httpGet: { path: '/health', port: 8080 } },
						env: [
							{ name: 'PUBLIC_DASHBOARD_ORIGIN', value: ORIGIN },
							{ name: 'PUBLIC_DASHBOARD_RELEASE', value: '/release' },
							{ name: 'PUBLIC_DASHBOARD_ENTRYPOINT', value: 'notebook.py' },
							{ name: 'HOME', value: '/tmp' },
							{ name: 'MARIMO_SKIP_UPDATE_CHECK', value: '1' },
							{ name: 'PYTHONDONTWRITEBYTECODE', value: '1' },
						],
					},
				],
			},
		});
		expect(JSON.stringify(service)).not.toMatch(/secret|volume/i);
		expect(google.policies.get(SERVICE)!.bindings).toEqual([]);

		expect(await host.deployPrivate(deployInput())).toMatchObject({ status: 'in_progress' });
		google.markReady();
		expect(await host.deployPrivate(deployInput())).toEqual({
			status: 'ready',
			imageDigest: first.imageDigest,
		});
	});

	it('fails a release whose revision failed or whose name belongs to another release', async () => {
		await host.deployPrivate(deployInput());
		google.services.get(SERVICE)!.terminalCondition = {
			state: 'CONDITION_FAILED',
			message: 'boom',
		};
		await expect(host.deployPrivate(deployInput())).rejects.toBeInstanceOf(
			PublicReleaseHostFatalError,
		);
		await expect(
			host.deployPrivate({ ...deployInput(), releaseId: '01JOTHER000000000000000000' }),
		).rejects.toThrow('belongs to another release');
	});

	it('exposes with etag retries, then requires anonymous 200s', async () => {
		await host.deployPrivate(deployInput());
		google.markReady();
		google.iamConflicts = 1;
		await host.expose({ releaseId: RELEASE_ID, serviceName: SERVICE, origin: ORIGIN });
		expect(google.policies.get(SERVICE)!.bindings).toEqual([
			{ role: 'roles/run.invoker', members: ['allUsers'] },
		]);
		expect(await host.inspect(SERVICE)).toMatchObject({ state: 'live', publicInvoker: true });
		expect(await host.probeAnonymous(ORIGIN)).toEqual({ status: 200 });
	});

	it('revokes only managed services and confirms absence', async () => {
		await expect(
			host.revoke({ releaseId: RELEASE_ID, serviceName: 'hub-api' }),
		).rejects.toBeInstanceOf(PublicReleaseHostFatalError);
		google.services.set('marimo-public-manual', { labels: {} });
		await expect(
			host.revoke({ releaseId: RELEASE_ID, serviceName: 'marimo-public-manual' }),
		).rejects.toThrow('not managed');
		expect(google.services.has('marimo-public-manual')).toBe(true);

		await host.deployPrivate(deployInput());
		google.markReady();
		await host.expose({ releaseId: RELEASE_ID, serviceName: SERVICE, origin: ORIGIN });
		const iamWrites = () => google.requests.filter((r) => r.url.endsWith(':setIamPolicy')).length;
		const before = iamWrites();
		expect(await host.revoke({ releaseId: RELEASE_ID, serviceName: SERVICE })).toBe('absent');
		expect(iamWrites()).toBe(before + 1);
		expect(await host.inspect(SERVICE)).toEqual({ state: 'absent', publicInvoker: false });
		expect(await host.probeAnonymous(ORIGIN)).toEqual({ status: 404 });
		expect(await host.revoke({ releaseId: RELEASE_ID, serviceName: SERVICE })).toBe('absent');
	});

	it('lists only this instance’s managed services', async () => {
		await host.deployPrivate(deployInput());
		google.services.set('marimo-public-other', {
			name: 'projects/proj/locations/us-west1/services/marimo-public-other',
			labels: { 'marimohub-managed': 'true', 'marimohub-instance': 'prod' },
		});
		expect(await host.listManagedServices()).toEqual([
			{ serviceName: SERVICE, releaseId: RELEASE_ID.toLowerCase(), publicInvoker: false },
		]);
	});
});
