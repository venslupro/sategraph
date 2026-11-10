/**
 * Cloudflare Pages Functions entry. All /api/* requests hit the same Hono app
 * that runs locally and in tests.
 */
import type { Env } from '@satgraph/infra';
import { app } from '../../apps/api/src/app';

interface PagesContext {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
  waitUntil: (promise: Promise<unknown>) => void;
  passThroughOnException: () => void;
}

export const onRequest = async (context: PagesContext): Promise<Response> =>
  app.fetch(context.request, context.env, {
    waitUntil: context.waitUntil,
    passThroughOnException: context.passThroughOnException,
  } as ExecutionContext);
