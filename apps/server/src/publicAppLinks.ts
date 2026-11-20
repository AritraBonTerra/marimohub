import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { isApprovedPublicAppOrigin, NotFoundError } from '@marimo-hub/core';
import { DeepLinkSlugSchema } from '@marimo-hub/core/deep-link-slug';

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
	} catch (cause) {
		throw new Error('Invalid MARIMOHUB_PUBLIC_APP_RELEASES', { cause });
	}
}

export function redirectPublicAppLinks(
	releases: ReturnType<typeof parsePublicAppReleases>,
	deepLinks: {
		resolve(slug: string): Promise<{ registration_id: string; public_origin?: string | null }>;
	},
	hostSuffix?: string,
): MiddlewareHandler {
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

		// A slug can be reused after removal. Only its original registration may redirect.
		let link;
		try {
			link = await deepLinks.resolve(slug);
		} catch (error) {
			if (!(error instanceof NotFoundError)) throw error;
			return next();
		}
		const origin =
			link.public_origin === undefined
				? link.registration_id === release?.registration_id
					? release.origin
					: undefined
				: link.public_origin;
		if (!origin) return next();
		if (link.public_origin && !isApprovedPublicAppOrigin(origin, hostSuffix)) return next();

		c.header('Cache-Control', 'no-store');
		c.header('Referrer-Policy', 'no-referrer');
		return c.redirect(origin, 302);
	};
}
