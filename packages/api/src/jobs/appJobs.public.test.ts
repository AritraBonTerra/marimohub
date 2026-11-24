import { describe, expect, it } from 'vitest';
import { paths, signAppJobCredential, signProxyToken } from '@marimo-hub/core';
import type { PublicJobRun } from '@marimo-hub/core';
import { authorizeProxyRequest } from '../sandboxProxy';
import { expectOk } from '../testing';
import type { Page } from '../pagination';
import { createAppJobsFixture } from '../testing/appJobs';

const OPERATIONS = ['refresh', 'trigger', 'get_run', 'list_active_runs', 'list_project_runs'];

async function assertDenied(
	f: Awaited<ReturnType<typeof createAppJobsFixture>>,
	credential: string,
	status: number,
) {
	for (const operation of OPERATIONS)
		expect((await f.call(operation, undefined, credential)).status, operation).toBe(status);
	expect(await f.services.jobRuns.listActive()).toEqual([]);
}

describe('app jobs and public apps', () => {
	it('keeps member triggers and history working', async () => {
		const f = await createAppJobsFixture();
		const run = await expectOk<PublicJobRun>(await f.call('trigger'));
		expect(run.triggered_by).toBe(f.user);
		const history = await expectOk<Page<PublicJobRun>>(await f.call('list_project_runs', {}));
		expect(history.items.map((item) => item.run_id)).toEqual([run.run_id]);
		const { credential } = await expectOk<{ credential: string }>(await f.call('refresh', {}));
		expect((await f.call('list_active_runs', undefined, credential)).status).toBe(200);
	});

	it('rejects .pub. routing tokens', async () => {
		const f = await createAppJobsFixture();
		const routingToken = await signProxyToken(f.project.id, f.visit.session_id, f.secret, 'public');
		const credential = await signAppJobCredential({ ...f.claims, routingToken }, f.secret);
		await assertDenied(f, credential, 401);
	});

	// The app visit, assignment and member authorization all stay valid: only the audience changes.
	it('neither issues nor accepts credentials for public-audience sessions', async () => {
		const f = await createAppJobsFixture();
		const key = paths.session(f.project.id, f.visit.session_id);
		const stored = (await (await f.bucket.get(key))!.json()) as object;
		await f.bucket.put(key, JSON.stringify({ ...stored, audience: 'public' }));

		const decision = await authorizeProxyRequest(
			new Request(`http://hub.test/proxy/${f.claims.routingToken}/`),
			f.client.deps,
		);
		expect(decision.kind).toBe('forward');
		expect(decision).not.toHaveProperty('appJobCredential');
		expect(decision).not.toHaveProperty('appJobsEndpoint');
		await assertDenied(f, f.credential, 403);
	});
});
