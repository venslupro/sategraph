/** Shared HTTP helpers: envelopes, ETags and cache headers. */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiMeta } from '@sategraph/contracts';
import type { Services } from '../container';

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

export async function respond<T>(
  c: Context,
  services: Services,
  data: T,
  options: { maxAge?: number; source?: string; status?: ContentfulStatusCode } = {},
): Promise<Response> {
  const versions = await services.versions();
  const payload = JSON.stringify(data);
  const etag = `W/"${versions.graphVersion}-${versions.orbitVersion}-${fnv1a(payload)}"`;
  const ifNoneMatch = c.req.header('if-none-match');
  if (ifNoneMatch === etag) {
    c.header('ETag', etag);
    return c.body(null, 304);
  }
  const meta: ApiMeta = {
    graphVersion: versions.graphVersion,
    orbitVersion: versions.orbitVersion,
    generatedAt: services.seed.snapshot.generatedAt,
    cached: false,
    source: options.source,
  };
  c.header('ETag', etag);
  c.header(
    'Cache-Control',
    `public, max-age=${options.maxAge ?? 60}, stale-while-revalidate=300`,
  );
  return c.json({ data, meta }, options.status ?? 200);
}

export async function respondCsv(
  c: Context,
  _services: Services,
  csv: string,
  version: string,
): Promise<Response> {
  const etag = `W/"orbits-${version}"`;
  if (c.req.header('if-none-match') === etag) {
    c.header('ETag', etag);
    return c.body(null, 304);
  }
  c.header('ETag', etag);
  c.header('Cache-Control', 'public, max-age=1800, stale-while-revalidate=300');
  c.header('Content-Type', 'text/csv; charset=utf-8');
  return c.body(csv);
}

export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
): Response {
  const requestId = (c.get('requestId') as string | undefined) ?? 'unknown';
  return c.json({ error: { code, message, requestId } }, status);
}
