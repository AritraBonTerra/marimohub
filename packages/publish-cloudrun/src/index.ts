/**
 * `PublicReleaseHost` for Google Cloud Run. A release image is the pinned public dashboard
 * base image plus one appended read-only layer holding the frozen bundle, so no build step
 * or package install runs. Services are private until `expose` grants `allUsers` invoker.
 */
import { PublicReleaseHostFatalError } from '@marimo-hub/core/ports/public-release-host';
import type {
	ManagedPublicReleaseService,
	PublicReleaseDeployResult,
	PublicReleaseHost,
	PublicReleaseInspection,
} from '@marimo-hub/core/ports/public-release-host';
import { appendReleaseLayer, parseImageReference, RegistryClient } from './oci';
import type { ImageReference } from './oci';

export { googleAccessToken } from './auth';
export { appendReleaseLayer, parseImageReference, RegistryClient, releaseTar } from './oci';

const SERVICE_PREFIX = 'marimo-public-';
const MANAGED_LABEL = 'marimohub-managed';
const INSTANCE_LABEL = 'marimohub-instance';
const RELEASE_LABEL = 'marimohub-release-id';
const INVOKER_ROLE = 'roles/run.invoker';
const PUBLIC_MEMBERS = new Set(['allUsers', 'allAuthenticatedUsers']);
const INSTALLED_PACKAGES_LABEL = 'io.marimohub.installed-packages';

export interface CloudRunPublicReleaseHostConfig {
	projectId: string;
	projectNumber: string;
	region: string;
	/** Artifact Registry repository that receives release images. */
	repository: string;
	/** Digest-pinned public dashboard base image, e.g. `REGION-docker.pkg.dev/P/R/base@sha256:…`. */
	baseImage: string;
	/** Zero-grant service account the dashboards run as. */
	runtimeServiceAccount: string;
	/** Distinguishes hubs that share a project so sweeps never touch another hub's services. */
	instance?: string;
	getToken: () => Promise<string>;
	fetch?: typeof fetch;
	runApiEndpoint?: string;
	/** Anonymous probe attempts and delay while IAM changes propagate. */
	probeAttempts?: number;
	probeDelayMs?: number;
}

interface CloudRunService {
	name?: string;
	labels?: Record<string, string>;
	urls?: string[];
	reconciling?: boolean;
	terminalCondition?: { state?: string; message?: string };
	template?: { containers?: { image?: string }[] };
}

interface IamPolicy {
	bindings?: { role: string; members?: string[] }[];
	etag?: string;
	version?: number;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'HttpError';
	}
}

function sleep(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
			},
			{ once: true },
		);
	});
}

function hasPublicInvoker(policy: IamPolicy): boolean {
	return (policy.bindings ?? []).some(
		(binding) =>
			binding.role === INVOKER_ROLE && (binding.members ?? []).some((m) => PUBLIC_MEMBERS.has(m)),
	);
}

export class CloudRunPublicReleaseHost implements PublicReleaseHost {
	readonly kind = 'gcp-cloud-run';
	readonly hostSuffix: string;
	private readonly config: CloudRunPublicReleaseHostConfig;
	private readonly fetchImpl: typeof fetch;
	private readonly base: ImageReference;
	private readonly registry: RegistryClient;
	private readonly targetName: string;
	private readonly instance: string;
	private installed?: Promise<ReadonlySet<string> | null>;

	constructor(config: CloudRunPublicReleaseHostConfig) {
		this.config = config;
		this.fetchImpl = config.fetch ?? fetch;
		this.base = parseImageReference(config.baseImage);
		const registryHost = `${config.region}-docker.pkg.dev`;
		if (this.base.host !== registryHost)
			throw new Error(`The base image must be in ${registryHost} so its layers can be reused`);
		this.registry = new RegistryClient(registryHost, {
			getToken: config.getToken,
			fetch: this.fetchImpl,
		});
		this.targetName = `${config.projectId}/${config.repository}/dashboard`;
		this.hostSuffix = `-${config.projectNumber}.${config.region}.run.app`;
		this.instance = config.instance ?? 'default';
	}

