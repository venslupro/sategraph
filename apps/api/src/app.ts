/**
 * HTTP interface layer. Routes are thin: they validate input, call application
 * services and shape the response envelope. No domain logic lives here.
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  agentChatRequestSchema,
  eventsQuerySchema,
  neighborhoodQuerySchema,
  pathQuerySchema,
  searchQuerySchema,
  type AgentEvent,
  type SearchResponse,
} from '@sategraph/contracts';
import type { Env } from '@sategraph/infra';
import { createServices, type Services } from './container';
import { apiError, respond, respondCsv } from './http/respond';
import { allowRequest, clientKey } from './http/rate-limit';
import { verifyTurnstile } from './http/turnstile';
import { runAgent } from './application/agent/orchestrator';

export type AppEnv = {
  Bindings: Env;
  Variables: {
    requestId: string;
    services: Services;
  };
};

export const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  await next();
});

app.use('/api/*', async (c, next) => {
  c.set('services', await createServices(c.env));
  await next();
});

app.get('/health', (c) =>
  c.json({ status: 'ok', service: 'sategraph-api', time: new Date().toISOString() }),
);

app.get('/api/v1/manifest', async (c) => {
  const services = c.get('services');
  return respond(c, services, await services.manifest(), {
    maxAge: 60,
    source: services.graphMode,
  });
});

app.get('/api/v1/orbits', async (c) => {
  const services = c.get('services');
  const { csv, version } = await services.getOrbits();
  if (!csv) {
    return apiError(c, 404, 'ORBITS_UNAVAILABLE', 'No orbit elements are published.');
  }
  return respondCsv(c, services, csv, version);
});

app.get('/api/v1/catalog', async (c) => {
  const services = c.get('services');
  const entries = await services.catalog.list();
  return respond(c, services, entries, { maxAge: 60 });
});

app.get('/api/v1/layers', async (c) => {
  const services = c.get('services');
  return respond(c, services, await services.layers(), { maxAge: 120 });
});

app.get('/api/v1/layers/:id', async (c) => {
  const services = c.get('services');
  const layers = await services.layers();
  const layer = layers.find((item) => item.id === c.req.param('id'));
  if (!layer) {
    return apiError(c, 404, 'LAYER_NOT_FOUND', 'Layer not found.');
  }
  return respond(c, services, layer, { maxAge: 120 });
});

app.get('/api/v1/links', async (c) => {
  const services = c.get('services');
  return respond(c, services, await services.links(), { maxAge: 60 });
});

app.get('/api/v1/constellations', async (c) => {
  const services = c.get('services');
  return respond(c, services, await services.constellations(), { maxAge: 300 });
});

app.get('/api/v1/constellations/:id', async (c) => {
  const services = c.get('services');
  const id = c.req.param('id');
  const readModel = await services.readModel<unknown>(`constellation:${id}`);
  if (readModel) {
    return respond(c, services, readModel, { maxAge: 300 });
  }
  const constellation = (await services.constellations()).find(
    (item) => item.id === id,
  );
  if (!constellation) {
    return apiError(c, 404, 'CONSTELLATION_NOT_FOUND', 'Constellation not found.');
  }
  return respond(c, services, constellation, { maxAge: 300 });
});

app.get('/api/v1/satellites/:id', async (c) => {
  const services = c.get('services');
  const detail = await services.getSatelliteDetail(c.req.param('id'));
  if (!detail) {
    return apiError(c, 404, 'SATELLITE_NOT_FOUND', 'Satellite not found.');
  }
  return respond(c, services, detail, { maxAge: 60 });
});

app.get('/api/v1/search', async (c) => {
  const services = c.get('services');
  const parsed = searchQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return apiError(c, 400, 'INVALID_QUERY', parsed.error.issues[0]?.message ?? 'Invalid query.');
  }
  const { q, layer, status, purpose, limit } = parsed.data;
  const entries = await services.catalog.search({
    text: q,
    layerId: layer,
    status: status as never,
    purpose,
    limit,
  });
  const body: SearchResponse = {
    query: q,
    total: entries.length,
    entries,
  };
  return respond(c, services, body, { maxAge: 30 });
});

app.get('/api/v1/graph/neighborhood', async (c) => {
  const services = c.get('services');
  const parsed = neighborhoodQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return apiError(c, 400, 'INVALID_QUERY', parsed.error.issues[0]?.message ?? 'Invalid query.');
  }
  const neighborhood = await services.graph.neighborhood(
    parsed.data.id,
    parsed.data.depth,
    parsed.data.limit,
  );
  if (neighborhood.nodes.length === 0) {
    return apiError(c, 404, 'NODE_NOT_FOUND', 'Graph node not found.');
  }
  return respond(c, services, neighborhood, { maxAge: 30 });
});

app.get('/api/v1/graph/path', async (c) => {
  const services = c.get('services');
  const parsed = pathQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return apiError(c, 400, 'INVALID_QUERY', parsed.error.issues[0]?.message ?? 'Invalid query.');
  }
  const path = await services.graph.path(
    parsed.data.from,
    parsed.data.to,
    parsed.data.maxDepth,
  );
  if (!path) {
    return apiError(c, 404, 'PATH_NOT_FOUND', 'No relation path found within the depth limit.');
  }
  return respond(c, services, path, { maxAge: 30 });
});

app.get('/api/v1/events', async (c) => {
  const services = c.get('services');
  const parsed = eventsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return apiError(c, 400, 'INVALID_QUERY', parsed.error.issues[0]?.message ?? 'Invalid query.');
  }
  const events = await services.recentEvents(
    parsed.data.sinceHours,
    parsed.data.limit,
  );
  return respond(c, services, events, { maxAge: 30 });
});

app.get('/api/v1/sources', async (c) => {
  const services = c.get('services');
  const manifest = await services.manifest();
  return respond(c, services, manifest.sources, { maxAge: 60 });
});

app.get('/api/v1/history/snapshots', async (c) => {
  const services = c.get('services');
  const raw = await services.readModels.getText('history:snapshots');
  let snapshots: unknown = [];
  if (raw) {
    try {
      snapshots = JSON.parse(raw);
    } catch {
      snapshots = [];
    }
  }
  return respond(c, services, snapshots, { maxAge: 300 });
});

app.post('/api/v1/agent/chat', async (c) => {
  const services = c.get('services');
  if (!allowRequest(`agent:${clientKey(c.req.raw)}`, 20, 5 * 60 * 1000)) {
    return apiError(c, 429, 'RATE_LIMITED', 'Too many agent requests. Try again shortly.');
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, 400, 'INVALID_JSON', 'Request body must be JSON.');
  }
  const parsed = agentChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid request.');
  }
  const allowed = await verifyTurnstile(
    services.env.TURNSTILE_SECRET,
    parsed.data.turnstileToken,
  );
  if (!allowed) {
    return apiError(c, 403, 'TURNSTILE_FAILED', 'Challenge verification failed.');
  }

  c.header('Cache-Control', 'no-store');
  return streamSSE(c, async (stream) => {
    try {
      await runAgent({
        services,
        messages: parsed.data.messages,
        context: parsed.data.context,
        emit: async (event: AgentEvent) => {
          await stream.writeSSE({
            event: 'agent',
            data: JSON.stringify(event),
          });
        },
      });
    } catch (error) {
      await stream.writeSSE({
        event: 'agent',
        data: JSON.stringify({
          type: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'The agent failed to complete the request.',
        } satisfies AgentEvent),
      });
    }
  });
});

app.get('/api/v1/agent/share/:id', async (c) => {
  const services = c.get('services');
  const raw = await services.shares.get(c.req.param('id'));
  if (!raw) {
    return apiError(c, 404, 'SHARE_NOT_FOUND', 'Shared answer not found or expired.');
  }
  return respond(c, services, JSON.parse(raw), { maxAge: 300 });
});

app.notFound((c) =>
  apiError(c, 404, 'NOT_FOUND', 'The requested endpoint does not exist.'),
);

app.onError((error, c) => {
  console.error('Unhandled API error', error);
  return apiError(c, 500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
});
