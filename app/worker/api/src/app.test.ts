import { describe, expect, it } from 'vitest';
import type { Env } from '@sategraph/infra';
import { app } from './app';

const env = { AGENT_MODE: 'fake', GRAPH_BACKEND: 'd1' } as unknown as Env;

describe('sategraph api', () => {
  it('reports health', async () => {
    const response = await app.request('/health', undefined, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('sategraph-api');
  });

  it('serves the manifest with versions and modes', async () => {
    const response = await app.request('/api/v1/manifest', undefined, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        graphVersion: string;
        orbitVersion: string;
        satelliteCount: number;
        modes: { graph: string; agent: string };
      };
    };
    expect(body.data.graphVersion).toMatch(/^(g-|seed-graph)/);
    expect(body.data.orbitVersion).toMatch(/^(o-|seed-orbits)/);
    expect(body.data.satelliteCount).toBeGreaterThan(0);
    expect(body.data.modes.agent).toBe('fake');
  });

  it('serves layers, catalog and orbit elements', async () => {
    const [layers, catalog, orbits] = await Promise.all([
      app.request('/api/v1/layers', undefined, env),
      app.request('/api/v1/catalog', undefined, env),
      app.request('/api/v1/orbits', undefined, env),
    ]);
    expect(layers.status).toBe(200);
    expect(catalog.status).toBe(200);
    expect(orbits.status).toBe(200);
    expect(orbits.headers.get('content-type')).toContain('text/csv');
    const layersBody = (await layers.json()) as { data: unknown[] };
    const catalogBody = (await catalog.json()) as { data: unknown[] };
    expect(layersBody.data.length).toBeGreaterThan(0);
    expect(catalogBody.data.length).toBeGreaterThan(0);
  });

  it('serves a satellite dossier by NORAD id', async () => {
    const response = await app.request('/api/v1/satellites/25544', undefined, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { satellite: { name: string }; relations: unknown[] };
    };
    expect(body.data.satellite.name).toContain('ISS');
    expect(body.data.relations.length).toBeGreaterThan(0);
  });

  it('returns 404 for an unknown satellite', async () => {
    const response = await app.request('/api/v1/satellites/00000', undefined, env);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SATELLITE_NOT_FOUND');
  });

  it('searches the catalog by text', async () => {
    const response = await app.request(
      '/api/v1/search?q=hubble',
      undefined,
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { total: number; entries: { name: string }[] };
    };
    expect(body.data.total).toBeGreaterThan(0);
    expect(body.data.entries[0].name).toContain('Hubble');
  });

  it('treats an empty search query as a full catalog browse', async () => {
    const response = await app.request('/api/v1/search?q=', undefined, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { total: number } };
    expect(body.data.total).toBeGreaterThan(0);
  });

  it('serves a graph neighbourhood', async () => {
    const response = await app.request(
      '/api/v1/graph/neighborhood?id=25544&depth=1',
      undefined,
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { centerId: string; nodes: unknown[] };
    };
    expect(body.data.centerId).toBe('25544');
    expect(body.data.nodes.length).toBeGreaterThan(1);
  });

  it('returns not found for unknown endpoints', async () => {
    const response = await app.request('/api/v1/unknown', undefined, env);
    expect(response.status).toBe(404);
  });
});