	private get servicesUrl() {
		const endpoint = this.config.runApiEndpoint ?? 'https://run.googleapis.com';
		return `${endpoint}/v2/projects/${this.config.projectId}/locations/${this.config.region}/services`;
	}

	private async call<T>(
		url: string,
		init: RequestInit & { signal?: AbortSignal } = {},
	): Promise<T> {
		const timeout = AbortSignal.timeout(30_000);
		const headers = new Headers(init.headers);
		headers.set('Authorization', `Bearer ${await this.config.getToken()}`);
		headers.set('Content-Type', 'application/json');
		const response = await this.fetchImpl(url, {
			...init,
			headers,
			signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
		});
		if (!response.ok) {
			// Error bodies can echo resource names but never credentials; keep only the status text.
			throw new HttpError(response.status, `Cloud Run request failed: ${response.status}`);
		}
		return (await response.json()) as T;
	}

	private async getService(name: string, signal?: AbortSignal): Promise<CloudRunService | null> {
		try {
			return await this.call<CloudRunService>(`${this.servicesUrl}/${name}`, { signal });
		} catch (error) {
			if (error instanceof HttpError && error.status === 404) return null;
			throw error;
		}
	}

	private getPolicy(name: string, signal?: AbortSignal) {
		return this.call<IamPolicy>(`${this.servicesUrl}/${name}:getIamPolicy`, { signal });
	}

	private setPolicy(name: string, policy: IamPolicy, signal?: AbortSignal) {
		return this.call<IamPolicy>(`${this.servicesUrl}/${name}:setIamPolicy`, {
			method: 'POST',
			body: JSON.stringify({ policy }),
			signal,
		});
	}

	/** Read-modify-write the policy with its etag, retrying concurrent edits. */
	private async updatePolicy(
		name: string,
		mutate: (policy: IamPolicy) => IamPolicy | null,
		signal?: AbortSignal,
	) {
		for (let attempt = 0; ; attempt++) {
			const next = mutate(await this.getPolicy(name, signal));
			if (!next) return;
			try {
				await this.setPolicy(name, next, signal);
				return;
			} catch (error) {
				const conflict =
					error instanceof HttpError && (error.status === 409 || error.status === 412);
				if (!conflict || attempt >= 2) throw error;
			}
		}
	}

	private assertManaged(name: string, service: CloudRunService | null) {
		if (!name.startsWith(SERVICE_PREFIX))
			throw new PublicReleaseHostFatalError('unmanaged_service', `Refusing to manage ${name}`);
		if (
			service &&
			(service.labels?.[MANAGED_LABEL] !== 'true' ||
				service.labels?.[INSTANCE_LABEL] !== this.instance)
		)
			throw new PublicReleaseHostFatalError(
				'unmanaged_service',
				`${name} is not managed by this hub`,
			);
	}

	async getInstalledPackages(signal?: AbortSignal): Promise<ReadonlySet<string> | null> {
		this.installed ??= (async () => {
			const { manifest } = await this.registry.imageManifest(
				this.base.name,
				this.base.digest,
				signal,
			);
			const config = await this.registry.config(this.base.name, manifest.config.digest, signal);
			const label = config.config?.Labels?.[INSTALLED_PACKAGES_LABEL];
			if (!label) return null;
			const names: unknown = JSON.parse(label);
			if (!Array.isArray(names)) throw new Error(`Malformed ${INSTALLED_PACKAGES_LABEL} label`);
			return new Set(
				names.map((name) => {
					if (typeof name !== 'string')
						throw new Error(`Malformed ${INSTALLED_PACKAGES_LABEL} label`);
					return name.toLowerCase().replaceAll(/[-_.]+/g, '-');
				}),
			);
		})();
		try {
			return await this.installed;
		} catch (error) {
			this.installed = undefined;
			throw error;
		}
	}

