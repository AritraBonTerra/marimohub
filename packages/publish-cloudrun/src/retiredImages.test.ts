import { describe, expect, it, vi } from 'vitest';
import { markRetiredCloudRunImage } from './retiredImages';

const config = {
	projectId: 'test-project',
	region: 'us-west1',
	repository: 'releases',
	releaseId: '01J00000000000000000000000',
	baseDigest: `sha256:${'b'.repeat(64)}`,
	imageDigest: `sha256:${'a'.repeat(64)}`,
};
const version = `projects/test-project/locations/us-west1/repositories/releases/packages/dashboard/versions/${config.imageDigest}`;

describe('release image retention', () => {
	it('marks only the release image digest after withdrawal', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ version }))
			.mockResolvedValueOnce(Response.json({}));
		await markRetiredCloudRunImage({ ...config, request });
		expect(request).toHaveBeenCalledTimes(2);
		expect(request).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining('?tagId=retired-01j00000000000000000000000'),
			expect.objectContaining({ method: 'POST', body: JSON.stringify({ version }) }),
		);
	});

	it('does not retag a different digest or the base', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ version: version.replace(config.imageDigest, config.baseDigest) }),
			);
		await expect(markRetiredCloudRunImage({ ...config, request })).rejects.toThrow(
			'does not match',
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it('accepts a previously marked image with the same digest', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ version }))
			.mockResolvedValueOnce(new Response(null, { status: 409 }))
			.mockResolvedValueOnce(Response.json({ version }));
		await expect(markRetiredCloudRunImage({ ...config, request })).resolves.toBeUndefined();
	});
});
