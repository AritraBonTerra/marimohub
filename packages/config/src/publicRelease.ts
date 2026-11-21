import { CloudRunPublicReleaseHost, googleAccessToken } from '@marimo-hub/publish-cloudrun';
import type { PublicReleaseHost, PublicReleaseLimits } from '@marimo-hub/core';
import { parseEnum, parseIntEnv, requiredVar } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';

const DOCS = 'docs/configuration.md#managed-public-releases';

function limit(env: Env, key: string): number | undefined {
	const value = parseIntEnv(env, key);
	if (value !== undefined && value <= 0)
		throw new ConfigError(`${key} must be a positive integer`, { variable: key, docs: DOCS });
	return value;
}

function publisherEmail(key: string): unknown {
	try {
		const parsed: unknown = JSON.parse(key);
		return typeof parsed === 'object' && parsed !== null && 'client_email' in parsed
			? parsed.client_email
			: undefined;
	} catch {
		throw new ConfigError(
			'MARIMOHUB_PUBLIC_RELEASE_GCP_SA_KEY must be a service account key JSON',
			{
				variable: 'MARIMOHUB_PUBLIC_RELEASE_GCP_SA_KEY',
				docs: DOCS,
			},
		);
	}
}

/**
 * Managed public dashboard publishing. Unset leaves the hub in manual or disabled
 * public-link mode; the host is never contacted until a release is published.
 */
export function makePublicReleases(
	env: Env,
	options: { fetch?: typeof fetch } = {},
): { host: PublicReleaseHost; limits: Partial<PublicReleaseLimits> } | undefined {
	const backend = parseEnum(env, 'MARIMOHUB_PUBLIC_RELEASE_BACKEND', {
		allowed: ['gcp-cloud-run'] as const,
		offValues: ['off', 'none'],
		docs: DOCS,
	});
	if (!backend) return undefined;
	const need = (key: string, remediation: string) =>
		requiredVar(env, key, { remediation, docs: DOCS });
	const projectNumber = need(
		'MARIMOHUB_PUBLIC_RELEASE_GCP_PROJECT_NUMBER',
		'Set it to the numeric ID of the project that hosts public dashboards.',
	);
	if (!/^\d+$/.test(projectNumber))
		throw new ConfigError('MARIMOHUB_PUBLIC_RELEASE_GCP_PROJECT_NUMBER must be digits only', {
			variable: 'MARIMOHUB_PUBLIC_RELEASE_GCP_PROJECT_NUMBER',
			docs: DOCS,
		});
	const region = need('MARIMOHUB_PUBLIC_RELEASE_GCP_REGION', 'Set it to a Cloud Run region.');
	if (!/^[a-z]+-[a-z]+\d+$/.test(region))
		throw new ConfigError(`Invalid MARIMOHUB_PUBLIC_RELEASE_GCP_REGION: ${region}`, {
			variable: 'MARIMOHUB_PUBLIC_RELEASE_GCP_REGION',
			docs: DOCS,
		});
	const runtimeServiceAccount = need(
		'MARIMOHUB_PUBLIC_RELEASE_GCP_RUNTIME_SA',
		'Set it to a dedicated service account with no IAM grants.',
	);
	const serviceAccountKey = env.MARIMOHUB_PUBLIC_RELEASE_GCP_SA_KEY;
	if (serviceAccountKey && publisherEmail(serviceAccountKey) === runtimeServiceAccount)
		throw new ConfigError('The public runtime service account must differ from the publisher', {
			variable: 'MARIMOHUB_PUBLIC_RELEASE_GCP_RUNTIME_SA',
			docs: DOCS,
		});
	const instance = env.MARIMOHUB_PUBLIC_RELEASE_GCP_INSTANCE ?? 'default';
	if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(instance))
		throw new ConfigError('MARIMOHUB_PUBLIC_RELEASE_GCP_INSTANCE must be a Cloud Run label value', {
			variable: 'MARIMOHUB_PUBLIC_RELEASE_GCP_INSTANCE',
			docs: DOCS,
		});
	let host: CloudRunPublicReleaseHost;
	try {
		host = new CloudRunPublicReleaseHost({
			projectId: need('MARIMOHUB_PUBLIC_RELEASE_GCP_PROJECT_ID', 'Set it to the GCP project ID.'),
			projectNumber,
			region,
			repository: need(
				'MARIMOHUB_PUBLIC_RELEASE_GCP_AR_REPO',
				'Set it to the Artifact Registry repository for release images.',
			),
			baseImage: need(
				'MARIMOHUB_PUBLIC_RELEASE_GCP_BASE_IMAGE',
				'Set it to the digest-pinned public dashboard base image.',
			),
			runtimeServiceAccount,
			instance,
			getToken: googleAccessToken({ serviceAccountKey, fetch: options.fetch }),
			fetch: options.fetch,
		});
	} catch (error) {
		if (error instanceof ConfigError) throw error;
		throw new ConfigError(
			`Invalid MARIMOHUB_PUBLIC_RELEASE_GCP_BASE_IMAGE: ${error instanceof Error ? error.message : ''}`,
			{ variable: 'MARIMOHUB_PUBLIC_RELEASE_GCP_BASE_IMAGE', docs: DOCS },
		);
	}
	const manualSuffix = env.MARIMOHUB_PUBLIC_APP_RELEASE_HOST_SUFFIX;
	if (manualSuffix && manualSuffix !== host.hostSuffix)
		throw new ConfigError(
			`MARIMOHUB_PUBLIC_APP_RELEASE_HOST_SUFFIX must be ${host.hostSuffix} or unset with managed publishing`,
			{ variable: 'MARIMOHUB_PUBLIC_APP_RELEASE_HOST_SUFFIX', docs: DOCS },
		);
	return {
		host,
		limits: {
			maxLiveReleases: limit(env, 'MARIMOHUB_PUBLIC_RELEASE_MAX_LIVE'),
			maxAssets: limit(env, 'MARIMOHUB_PUBLIC_RELEASE_MAX_ASSETS'),
			maxAssetBytes: limit(env, 'MARIMOHUB_PUBLIC_RELEASE_MAX_ASSET_BYTES'),
			maxTotalAssetBytes: limit(env, 'MARIMOHUB_PUBLIC_RELEASE_MAX_TOTAL_ASSET_BYTES'),
		},
	};
}