	async deployPrivate(
		input: Parameters<PublicReleaseHost['deployPrivate']>[0],
	): Promise<PublicReleaseDeployResult> {
		const { serviceName, releaseId, signal } = input;
		this.assertManaged(serviceName, null);
		const service = await this.getService(serviceName, signal);
		this.assertManaged(serviceName, service);
		if (!service) {
			const imageDigest = await appendReleaseLayer({
				registry: this.registry,
				base: this.base,
				targetName: this.targetName,
				tag: `release-${releaseId.toLowerCase()}`,
				releaseId,
				files: await input.files(),
				signal,
			});
			try {
				await this.call(`${this.servicesUrl}?serviceId=${serviceName}`, {
					method: 'POST',
					body: JSON.stringify(this.serviceSpec(input, imageDigest)),
					signal,
				});
			} catch (error) {
				if (!(error instanceof HttpError && error.status === 409)) throw error;
			}
			return { status: 'in_progress', imageDigest };
		}
		if (service.labels?.[RELEASE_LABEL] !== releaseId.toLowerCase())
			throw new PublicReleaseHostFatalError(
				'service_conflict',
				`${serviceName} belongs to another release`,
			);
		const state = service.terminalCondition?.state;
		if (state === 'CONDITION_FAILED')
			throw new PublicReleaseHostFatalError(
				'revision_failed',
				(service.terminalCondition?.message ?? 'The release revision failed to start').slice(
					0,
					200,
				),
			);
		const image = service.template?.containers?.[0]?.image ?? '';
		const imageDigest = /@(sha256:[0-9a-f]{64})$/.exec(image)?.[1];
		if (service.reconciling || state !== 'CONDITION_SUCCEEDED' || !imageDigest)
			return { status: 'in_progress', imageDigest };
		// The deterministic URL is what the gateway checks Origin against.
		if (!service.urls?.includes(input.origin))
			throw new PublicReleaseHostFatalError(
				'origin_mismatch',
				'Cloud Run did not assign the expected URL',
			);
		return { status: 'ready', imageDigest };
	}

	private serviceSpec(input: Parameters<PublicReleaseHost['deployPrivate']>[0], digest: string) {
		return {
			ingress: 'INGRESS_TRAFFIC_ALL',
			invokerIamDisabled: false,
			labels: {
				[MANAGED_LABEL]: 'true',
				[INSTANCE_LABEL]: this.instance,
				[RELEASE_LABEL]: input.releaseId.toLowerCase(),
			},
			template: {
				serviceAccount: this.config.runtimeServiceAccount,
				scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
				timeout: '300s',
				maxInstanceRequestConcurrency: 24,
				containers: [
					{
						image: `${this.base.host}/${this.targetName}@${digest}`,
						ports: [{ containerPort: 8080 }],
						resources: { limits: { cpu: '1', memory: '1Gi' } },
						startupProbe: {
							httpGet: { path: '/health', port: 8080 },
							initialDelaySeconds: 1,
							periodSeconds: 2,
							failureThreshold: 30,
						},
						env: [
							{ name: 'PUBLIC_DASHBOARD_ORIGIN', value: input.origin },
							{ name: 'PUBLIC_DASHBOARD_RELEASE', value: '/release' },
							{ name: 'PUBLIC_DASHBOARD_ENTRYPOINT', value: input.entrypoint },
							{ name: 'HOME', value: '/tmp' },
							{ name: 'MARIMO_SKIP_UPDATE_CHECK', value: '1' },
							{ name: 'PYTHONDONTWRITEBYTECODE', value: '1' },
						],
					},
				],
			},
		};
	}

	async expose(input: Parameters<PublicReleaseHost['expose']>[0]): Promise<void> {
		const { serviceName, signal } = input;
		this.assertManaged(serviceName, await this.getService(serviceName, signal));
		await this.updatePolicy(
			serviceName,
			(policy) => {
				if (hasPublicInvoker(policy)) return null;
				const bindings = [...(policy.bindings ?? [])];
				const index = bindings.findIndex((b) => b.role === INVOKER_ROLE);
				if (index === -1) bindings.push({ role: INVOKER_ROLE, members: ['allUsers'] });
				else
					bindings[index] = {
						...bindings[index],
						members: [...(bindings[index].members ?? []), 'allUsers'],
					};
				return { ...policy, bindings };
			},
			signal,
		);
		const attempts = this.config.probeAttempts ?? 4;
		let last = '';
		for (let attempt = 0; attempt < attempts; attempt++) {
			const [health, page] = await Promise.all(
				['/health', '/'].map((path) => this.anonymousGet(`${input.origin}${path}`, signal)),
			);
			if ('status' in health && health.status === 200 && 'status' in page && page.status === 200)
				return;
			last = JSON.stringify([health, page]);
			if (attempt + 1 < attempts) await sleep(this.config.probeDelayMs ?? 5_000, signal);
		}
		throw new Error(`The public release did not answer anonymously: ${last}`);
	}

