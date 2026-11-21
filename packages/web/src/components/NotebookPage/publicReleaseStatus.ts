import type { components } from '@marimo-hub/client';

export type PublicRelease = components['schemas']['PublicRelease'];

export interface PublicLinkReleases {
	registration_id: string;
	slug: string;
	active_release_id: string | null;
	pending_release_id: string | null;
	releases: PublicRelease[];
}

export const PUBLIC_RELEASE_LABELS: Record<PublicRelease['state'], string> = {
	publishing: 'Deploying…',
	exposing: 'Verifying…',
	active: 'Public',
	unpublishing: 'Stopping…',
	unpublished: 'Private',
	failed: 'Failed',
};

/** In-flight work takes precedence over the live release in the app link row. */
export function publicLinkStatus(entry: PublicLinkReleases | undefined) {
	const releases = entry?.releases ?? [];
	const stopping = releases.find((r) => r.state === 'unpublishing');
	const pending = releases.find((r) => r.state === 'publishing' || r.state === 'exposing');
	const active = releases.find((r) => r.state === 'active');
	const shown = stopping ?? pending ?? active;
	return {
		active,
		pending,
		stopping,
		label: shown ? PUBLIC_RELEASE_LABELS[shown.state] : null,
		/** Unpublish before removing: a live release still owns this registration. */
		locked: Boolean(shown),
	};
}
