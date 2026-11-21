const TAG_REQUEST_TIMEOUT_MS = 5_000;

type TagRequest = (url: string, init: RequestInit) => Promise<Response>;

async function readTag(request: TagRequest, url: string, signal: AbortSignal) {
	const response = await request(url, { signal });
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`Reading an Artifact Registry tag failed (${response.status})`);
	const tag = await response.json();
	if (
		typeof tag !== 'object' ||
		tag === null ||
		!('version' in tag) ||
		typeof tag.version !== 'string'
	)
		throw new Error('Artifact Registry did not return a tag version');
	return tag.version;
}

/** Mark one confirmed-withdrawn image. The repository policy owns any later deletion. */
export async function markRetiredCloudRunImage(input: {
	projectId: string;
	region: string;
	repository: string;
	releaseId: string;
	imageDigest?: string;
	baseDigest: string;
	request: TagRequest;
	signal?: AbortSignal;
}): Promise<void> {
	const id = input.releaseId.toLowerCase();
	if (!/^[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(id)) throw new Error('Invalid release ID');
	const parent = `projects/${input.projectId}/locations/${input.region}/repositories/${input.repository}/packages/dashboard`;
	const tagsUrl = `https://artifactregistry.googleapis.com/v1/${parent}/tags`;
	const timeout = AbortSignal.timeout(TAG_REQUEST_TIMEOUT_MS);
	const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
	const version = await readTag(input.request, `${tagsUrl}/release-${id}`, signal);
	if (version === null) return;
	const prefix = `${parent}/versions/`;
	const digest = version.slice(prefix.length);
	if (
		!version.startsWith(prefix) ||
		!/^sha256:[0-9a-f]{64}$/.test(digest) ||
		digest === input.baseDigest ||
		(input.imageDigest && digest !== input.imageDigest)
	) {
		throw new Error('The release image tag does not match the withdrawn release');
	}
	const retiredTag = `retired-${id}`;
	const response = await input.request(`${tagsUrl}?tagId=${retiredTag}`, {
		method: 'POST',
		body: JSON.stringify({ version }),
		signal,
	});
	if (response.ok) return;
	if (
		response.status === 409 &&
		(await readTag(input.request, `${tagsUrl}/${retiredTag}`, signal)) === version
	)
		return;
	throw new Error(`Marking the release image retired failed (${response.status})`);
}
