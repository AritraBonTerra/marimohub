import type {
	ManagedPublicReleaseService,
	PublicReleaseBundleFile,
	PublicReleaseHost,
	PublicReleaseInspection,
} from '../ports/publicReleaseHost';

interface FakeService {
	releaseId: string;
	origin: string;
	ready: boolean;
	polls: number;
	publicInvoker: boolean;
	deleting: boolean;
	files: readonly PublicReleaseBundleFile[];
}

type HostMethod = 'deployPrivate' | 'expose' | 'revoke' | 'inspect' | 'probeAnonymous';

/**
 * In-memory `PublicReleaseHost`. Services become ready after `pollsUntilReady` deploy
 * calls, deletion completes after `pollsUntilDeleted` revokes, and `hooks` let tests pause
 * or fail a call to model races and outages.
 */
export class FakePublicReleaseHost implements PublicReleaseHost {
	readonly kind = 'fake';
	readonly services = new Map<string, FakeService>();
	readonly calls: { method: HostMethod; serviceName: string }[] = [];
	installedPackages: ReadonlySet<string> | null = null;
	pollsUntilReady = 0;
	pollsUntilDeleted = 0;
	/** Runs before a call's effect; throw to fail it or await to delay it. */
	hooks: Partial<Record<HostMethod, (serviceName: string) => Promise<void> | void>> = {};
	/** Override the anonymous probe result. */
	probe?: (origin: string) => { status: number } | { error: string };
	private deletePolls = new Map<string, number>();

	constructor(readonly hostSuffix = '-123456.us-west1.run.app') {}

	private async enter(method: HostMethod, serviceName: string) {
		this.calls.push({ method, serviceName });
		await this.hooks[method]?.(serviceName);
	}

	async getInstalledPackages() {
		return this.installedPackages;
	}

	async deployPrivate(input: Parameters<PublicReleaseHost['deployPrivate']>[0]) {
		await this.enter('deployPrivate', input.serviceName);
		let service = this.services.get(input.serviceName);
		if (!service || service.deleting) {
			service = {
				releaseId: input.releaseId,
				origin: input.origin,
				ready: false,
				polls: 0,
				publicInvoker: false,
				deleting: false,
				files: await input.files(),
			};
			this.services.set(input.serviceName, service);
		}
		service.polls++;
		if (service.polls > this.pollsUntilReady) service.ready = true;
		const imageDigest = `sha256:${input.releaseId.toLowerCase().padEnd(64, '0').slice(0, 64)}`;
		return service.ready
			? { status: 'ready' as const, imageDigest }
			: { status: 'in_progress' as const, imageDigest };
	}

	async expose(input: Parameters<PublicReleaseHost['expose']>[0]) {
		await this.enter('expose', input.serviceName);
		const service = this.services.get(input.serviceName);
		if (!service?.ready) throw new Error('Service is not ready');
		service.publicInvoker = true;
	}

	async revoke(input: Parameters<PublicReleaseHost['revoke']>[0]) {
		await this.enter('revoke', input.serviceName);
		const service = this.services.get(input.serviceName);
		if (!service) return 'absent' as const;
		service.publicInvoker = false;
		service.deleting = true;
		const polls = (this.deletePolls.get(input.serviceName) ?? 0) + 1;
		this.deletePolls.set(input.serviceName, polls);
		if (polls > this.pollsUntilDeleted) {
			this.services.delete(input.serviceName);
			this.deletePolls.delete(input.serviceName);
			return 'absent' as const;
		}
		return 'deleting' as const;
	}

	async inspect(serviceName: string): Promise<PublicReleaseInspection> {
		await this.enter('inspect', serviceName);
		const service = this.services.get(serviceName);
		return service
			? {
					state: 'live',
					publicInvoker: service.publicInvoker,
					releaseIdLabel: service.releaseId.toLowerCase(),
				}
			: { state: 'absent', publicInvoker: false };
	}

	async probeAnonymous(origin: string) {
		await this.enter('probeAnonymous', origin);
		if (this.probe) return this.probe(origin);
		const service = [...this.services.values()].find((s) => s.origin === origin);
		if (!service) return { status: 404 };
		return { status: service.publicInvoker && service.ready ? 200 : 403 };
	}

	async listManagedServices(): Promise<ManagedPublicReleaseService[]> {
		return [...this.services.entries()].map(([serviceName, service]) => ({
			serviceName,
			releaseId: service.releaseId.toLowerCase(),
			publicInvoker: service.publicInvoker,
		}));
	}

	called(method: HostMethod): number {
		return this.calls.filter((call) => call.method === method).length;
	}
}
