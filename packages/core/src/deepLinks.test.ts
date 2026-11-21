import { describe, expect, it } from 'vitest';
import { isApprovedPublicAppOrigin } from './deepLinks';

const suffix = '-123.us-west1.run.app';

describe('isApprovedPublicAppOrigin', () => {
	it('accepts one marimo-public service under the configured suffix', () => {
		expect(isApprovedPublicAppOrigin(`https://marimo-public-sales${suffix}`, suffix)).toBe(true);
	});

	it.each([
		['traffic tag', `https://tag---marimo-public-sales${suffix}`],
		['tag inside the service label', `https://marimo-public-a---b${suffix}`],
		['other service', `https://other-sales${suffix}`],
		['http', `http://marimo-public-sales${suffix}`],
		['path', `https://marimo-public-sales${suffix}/x`],
		['port', `https://marimo-public-sales${suffix}:8443`],
		['other suffix', 'https://marimo-public-sales-999.us-west1.run.app'],
	])('rejects a %s', (_, origin) => {
		expect(isApprovedPublicAppOrigin(origin, suffix)).toBe(false);
	});

	it('rejects everything without a configured suffix', () => {
		expect(isApprovedPublicAppOrigin(`https://marimo-public-sales${suffix}`)).toBe(false);
	});
});
