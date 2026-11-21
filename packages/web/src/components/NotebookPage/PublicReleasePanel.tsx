import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useNotebookVersionsQuery } from '@/api/hooks';
import {
	usePublicReleaseAssetsQuery,
	usePublishPublicRelease,
	useUnpublishPublicRelease,
} from '@/api/publicReleases';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Select } from '@/components/ui/Select';
import { formatBytes } from '@/lib/formatBytes';
import { formatRelative } from '@/lib/time';
import { publicLinkStatus, PUBLIC_RELEASE_LABELS } from './publicReleaseStatus';
import type { PublicLinkReleases, PublicRelease } from './publicReleaseStatus';

export interface PublicReleaseLimits {
	max_assets: number | null;
	max_total_asset_bytes: number | null;
}

export function PublicReleaseBadge({ entry }: { entry: PublicLinkReleases | undefined }) {
	const { label, active, stopping, pending } = publicLinkStatus(entry);
	if (!label) return null;
	const tone = stopping
		? 'bg-destructive/10 text-destructive'
		: pending
			? 'bg-muted text-muted-foreground'
			: active
				? 'bg-primary text-primary-foreground'
				: '';
	return (
		<span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>
	);
}

interface PublicReleasePanelProps {
	projectId: string;
	notebookId: string;
	link: { slug: string; registration_id: string };
	entry: PublicLinkReleases | undefined;
	limits: PublicReleaseLimits;
	appPath: string;
	onClose: () => void;
}

/**
 * Publish, republish or unpublish one app link as a managed public dashboard. Files are
 * opt-in; the user publishes a saved version, never unsaved editor state.
 */
