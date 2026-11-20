import { useState } from 'react';
import { DeepLinkSlugSchema } from '@marimo-hub/core/deep-link-slug';
import { Copy, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useDeepLinksQuery, useRegisterDeepLink, useReleaseDeepLink } from '@/api/deepLinks';
import { Button } from '@/components/ui/Button';
import { DialogModal } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { TextField } from '@/components/ui/TextField';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { withBasePath } from '@/lib/basePath';
import { shareableNotebookQuery } from '@/lib/notebookUrls';

interface AppLinksDialogProps {
	projectId: string;
	notebookId: string;
	canManage: boolean;
	search?: string;
	onClose: () => void;
}

export function AppLinksDialog({
	projectId,
	notebookId,
	canManage,
	search = '',
	onClose,
}: AppLinksDialogProps) {
	const query = shareableNotebookQuery(search).toString();
	const pathFor = (slug: string) => withBasePath(`/app/${slug}${query ? `?${query}` : ''}`);
	const urlFor = (slug: string) => new URL(pathFor(slug), window.location.origin).toString();
	const links = useDeepLinksQuery(projectId, notebookId);
	const currentLinks = links.isFetchedAfterMount && !links.isError ? links.data : undefined;
	const register = useRegisterDeepLink(projectId, notebookId);
	const release = useReleaseDeepLink(projectId, notebookId);
	const { copy } = useCopyToClipboard();
	const [slug, setSlug] = useState('');
	const [selected, setSelected] = useState<{ slug: string; registration_id: string } | null>(null);
	const [origin, setOrigin] = useState('');
	const publication = useRegisterDeepLink(projectId, notebookId);
	const canonicalSlug = slug.trim().toLowerCase();
	const valid = DeepLinkSlugSchema.safeParse(canonicalSlug).success;
	const pending = register.isPending || release.isPending;

	return (
		<DialogModal isOpen onClose={onClose} title="App links" width="lg">
			<div className="flex flex-col gap-4">
				<p className="text-sm text-muted-foreground">
					Published app links open without sign-in. Other app links require notebook access.
				</p>
				{!links.isError && !links.isFetchedAfterMount && (
					<output className="text-sm">Loading links…</output>
				)}
				{links.isError && (
					<div role="alert" className="text-sm text-destructive">
						{links.error.message}{' '}
						<Button variant="ghost" onPress={() => void links.refetch()}>
							Try again
						</Button>
					</div>
				)}
				{currentLinks?.length === 0 && (
					<p className="text-sm text-muted-foreground">No app links yet.</p>
				)}
				<ul className="flex flex-col gap-2">
					{currentLinks?.map((link) => (
						<li
							key={link.registration_id}
							className="flex items-center gap-2 rounded-md border p-2"
						>
							<a
								href={pathFor(link.slug)}
								className="min-w-0 flex-1 break-all text-sm text-primary underline"
							>
								{urlFor(link.slug)}
							</a>
							<IconButton
								label={`Copy ${link.slug}`}
								onPress={() =>
									void copy(urlFor(link.slug)).then(
										(copied) => copied && toast.success('App link copied'),
									)
								}
							>
								<Copy className="size-4" />
							</IconButton>
							{canManage && (
								<Button
									variant="ghost"
									isDisabled={publication.isPending}
									onPress={() => {
										publication.reset();
										setSelected(link);
										setOrigin(link.public_origin ?? '');
									}}
								>
									{link.public_origin ? 'Manage publication' : 'Publish'}
								</Button>
							)}
							{canManage && (
								<IconButton
									label={`Remove ${link.slug}`}
									isDisabled={pending}
									onPress={() =>
										release.mutate(link, { onSuccess: () => toast.success('App link removed') })
									}
								>
									<Trash2 className="size-4" />
								</IconButton>
							)}
						</li>
					))}
				</ul>
				{canManage && selected && (
					<form
						className="flex flex-col gap-2 rounded-md border p-3"
						onSubmit={(event) => {
							event.preventDefault();
							if (!origin.trim() || publication.isPending) return;
							publication.mutate(
								{
									slug: selected.slug,
									publication: {
										registration_id: selected.registration_id,
										origin: origin.trim().replace(/\/$/, ''),
									},
								},
								{
									onSuccess: () => {
										setSelected(null);
										toast.success('App link published');
									},
								},
							);
						}}
					>
						<TextField label="Public release URL" value={origin} onChange={setOrigin} />
						<p className="text-xs text-muted-foreground">
							Enter the URL of your deployed, read-only release. Anyone with this app link can open
							it. The direct release URL stays public until access is removed in Cloud Run.
						</p>
						{publication.isError && (
							<p role="alert" className="text-sm text-destructive">
								{publication.error.message}
							</p>
						)}
						<div className="flex gap-2">
							<Button type="submit" isDisabled={!origin.trim() || publication.isPending}>
								Publish link
							</Button>
							{currentLinks?.some(
								(link) => link.registration_id === selected.registration_id && link.public_origin,
							) && (
								<Button
									variant="ghost"
									isDisabled={publication.isPending}
									onPress={() =>
										publication.mutate(
											{
												slug: selected.slug,
												publication: { registration_id: selected.registration_id, origin: null },
											},
											{
												onSuccess: () => {
													setSelected(null);
													toast.success('Public release disconnected');
												},
											},
										)
									}
								>
									Disconnect public release
								</Button>
							)}
							<Button
								variant="ghost"
								isDisabled={publication.isPending}
								onPress={() => setSelected(null)}
							>
								Cancel
							</Button>
						</div>
					</form>
				)}
				{canManage && (
					<>
						<p className="text-xs text-muted-foreground">
							Removing a link makes its name available immediately. Old shared URLs may then open
							another app. Running apps and notebook permissions are unaffected.
						</p>
						<form
							className="flex flex-col gap-3 border-t pt-4"
							onSubmit={(event) => {
								event.preventDefault();
								if (!valid || pending) return;
								register.mutate(canonicalSlug, {
									onSuccess: () => {
										setSlug('');
										toast.success('App link created');
									},
								});
							}}
						>
							<TextField
								label="App slug"
								value={slug}
								onChange={(value) => {
									setSlug(value);
									register.reset();
								}}
								placeholder="team/overview"
								maxLength={63}
								isDisabled={pending}
							/>
							<p className="text-xs text-muted-foreground">
								Use letters, digits, and hyphens, with / between segments. Start and end each
								segment with a letter or digit. Maximum 63 characters. Names are shared across this
								hub.
							</p>
							{valid && (
								<p className="break-all text-xs text-muted-foreground">{urlFor(canonicalSlug)}</p>
							)}
							{register.isError && (
								<p role="alert" className="text-sm text-destructive">
									{register.error.message}
								</p>
							)}
							<Button type="submit" isDisabled={!valid || pending}>
								{register.isPending ? 'Creating…' : 'Create app link'}
							</Button>
						</form>
					</>
				)}
			</div>
		</DialogModal>
	);
}
