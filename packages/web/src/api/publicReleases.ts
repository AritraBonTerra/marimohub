import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, apiData, apiDataWithResponse } from './client';

const IN_FLIGHT = new Set(['publishing', 'exposing', 'unpublishing']);

export const publicReleaseKeys = {
	all: ['public-releases'] as const,
	list: (pid: string, nid: string) => ['public-releases', 'list', pid, nid] as const,
	assets: (pid: string, nid: string, vid: string) =>
		['public-releases', 'assets', pid, nid, vid] as const,
};

/** Releases per app link; polls while any release is still changing state. */
export function usePublicReleasesQuery(pid: string, nid: string, enabled = true) {
	return useQuery({
		queryKey: publicReleaseKeys.list(pid, nid),
		queryFn: ({ signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/public-releases', {
					params: { path: { pid, nid } },
					signal,
				}),
			),
		enabled,
		staleTime: 0,
		refetchInterval: (query) =>
			query.state.data?.some((link) => link.releases.some((r) => IN_FLIGHT.has(r.state)))
				? 2_500
				: false,
	});
}

export function usePublicReleaseAssetsQuery(pid: string, nid: string, versionId: string | null) {
	return useQuery({
		queryKey: publicReleaseKeys.assets(pid, nid, versionId ?? ''),
		queryFn: ({ signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/public-releases/assets', {
					params: { path: { pid, nid }, query: { version_id: versionId! } },
					signal,
				}),
			),
		enabled: versionId !== null,
		staleTime: 0,
		retry: false,
	});
}

function useInvalidateReleases() {
	const client = useQueryClient();
	return () =>
		Promise.all([
			client.invalidateQueries({ queryKey: publicReleaseKeys.all }),
			client.invalidateQueries({ queryKey: ['deep-links'] }),
		]);
}

export function usePublishPublicRelease(pid: string, nid: string) {
	const invalidate = useInvalidateReleases();
	return useMutation({
		meta: { suppressErrorToast: true },
		mutationFn: (body: {
			slug: string;
			registration_id: string;
			version_id: string;
			assets: { path: string; sha256: string; size_bytes: number }[];
		}) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/public-releases', {
					params: { path: { pid, nid } },
					body,
				}),
			),
		onSettled: invalidate,
	});
}

/** Resolves `confirmed` only when the server reports the direct release URL revoked. */
export function useUnpublishPublicRelease(pid: string, nid: string) {
	const invalidate = useInvalidateReleases();
	return useMutation({
		meta: { suppressErrorToast: true },
		mutationFn: async (releaseId: string) => {
			const { data, response } = await apiDataWithResponse(
				apiClient.POST(
					'/api/v1/projects/{pid}/notebooks/{nid}/public-releases/{release_id}/unpublish',
					{ params: { path: { pid, nid, release_id: releaseId } } },
				),
			);
			return { release: data, confirmed: response.status === 200 };
		},
		onSettled: invalidate,
	});
}
