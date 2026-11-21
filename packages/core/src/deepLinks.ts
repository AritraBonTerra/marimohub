import { utcTimestamp, ulidString } from './stringFormats';
import { z } from 'zod';
import { NotebookIdSchema, ProjectIdSchema, UserIdSchema } from './schema';
import { DeepLinkSlugSchema } from './deepLinkSlug';
export { DeepLinkSlugSchema } from './deepLinkSlug';

export const DeepLinkTargetSchema = z.strictObject({
	kind: z.literal('app'),
	project_id: ProjectIdSchema,
	notebook_id: NotebookIdSchema,
});
export const DeepLinkAccessSchema = z.strictObject({ mode: z.literal('inherit') });
export const PublicAppOriginSchema = z.string().refine((value) => {
	const url = URL.parse(value);
	return url?.protocol === 'https:' && value === url.origin;
}, 'Enter an HTTPS release URL without a path or trailing slash');
export function isApprovedPublicAppOrigin(origin: string, suffix?: string): boolean {
	const url = URL.parse(origin);
	if (!suffix || url?.protocol !== 'https:' || origin !== url.origin || url.port) return false;
	return (
		url.hostname.endsWith(suffix) &&
		/^marimo-public-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(url.hostname.slice(0, -suffix.length))
	);
}
export const DeepLinkSchema = z.strictObject({
	schema_version: z.literal(1),
	registration_id: ulidString(),
	slug: DeepLinkSlugSchema,
	target: DeepLinkTargetSchema,
	access: DeepLinkAccessSchema,
	public_origin: PublicAppOriginSchema.nullable().optional(),
	created_by: UserIdSchema,
	created_at: utcTimestamp(),
});
export const DeepLinkRecordSchema = z.union([
	DeepLinkSchema,
	z.strictObject({
		schema_version: z.literal(1),
		released: z.literal(true),
		registration_id: ulidString(),
	}),
]);
export type DeepLink = z.infer<typeof DeepLinkSchema>;
export type DeepLinkTarget = z.infer<typeof DeepLinkTargetSchema>;
