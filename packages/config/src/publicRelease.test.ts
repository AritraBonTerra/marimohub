import { describe, expect, it } from 'vitest';
import { ConfigError } from './errors';
import { makePublicReleases } from './publicRelease';

const RUNTIME_SA = 'mh-public-runtime@proj.iam.gserviceaccount.com';
const env = (overrides: Record<string, string | undefined> = {}) => ({
	MARIMOHUB_PUBLIC_RELEASE_BACKEND: 'gcp-cloud-run',
	MARIMOHUB_PUBLIC_RELEASE_GCP_PROJECT_ID: 'proj',
	MARIMOHUB_PUBLIC_RELEASE_GCP_PROJECT_NUMBER: '123',
	MARIMOHUB_PUBLIC_RELEASE_GCP_REGION: 'us-west1',
	MARIMOHUB_PUBLIC_RELEASE_GCP_AR_REPO: 'releases',
	MARIMOHUB_PUBLIC_RELEASE_GCP_BASE_IMAGE: `us-west1-docker.pkg.dev/proj/releases/base@sha256:${'a'.repeat(64)}`,
	MARIMOHUB_PUBLIC_RELEASE_GCP_RUNTIME_SA: RUNTIME_SA,
	MARIMOHUB_PUBLIC_RELEASE_GCP_INSTANCE: 'acme-marimohub',
	...overrides,
});
const key = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({ client_email: 'pub@proj.iam.gserviceaccount.com', private_key: 'x', ...extra });

function configError(run: () => unknown): ConfigError {
	try {
		run();
	} catch (error) {
		if (error instanceof ConfigError) return error;
		throw error;
	}
	throw new Error('expected a ConfigError');
}

describe('makePublicReleases', () => {
	it('builds the Cloud Run host without contacting Google', () => {
		const result = makePublicReleases(env(), {
			fetch: () => Promise.reject(new Error('no network at startup')),
		});
		expect(result?.host.hostSuffix).toBe('-123.us-west1.run.app');
	});

	it('requires an explicit installation id before it can delete services', () => {
		expect(
			configError(() =>
				makePublicReleases(env({ MARIMOHUB_PUBLIC_RELEASE_GCP_INSTANCE: undefined })),
			).opts.variable,
		).toBe('MARIMOHUB_PUBLIC_RELEASE_GCP_INSTANCE');
	});

	it('rejects a publisher key that is the runtime account, ignoring case', () => {
		const serviceAccountKey = key({ client_email: RUNTIME_SA.toUpperCase() });
		expect(
			configError(() =>
				makePublicReleases(env({ MARIMOHUB_PUBLIC_RELEASE_GCP_SA_KEY: serviceAccountKey })),
			).opts.variable,
		).toBe('MARIMOHUB_PUBLIC_RELEASE_GCP_RUNTIME_SA');
	});

	it('rejects a publisher key that sends its assertion to another token endpoint', () => {
		const serviceAccountKey = key({ token_uri: 'https://tokens.example.com/token' });
		expect(
			configError(() =>
				makePublicReleases(env({ MARIMOHUB_PUBLIC_RELEASE_GCP_SA_KEY: serviceAccountKey })),
			).opts.variable,
		).toBe('MARIMOHUB_PUBLIC_RELEASE_GCP_SA_KEY');
	});
});
