/** Node development server. Cloudflare bindings are absent, so the seed runtime is used. */
import { serve } from '@hono/node-server';
import { app } from './app';
import type { Env } from '@satgraph/infra';

const port = Number(process.env.PORT ?? 8787);

serve({
  port,
  fetch: (request) =>
    app.fetch(request, {} as Env, {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext),
});

console.log(`SatGraph API listening on http://localhost:${port}`);
