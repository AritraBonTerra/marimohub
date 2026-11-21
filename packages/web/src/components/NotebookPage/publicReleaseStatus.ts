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

const TERMINAL = new Set<PublicRelease['state']>(['unpublished', 'failed']);

/** A head-pending release is never public yet, even once its record reads `active`. */
export function pendingLabel(release: PublicRelease): string {
	return release.state === 'active'
		? PUBLIC_RELEASE_LABELS.exposing
		: PUBLIC_RELEASE_LABELS[release.state];
}

/**
 * Status of one app link, keyed by the registration head: only the head's active and
 * pending releases describe the link. Older releases still shutting down (superseded or
 * abandoned) are `retiring` and never hide the live release's controls.
 */
export function publicLinkStatus(entry: PublicLinkReleases | undefined) {
	const releases = entry?.releases ?? [];
	const byId = (id: string | null | undefined) =>
		id ? releases.find((r) => r.release_id === id) : undefined;
	const head = byId(entry?.active_release_id);
	const next =
		entry?.pending_release_id !== entry?.active_release_id
			? byId(entry?.pending_release_id)
			: undefined;
	const active = head?.state === 'active' && !head.withdraw_requested ? head : undefined;
	// Core marks a candidate `active` before the head hands over, so it is still pending here.
	const pending =
		next && next.state !== 'unpublishing' && !TERMINAL.has(next.state) && !next.withdraw_requested
			? next
			: undefined;
	// The head's own releases being withdrawn: the live one, or a cancelled replacement.
	const stopping = head?.state === 'unpublishing' ? head : undefined;
	const cancelling = next?.state === 'unpublishing' ? next : undefined;
	const retiring = releases.filter((r) => !TERMINAL.has(r.state) && r !== head && r !== next);
	const shown = stopping ?? pending ?? active ?? cancelling;
	return {
		active,
		pending,
		stopping,
		cancelling,
		retiring,
		label: shown
			? shown === pending
				? pendingLabel(shown)
				: PUBLIC_RELEASE_LABELS[shown.state]
			: null,
		/** Unpublish before removing: any live release still owns this registration. */
		locked: Boolean(shown) || retiring.length > 0,
	};
}