	private async anonymousGet(url: string, signal?: AbortSignal) {
		const timeout = AbortSignal.timeout(30_000);
		try {
			const response = await this.fetchImpl(url, {
				redirect: 'manual',
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			await response.body?.cancel();
			return { status: response.status };
		} catch (error) {
			if (signal?.aborted) throw error;
			return { error: error instanceof Error ? error.name : 'network_error' };
		}
	}

	async revoke(input: Parameters<PublicReleaseHost['revoke']>[0]): Promise<'absent' | 'deleting'> {
		const { serviceName, signal } = input;
		this.assertManaged(serviceName, null);
		const service = await this.getService(serviceName, signal);
		if (!service) return 'absent';
		this.assertManaged(serviceName, service);
		try {
			await this.updatePolicy(
				serviceName,
				(policy) =>
					hasPublicInvoker(policy)
						? {
								...policy,
								bindings: (policy.bindings ?? []).flatMap((binding) => {
									if (binding.role !== INVOKER_ROLE) return [binding];
									const members = (binding.members ?? []).filter((m) => !PUBLIC_MEMBERS.has(m));
									return members.length > 0 ? [{ ...binding, members }] : [];
								}),
							}
						: null,
				signal,
			);
		} catch (error) {
			if (!(error instanceof HttpError && error.status === 404)) throw error;
		}
		try {
			await this.call(`${this.servicesUrl}/${serviceName}`, { method: 'DELETE', signal });
		} catch (error) {
			// 409: an operation (such as creation) is still running; retry after it settles.
			if (!(error instanceof HttpError && (error.status === 404 || error.status === 409)))
				throw error;
		}
		return (await this.getService(serviceName, signal)) ? 'deleting' : 'absent';
	}

	async inspect(serviceName: string, signal?: AbortSignal): Promise<PublicReleaseInspection> {
		const service = await this.getService(serviceName, signal);
		if (!service) return { state: 'absent', publicInvoker: false };
		let publicInvoker: boolean;
		try {
			publicInvoker = hasPublicInvoker(await this.getPolicy(serviceName, signal));
		} catch (error) {
			if (error instanceof HttpError && error.status === 404)
				return { state: 'absent', publicInvoker: false };
			throw error;
		}
		return { state: 'live', publicInvoker, releaseIdLabel: service.labels?.[RELEASE_LABEL] };
	}

	probeAnonymous(origin: string, signal?: AbortSignal) {
		return this.anonymousGet(`${origin}/health`, signal);
	}

	async listManagedServices(signal?: AbortSignal): Promise<ManagedPublicReleaseService[]> {
		const managed: ManagedPublicReleaseService[] = [];
		let pageToken = '';
		do {
			const page = await this.call<{ services?: CloudRunService[]; nextPageToken?: string }>(
				`${this.servicesUrl}?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
				{ signal },
			);
			for (const service of page.services ?? []) {
				const serviceName = service.name?.split('/').pop() ?? '';
				if (
					!serviceName.startsWith(SERVICE_PREFIX) ||
					service.labels?.[MANAGED_LABEL] !== 'true' ||
					service.labels?.[INSTANCE_LABEL] !== this.instance
				)
					continue;
				const inspection = await this.inspect(serviceName, signal);
				if (inspection.state === 'absent') continue;
				managed.push({
					serviceName,
					releaseId: service.labels[RELEASE_LABEL],
					publicInvoker: inspection.publicInvoker,
				});
			}
			pageToken = page.nextPageToken ?? '';
		} while (pageToken);
		return managed;
	}
}
