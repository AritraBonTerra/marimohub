/**
 * Hosts immutable public dashboard releases on an origin isolated from the hub.
 * `PublicReleaseService` drives it through private deploy, exposure and revocation;
 * every method must be idempotent because a step can be retried after a crash.
 */
export interface PublicReleaseBundleFile {
	/** Normalized path inside the release directory. */
	path: string;
	bytes: Uint8Array;
	sha256: string;
}

export type PublicReleaseDeployResult =
	| { status: 'ready'; imageDigest: string; buildId?: string }
	| { status: 'in_progress'; imageDigest?: string; buildId?: string };

export interface PublicReleaseInspection {
	state: 'live' | 'absent';
	publicInvoker: boolean;
	releaseIdLabel?: string;
}

export interface ManagedPublicReleaseService {
	serviceName: string;
	releaseId?: string;
	publicInvoker: boolean;
}

/**
 * A host error that retrying cannot fix (for example a failed revision). The service
 * withdraws the release instead of retrying until its deadline.
 */
export class PublicReleaseHostFatalError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'PublicReleaseHostFatalError';
	}
}

export interface PublicReleaseHost {
	readonly kind: string;
	/** Suffix after the service name in the release origin, e.g. `-123.us-west1.run.app`. */
	readonly hostSuffix: string;
	/** Normalized distribution names baked into the runtime image, or null when unknown. */
	getInstalledPackages?(signal?: AbortSignal): Promise<ReadonlySet<string> | null>;
	/**
	 * Package the bundle and create a private service with no public invoker. Repeated calls
	 * for the same service poll it; `files` is read only when packaging is still needed.
	 */
	deployPrivate(input: {
		releaseId: string;
		serviceName: string;
		origin: string;
		entrypoint: string;
		files: () => Promise<readonly PublicReleaseBundleFile[]>;
		imageDigest?: string;
		buildId?: string;
		signal?: AbortSignal;
	}): Promise<PublicReleaseDeployResult>;
	/** Grant anonymous invocation, then require anonymous `/health` and `/` to return 200. */
	expose(input: {
		releaseId: string;
		serviceName: string;
		origin: string;
		signal?: AbortSignal;
	}): Promise<void>;
	/** Remove anonymous invocation and delete the service. `absent` means the host confirmed it is gone. */
	revoke(input: {
		releaseId: string;
		serviceName: string;
		signal?: AbortSignal;
	}): Promise<'absent' | 'deleting'>;
	inspect(serviceName: string, signal?: AbortSignal): Promise<PublicReleaseInspection>;
	/** Unauthenticated GET `<origin>/health`. */
	probeAnonymous(
		origin: string,
		signal?: AbortSignal,
	): Promise<{ status: number } | { error: string }>;
	/** Services carrying the managed label, for orphan sweeps. */
	listManagedServices(signal?: AbortSignal): Promise<readonly ManagedPublicReleaseService[]>;
}