export function PublicReleasePanel({
	projectId,
	notebookId,
	link,
	entry,
	limits,
	appPath,
	onClose,
}: PublicReleasePanelProps) {
	const { active, pending, stopping } = publicLinkStatus(entry);
	const versions = useNotebookVersionsQuery(projectId, notebookId);
	const [chosenVersion, setChosenVersion] = useState<string | null>(null);
	const versionId = chosenVersion ?? versions.data?.[0]?.version_id ?? null;
	const assets = usePublicReleaseAssetsQuery(projectId, notebookId, versionId);
	const [selected, setSelected] = useState<ReadonlyMap<string, string>>(new Map());
	const [approvedSnapshot, setApprovedSnapshot] = useState<string | null>(null);
	const [confirmingStop, setConfirmingStop] = useState(false);
	const publish = usePublishPublicRelease(projectId, notebookId);
	const unpublish = useUnpublishPublicRelease(projectId, notebookId);
	const failed = entry?.releases.find((r) => r.state === 'failed' && r.error);

	const chosen = useMemo(
		() =>
			(assets.data?.assets ?? []).filter(
				(asset) => asset.selectable && selected.get(asset.path) === asset.sha256,
			),
		[assets.data, selected],
	);
	const snapshot = JSON.stringify([versionId, chosen]);
	const acknowledged = approvedSnapshot === snapshot;
	const totalBytes = chosen.reduce((sum, asset) => sum + asset.size_bytes, 0);
	const overLimit =
		(limits.max_assets !== null && chosen.length > limits.max_assets) ||
		(limits.max_total_asset_bytes !== null && totalBytes > limits.max_total_asset_bytes);
	const busy = publish.isPending || unpublish.isPending;
	const canPublish =
		versionId !== null && assets.isSuccess && acknowledged && !overLimit && !pending && !stopping;

	const stop = (release: PublicRelease) => {
		const dashboard = release.state === 'active' || release.activated_at !== undefined;
		unpublish.mutate(release.release_id, {
			onSuccess: ({ confirmed }) => {
				setConfirmingStop(false);
				if (dashboard)
					toast.success(confirmed ? 'Public dashboard stopped' : 'Stopping public dashboard…');
				else toast.success(confirmed ? 'Publish cancelled' : 'Cancelling publish…');
			},
		});
	};

	return (
		<div className="flex flex-col gap-3 rounded-md border p-3">
			<h3 className="text-sm font-medium">
				{active ? 'Manage public dashboard' : 'Publish public dashboard'} · {appPath}
			</h3>
			{stopping && (
				<Callout variant="warning">
					Stopping public access. This finishes when the direct release URL refuses visitors.
					{stopping.error && <p className="mt-1 text-xs">{stopping.error.message}</p>}
					<Button variant="ghost" isDisabled={busy} onPress={() => stop(stopping)} className="mt-2">
						Retry unpublish
					</Button>
				</Callout>
			)}
			{pending && !stopping && (
				<Callout variant="info">
					{PUBLIC_RELEASE_LABELS[pending.state]} The release becomes public once it answers without
					sign-in.
					{pending.error && <p className="mt-1 text-xs">{pending.error.message}</p>}
					<Button variant="ghost" isDisabled={busy} onPress={() => stop(pending)} className="mt-2">
						Cancel publish
					</Button>
				</Callout>
			)}
			{failed && !pending && !stopping && (
				<p role="alert" className="text-sm text-destructive">
					Last publish failed: {failed.error!.message}
				</p>
			)}
			{active && !stopping && (
				<p className="text-xs text-muted-foreground">
					Public since {formatRelative(active.activated_at ?? active.created_at)}. Copy {appPath} to
					share it.
				</p>
			)}
			{!pending && !stopping && (
				<>
					{versions.data && versions.data.length > 0 ? (
						<Select
							label="Saved version"
							value={versionId ?? ''}
							onChange={(value) => {
								setChosenVersion(value);
								setSelected(new Map());
								setApprovedSnapshot(null);
							}}
							options={versions.data.map((version) => ({
								id: version.version_id,
								label: `${formatRelative(version.saved_at)}${version.message ? ` · ${version.message}` : ''}`,
							}))}
						/>
					) : (
						<p className="text-sm text-muted-foreground">
							{versions.isPending ? 'Loading versions…' : 'Save the notebook before publishing.'}
						</p>
					)}
					<p className="text-xs text-muted-foreground">
						Publishing uses the selected saved version, not unsaved editor changes.
					</p>
					{assets.isError && (
						<p role="alert" className="text-sm text-destructive">
							{assets.error.message}
						</p>
					)}
					{assets.data && (
						<fieldset className="flex flex-col gap-1">
							<legend className="text-xs font-medium text-muted-foreground">
								Files to include ({chosen.length}
								{limits.max_assets !== null ? ` / ${limits.max_assets}` : ''} files ·{' '}
								{formatBytes(totalBytes)}
								{limits.max_total_asset_bytes !== null
									? ` / ${formatBytes(limits.max_total_asset_bytes)}`
									: ''}
								)
							</legend>
							{assets.data.assets.length === 0 && (
								<p className="text-xs text-muted-foreground">No workspace files available.</p>
							)}
							<ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
								{assets.data.assets.map((asset) => (
									<li key={asset.path}>
										<label className="flex items-center gap-2 text-sm">
											<input
												type="checkbox"
												aria-label={asset.path}
												checked={asset.selectable && selected.get(asset.path) === asset.sha256}
												disabled={!asset.selectable}
												onChange={(event) => {
													if (!asset.sha256 || !versionId) return;
													const next = new Map(selected);
													if (event.target.checked) next.set(asset.path, asset.sha256);
													else next.delete(asset.path);
													setChosenVersion(versionId);
													setSelected(next);
													setApprovedSnapshot(null);
												}}
											/>
											<span className="min-w-0 flex-1 break-all">{asset.path}</span>
											<span className="shrink-0 text-xs text-muted-foreground">
												{asset.selectable
													? asset.exposure === 'public_http'
														? `Served at /${asset.path}`
														: 'Read-only in Python'
													: 'Too large'}{' '}
												· {formatBytes(asset.size_bytes)}
											</span>
										</label>
									</li>
								))}
							</ul>
						</fieldset>
					)}
					{active && (
						<p className="text-xs text-muted-foreground">
							Current {appPath} stays live until the new release is verified.
						</p>
					)}
					<label className="flex items-start gap-2 text-xs">
						<input
							type="checkbox"
							aria-describedby="public-release-ack"
							aria-label={`Anyone with ${appPath} can view this release`}
							checked={acknowledged}
							onChange={(event) => setApprovedSnapshot(event.target.checked ? snapshot : null)}
						/>
						<span id="public-release-ack">
							Anyone with {appPath} or the direct release URL can view and interact with this saved
							version and the {chosen.length} selected {chosen.length === 1 ? 'file' : 'files'}{' '}
							without signing in. Everything the notebook displays or computes from them becomes
							public, and downloaded copies cannot be recalled. Widgets that use marimo function
							calls or virtual files are not supported.
						</span>
					</label>
					{publish.isError && (
						<p role="alert" className="text-sm text-destructive">
							{publish.error.message}
						</p>
					)}
				</>
			)}
			{confirmingStop && active && !pending && !stopping && (
				<Callout variant="warning">
					Stop public access to {appPath} and shut down its public dashboard? Active anonymous
					viewers will be disconnected.
					<div className="mt-2 flex gap-2">
						<Button variant="danger" isDisabled={busy} onPress={() => stop(active)}>
							{unpublish.isPending ? 'Stopping…' : 'Unpublish'}
						</Button>
						<Button variant="ghost" isDisabled={busy} onPress={() => setConfirmingStop(false)}>
							Keep public
						</Button>
					</div>
				</Callout>
			)}
			{unpublish.isError && (
				<p role="alert" className="text-sm text-destructive">
					{unpublish.error.message}
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				{!pending && !stopping && (
					<Button
						variant="primary"
						isDisabled={!canPublish || busy}
						onPress={() =>
							publish.mutate(
								{
									slug: link.slug,
									registration_id: link.registration_id,
									version_id: versionId!,
									assets: chosen.map(({ path, sha256, size_bytes }) => ({
										path,
										sha256: sha256!,
										size_bytes,
									})),
								},
								{
									onSuccess: () => {
										setApprovedSnapshot(null);
										toast.success('Publishing started');
									},
								},
							)
						}
					>
						{publish.isPending ? 'Publishing…' : active ? 'Republish' : 'Publish'}
					</Button>
				)}
				{active && !pending && !stopping && !confirmingStop && (
					<Button variant="danger" isDisabled={busy} onPress={() => setConfirmingStop(true)}>
						Unpublish…
					</Button>
				)}
				<Button variant="ghost" isDisabled={busy} onPress={onClose}>
					Close
				</Button>
			</div>
		</div>
	);
}
