import type { MiddlewareHandler } from 'hono';
import { ConfigError } from '@marimo-hub/config';
import { z } from 'zod';
import {
	createSlidingWindowBudget,
	ForbiddenError,
	isApprovedPublicAppOrigin,
	isManagedPublicReleaseOrigin,
	NotFoundError,
} from '@marimo-hub/core';
import type { DeepLink } from '@marimo-hub/core';
import { DeepLinkSlugSchema } from '@marimo-hub/core/deep-link-slug';

const MAX_CONCURRENT_LOOKUPS = 32;

const PublicReleaseSchema = z.strictObject({
	registration_id: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
	origin: z.string().refine((value) => {
		const url = URL.parse(value);
		return url?.protocol === 'https:' && value === url.origin;
	}, 'expected a canonical HTTPS origin with no path or trailing slash'),
});

const PublicReleasesSchema = z.record(DeepLinkSlugSchema, PublicReleaseSchema);

export function parsePublicAppReleases(value?: string) {
	if (value === undefined) return new Map<string, z.infer<typeof PublicReleaseSchema>>();
	try {
		return new Map(Object.entries(PublicReleasesSchema.parse(JSON.parse(value))));
	} catch {
		throw new ConfigError('Invalid MARIMOHUB_PUBLIC_APP_RELEASES', {
			variable: 'MARIMOHUB_PUBLIC_APP_RELEASES',
		});
	}
}

export function redirectPublicAppLinks(
	releases: ReturnType<typeof parsePublicAppReleases>,
	deepLinks: {
		resolve(slug: string): Promise<Pick<DeepLink, 'registration_id' | 'target' | 'public_origin'>>;
	},
	hostSuffix?: string,
	managed?: {
		resolvePublicOrigin(
			link: Pick<DeepLink, 'registration_id' | 'target'>,
			legacyOrigin: string | null | undefined,
		): Promise<string | null>;
	},
	assertLegacyTarget?: (target: DeepLink['target']) => Promise<unknown>,
): MiddlewareHandler {
	let lookups = 0;
	const requests = createSlidingWindowBudget<null>({ limit: 300, windowMs: 10_000 });
	return async (c, next) => {
		if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
		const requestPath = new URL(c.req.url).pathname;
		if (!requestPath.startsWith('/app/')) return next();
		let slug: string;
		try {
			slug = decodeURIComponent(requestPath.slice('/app/'.length));
		} catch {
			return next();
		}
		const release = releases.get(slug);
		if (!release && (!hostSuffix || !DeepLinkSlugSchema.safeParse(slug).success)) return next();

		if (!requests.consume(null)) {
			c.header('Cache-Control', 'no-store');
			c.header('Retry-After', '10');
			return c.body(null, 429);
		}
		if (lookups >= MAX_CONCURRENT_LOOKUPS) {
			c.header('Cache-Control', 'no-store');
			return c.body(null, 503);
		}
		let origin: string | null | undefined;
		lookups++;
		try {
			// A slug can be reused after removal. Only its original registration may redirect.
			const link = await deepLinks.resolve(slug);
			const legacyOrigin =
				link.public_origin === undefined
					? link.registration_id === release?.registration_id
						? release.origin
						: undefined
					: link.public_origin;
			const approvedLegacy =
				link.public_origin && !isApprovedPublicAppOrigin(link.public_origin, hostSuffix)
					? null
					: legacyOrigin;
			if (managed) {
				origin = await managed.resolvePublicOrigin(link, approvedLegacy);
			} else if (
				approvedLegacy &&
				!(hostSuffix && isManagedPublicReleaseOrigin(approvedLegacy, hostSuffix))
			) {
				await assertLegacyTarget?.(link.target);
				origin = approvedLegacy;
			}
		} catch (error) {
			if (!(error instanceof NotFoundError || error instanceof ForbiddenError)) throw error;
		} finally {
			lookups--;
		}
		if (!origin) return next();

		c.header('Cache-Control', 'no-store');
		c.header('Referrer-Policy', 'no-referrer');
		return c.redirect(origin, 302);
	};
}
