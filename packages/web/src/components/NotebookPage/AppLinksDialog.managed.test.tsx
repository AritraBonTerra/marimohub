import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { publicReleaseKeys } from '@/api/publicReleases';
import { renderWithClient, setupUser } from '@/test/render';
import { AppLinksDialog } from './AppLinksDialog';

const link = { slug: 'sales', registration_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' };
const release = {
	release_id: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
	slug: 'sales',
	registration_id: link.registration_id,
	version_id: 'v2',
	entrypoint: 'notebook.py',
	code_sha256: 'c'.repeat(64),
	assets: [],
	origin: 'https://marimo-public-01arz-123.us-west1.run.app',
	withdraw_requested: false,
	created_by: 'user_1',
	created_at: '2026-11-20T00:00:00Z',
	updated_at: '2026-11-20T00:00:00Z',
};
const ok = (data: unknown, status = 200) =>
	new Response(JSON.stringify({ success: true, data }), {
		status,
		headers: { 'content-type': 'application/json' },
	});

type Entry = {
	active_release_id: string | null;
	pending_release_id: string | null;
	releases: (typeof release & { state: string })[];
};

function setup(
	mode: 'managed' | 'manual' | 'disabled',
	options: {
		labeled?: boolean;
		canPublish?: boolean;
		canEmergencyUnpublish?: boolean;
		truncated?: boolean;
		/** Fixed release list, instead of one release following `state`. */
		entry?: Entry;
		publicOrigin?: string;
	} = {},
) {
	let state: string | null = null;
	let chartHash = 'b'.repeat(64);
	const posts: { path: string; body: unknown }[] = [];
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(
			input instanceof Request ? input.url : String(input),
			window.location.origin,
		);
		const path = url.pathname;
		if (init?.method === 'POST') {
			posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
			if (path.endsWith('/deep-links')) return ok({ ...link, public_origin: null });
			if (path.endsWith('/unpublish')) {
				state = 'unpublishing';
				return ok({ ...release, state }, 202);
			}
			state = 'publishing';
			return ok({ ...release, state }, 202);
		}
		if (path.endsWith('/capabilities'))
			return ok({
				public_app_links: {
					available: mode !== 'disabled',
					mode,
					max_live_releases: 5,
					max_assets: 50,
					max_asset_bytes: 26214400,
					max_total_asset_bytes: 52428800,
				},
			});
		if (path.endsWith('/versions'))
			return ok({
				items: [
					{
						version_id: 'v2',
						notebook_id: 'nb-1',
						saved_at: '2026-11-20T00:00:00Z',
						author: 'u',
						message: 'final',
						parent_id: 'v1',
					},
					{
						version_id: 'v1',
						notebook_id: 'nb-1',
						saved_at: '2026-11-19T00:00:00Z',
						author: 'u',
						message: '',
						parent_id: null,
					},
				],
				next_cursor: null,
			});
		if (path.endsWith('/public-releases/assets')) {
			if (options.labeled)
				return new Response(
					JSON.stringify({
						success: false,
						error: {
							code: 'FORBIDDEN',
							message: 'Notebooks with security labels cannot be published publicly',
						},
					}),
					{ status: 403, headers: { 'content-type': 'application/json' } },
				);
			return ok({
				version_id: url.searchParams.get('version_id'),
				entrypoint: 'notebook.py',
				assets: [
					{
						path: 'data/table.csv',
						size_bytes: 10,
						sha256: 'a'.repeat(64),
						exposure: 'runtime_only',
						selectable: true,
					},
					{
						path: 'public/chart.png',
						size_bytes: 20,
						sha256: chartHash,
						exposure: 'public_http',
						selectable: true,
					},
				],
				...(options.truncated ? { truncated: true } : {}),
			});
		}
		if (path.endsWith('/public-releases') && options.entry)
			return ok([{ ...link, ...options.entry }]);
		if (path.endsWith('/public-releases'))
			return ok([
				{
					...link,
					// The head keeps naming the live release while it is withdrawn.
					active_release_id:
						state === 'active' || state === 'unpublishing' ? release.release_id : null,
					pending_release_id: state === 'publishing' ? release.release_id : null,
					releases: state ? [{ ...release, state }] : [],
				},
			]);
		return ok([{ ...link, public_origin: options.publicOrigin ?? null }]);
	});
	vi.stubGlobal('fetch', fetch);
	const { client } = renderWithClient(
		<AppLinksDialog
			projectId="proj-1"
			notebookId="nb-1"
			canManage
			canPublish={options.canPublish ?? true}
			canEmergencyUnpublish={options.canEmergencyUnpublish ?? false}
			onClose={() => {}}
		/>,
		{ toaster: true },
	);
	return {
		client,
		posts,
		fetch,
		setState: (next: string | null) => {
			state = next;
		},
		refreshChart: (hash: string) => {
			chartHash = hash;
			return client.invalidateQueries({
				queryKey: publicReleaseKeys.assets('proj-1', 'nb-1', 'v2'),
			});
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AppLinksDialog managed publishing', () => {
	it('hides publishing when public links are disabled', async () => {
		setup('disabled');
		await screen.findByRole('button', { name: 'Copy sales' });
		await waitFor(() =>
			expect(screen.getByText('App links require notebook access.')).toBeInTheDocument(),
		);
		expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
	});

	it('keeps the manual release URL form in manual mode', async () => {
		const user = setupUser();
		setup('manual');
		await user.click(await screen.findByRole('button', { name: 'Publish' }));
		expect(screen.getByRole('textbox', { name: 'Public release URL' })).toBeInTheDocument();
	});

	it('lets a manager copy links while reserving managed publishing for the owner', async () => {
		const { client } = setup('managed', { canPublish: false });
		await screen.findByRole('button', { name: 'Copy sales' });
		await waitFor(() =>
			expect(client.getQueryState(publicReleaseKeys.list('proj-1', 'nb-1'))?.status).toBe(
				'success',
			),
		);
		expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
	});

	it('publishes the chosen version with only the files the user checked', async () => {
		const user = setupUser();
		const { posts } = setup('managed');
		await user.click(await screen.findByRole('button', { name: 'Publish' }));
		const csv = await screen.findByRole('checkbox', { name: /data\/table\.csv/ });
		const png = screen.getByRole('checkbox', { name: /public\/chart\.png/ });
		expect(csv).not.toBeChecked();
		expect(png).not.toBeChecked();
		expect(screen.getByText(/Served at \/public\/chart\.png/)).toBeInTheDocument();
		expect(screen.getByText(/Read-only in Python/)).toBeInTheDocument();
		await user.click(png);
		expect(screen.getAllByRole('button', { name: 'Publish' }).at(-1)).toBeDisabled();
		await user.click(screen.getByRole('checkbox', { name: /Anyone with \/app\/sales/ }));
		await user.click(screen.getAllByRole('button', { name: 'Publish' }).at(-1)!);
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]).toEqual({
			path: '/api/v1/projects/proj-1/notebooks/nb-1/public-releases',
			body: {
				slug: 'sales',
				registration_id: link.registration_id,
				version_id: 'v2',
				assets: [{ path: 'public/chart.png', sha256: 'b'.repeat(64), size_bytes: 20 }],
			},
		});
		expect(await screen.findByText('Deploying…', { selector: 'span' })).toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: 'Unpublish sales before removing it' }),
		).toBeDisabled();
	});

	it('explains why a labeled notebook cannot be published', async () => {
		const user = setupUser();
		setup('managed', { labeled: true });
		await user.click(await screen.findByRole('button', { name: 'Publish' }));
		expect(
			await screen.findByText('Notebooks with security labels cannot be published publicly'),
		).toBeInTheDocument();
		await user.click(screen.getByRole('checkbox', { name: /Anyone with/ }));
		expect(screen.getAllByRole('button', { name: 'Publish' }).at(-1)).toBeDisabled();
	});

	it('requires renewed approval when a selected file changes during review', async () => {
		const user = setupUser();
		const { posts, refreshChart } = setup('managed');
		await user.click(await screen.findByRole('button', { name: 'Publish' }));
		const chart = await screen.findByRole('checkbox', { name: 'public/chart.png' });
		const approval = screen.getByRole('checkbox', { name: /Anyone with/ });
		const submit = screen.getAllByRole('button', { name: 'Publish' }).at(-1)!;
		await user.click(chart);
		await user.click(approval);
		expect(submit).toBeEnabled();

		await act(() => refreshChart('c'.repeat(64)));
		await waitFor(() => expect(chart).not.toBeChecked());
		expect(approval).not.toBeChecked();
		expect(submit).toBeDisabled();
		expect(posts).toHaveLength(0);
	});

	it('confirms before unpublishing and shows Stopping until revocation finishes', async () => {
		const user = setupUser();
		const { posts, setState } = setup('managed');
		setState('active');
		await user.click(await screen.findByRole('button', { name: 'Manage publication' }));
		expect(screen.getByText('Public', { selector: 'span' })).toBeInTheDocument();
		expect(screen.getByText(/stays live until the new release is verified/)).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Unpublish…' }));
		const confirm = screen.getByText(/Active anonymous viewers will be disconnected/);
		await user.click(
			within(confirm.closest('[role="status"]')!).getByRole('button', {
				name: 'Unpublish',
			}),
		);
		await waitFor(() => expect(posts.at(-1)?.path).toMatch(/\/unpublish$/));
		expect(await screen.findByRole('button', { name: 'Retry unpublish' })).toBeInTheDocument();
		expect(screen.getByText('Stopping…', { selector: 'span' })).toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: 'Unpublish sales before removing it' }),
		).toBeDisabled();
	});
	it('keeps Unpublish for the live release while an older release retires', async () => {
		const user = setupUser();
		const older = { ...release, release_id: '01ARZ3NDEKTSV4RRFFQ69G5FA0', state: 'unpublishing' };
		const live = { ...release, state: 'active' };
		setup('managed', {
			entry: {
				active_release_id: live.release_id,
				pending_release_id: null,
				releases: [live, older],
			},
		});
		await user.click(await screen.findByRole('button', { name: 'Manage publication' }));
		expect(screen.getByText('Public', { selector: 'span' })).toBeInTheDocument();
		expect(screen.getByText(/Older release is shutting down automatically/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Unpublish…' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Retry unpublish' })).not.toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: 'Unpublish sales before removing it' }),
		).toBeDisabled();
	});

	it('shows a head-pending release that reads active as still verifying', async () => {
		const user = setupUser();
		const live = { ...release, state: 'active' };
		const candidate = { ...release, release_id: '01ARZ3NDEKTSV4RRFFQ69G5FB9', state: 'active' };
		const { posts } = setup('managed', {
			entry: {
				active_release_id: live.release_id,
				pending_release_id: candidate.release_id,
				releases: [candidate, live],
			},
		});
		await user.click(await screen.findByRole('button', { name: 'Manage publication' }));
		expect(screen.getByText('Verifying…', { selector: 'span' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Cancel publish' })).toBeInTheDocument();
		// The live release stays stoppable; the replacement is cancelled first.
		await user.click(screen.getByRole('button', { name: 'Unpublish…' }));
		expect(screen.getByText(/The release being published is cancelled first/)).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Unpublish' }));
		await waitFor(() => expect(posts).toHaveLength(2));
		expect(posts.map((post) => post.path.split('/').at(-2))).toEqual([
			candidate.release_id,
			live.release_id,
		]);
		expect(await screen.findByText('Stopping public dashboard…')).toBeVisible();
	});

	it('keeps polling until the first verified release becomes the active head', async () => {
		const entry: Entry = {
			active_release_id: null,
			pending_release_id: release.release_id,
			releases: [{ ...release, state: 'active' }],
		};
		setup('managed', { entry });
		await screen.findByText('Verifying…', { selector: 'span' });
		entry.active_release_id = release.release_id;
		entry.pending_release_id = null;
		expect(
			await screen.findByText('Public', { selector: 'span' }, { timeout: 4_000 }),
		).toBeVisible();
	});

	it('lets a hub admin without a publish grant stop a live release', async () => {
		const user = setupUser();
		const live = { ...release, state: 'active' };
		const { posts } = setup('managed', {
			canPublish: false,
			canEmergencyUnpublish: true,
			entry: { active_release_id: live.release_id, pending_release_id: null, releases: [live] },
		});
		await user.click(await screen.findByRole('button', { name: 'Emergency unpublish…' }));
		expect(screen.getByText(/recorded in the audit log/)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Emergency unpublish' }));
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0].path).toBe(
			`/api/v1/projects/proj-1/notebooks/nb-1/public-releases/${live.release_id}/unpublish`,
		);
	});

	it('notes a truncated file preview and where files come from', async () => {
		const user = setupUser();
		setup('managed', { truncated: true });
		await user.click(await screen.findByRole('button', { name: 'Publish' }));
		expect(await screen.findByText(/Some files are not listed/)).toBeInTheDocument();
		expect(
			screen.getByText(/other notebooks list the current workspace files/),
		).toBeInTheDocument();
	});

	it('lets the owner disconnect a legacy release URL in managed mode', async () => {
		const user = setupUser();
		const { posts } = setup('managed', {
			publicOrigin: 'https://marimo-public-legacy-123.us-west1.run.app',
		});
		await user.click(await screen.findByRole('button', { name: 'Disconnect legacy URL' }));
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]).toEqual({
			path: '/api/v1/projects/proj-1/notebooks/nb-1/deep-links',
			body: {
				slug: 'sales',
				publication: { registration_id: link.registration_id, origin: null },
			},
		});
	});
});
