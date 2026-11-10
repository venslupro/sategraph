/**
 * Application service container. It selects adapters from bindings and exposes
 * version-aware read-model access with a seed fallback.
 */
import type { CatalogReader } from '@satgraph/catalog';
import type {
  EventReader,
  ShareStore,
} from '@satgraph/infra';
import {
  D1CatalogReader,
  D1EventReader,
  KvReadModelStore,
  KvShareStore,
  MemoryShareStore,
  MicroCache,
  Neo4jClient,
  Neo4jGraphRepository,
  createLlmProvider,
  createSeedRuntime,
  type SeedRuntime,
} from '@satgraph/infra';
import type { GraphReadPort } from '@satgraph/graph';
import type {
  Constellation,
  DomainEventView,
  Layer,
  LayerLinks,
  Link,
  Manifest,
  SatelliteDetail,
} from '@satgraph/contracts';
import { buildManifest, readModelKeys } from '@satgraph/publishing';
import type { Env } from '@satgraph/infra';
import type { LlmProvider } from '@satgraph/infra';
import { satelliteShard } from '@satgraph/publishing';

export interface VersionInfo {
  graphVersion: string;
  orbitVersion: string;
}

export interface Services {
  env: Env;
  graphMode: 'neo4j' | 'd1' | 'seed';
  agentMode: 'fake' | 'workers-ai' | 'byok';
  readModels: { get<T>(key: string): Promise<T | null>; getText(key: string): Promise<string | null> };
  catalog: CatalogReader;
  graph: GraphReadPort;
  events: EventReader;
  shares: ShareStore;
  llm: LlmProvider;
  cache: MicroCache;
  seed: SeedRuntime;
  versions(): Promise<VersionInfo>;
  readModel<T>(suffix: string): Promise<T | null>;
  getSatelliteDetail(id: string): Promise<SatelliteDetail | null>;
  getOrbits(): Promise<{ csv: string | null; version: string }>;
  layers(): Promise<Layer[]>;
  links(): Promise<LayerLinks[]>;
  constellations(): Promise<Constellation[]>;
  manifest(): Promise<Manifest>;
  recentEvents(sinceHours: number, limit: number): Promise<DomainEventView[]>;
}

const sharedCache = new MicroCache();

let seedPromise: Promise<SeedRuntime> | null = null;

async function seedRuntime(modes: Manifest['modes']): Promise<SeedRuntime> {
  if (!seedPromise) {
    seedPromise = createSeedRuntime(modes);
  }
  return seedPromise;
}

export async function createServices(env: Env): Promise<Services> {
  const llm = createLlmProvider(env);
  const seed = await seedRuntime({ graph: 'seed', agent: llm.mode });

  const readModels = env.SATGRAPH_KV
    ? new KvReadModelStore(env.SATGRAPH_KV)
    : seed.readModels;

  let graphMode: Services['graphMode'] = 'seed';
  let graph: GraphReadPort = seed.graph;
  if (
    env.NEO4J_HTTP_URL &&
    env.NEO4J_USER &&
    env.NEO4J_PASSWORD
  ) {
    const client = new Neo4jClient({
      url: env.NEO4J_HTTP_URL,
      database: env.NEO4J_DATABASE ?? 'neo4j',
      user: env.NEO4J_USER,
      password: env.NEO4J_PASSWORD,
    });
    graph = new Neo4jGraphRepository(client);
    graphMode = 'neo4j';
  }

  const catalog: CatalogReader = env.SATGRAPH_DB
    ? new D1CatalogReader(env.SATGRAPH_DB)
    : seed.catalog;
  const events: EventReader = env.SATGRAPH_DB
    ? new D1EventReader(env.SATGRAPH_DB)
    : seed.events;
  const shares: ShareStore = env.SATGRAPH_KV
    ? new KvShareStore(env.SATGRAPH_KV)
    : new MemoryShareStore();

  const services: Services = {
    env,
    graphMode,
    agentMode: llm.mode,
    readModels,
    catalog,
    graph,
    events,
    shares,
    llm: llm.provider,
    cache: sharedCache,
    seed,
    async versions(): Promise<VersionInfo> {
      const graphVersion =
        (await readModels.getText('ptr:graph')) ?? seed.snapshot.graphVersion;
      const orbitVersion =
        (await readModels.getText('ptr:orbit')) ?? seed.snapshot.orbitVersion;
      return { graphVersion, orbitVersion };
    },
    async readModel<T>(suffix: string): Promise<T | null> {
      const { graphVersion } = await this.versions();
      const current = await readModels.get<T>(`rm:${graphVersion}:${suffix}`);
      if (current !== null) {
        return current;
      }
      if (readModels !== seed.readModels) {
        return seed.readModels.get<T>(
          `rm:${seed.snapshot.graphVersion}:${suffix}`,
        );
      }
      return null;
    },
    async getSatelliteDetail(id: string): Promise<SatelliteDetail | null> {
      const shard = `sat:${satelliteShard(id)}`;
      const bucket = await this.readModel<Record<string, SatelliteDetail>>(shard);
      if (bucket && bucket[id]) {
        return bucket[id];
      }
      const fallback = await seed.readModels.get<Record<string, SatelliteDetail>>(
        `rm:${seed.snapshot.graphVersion}:${shard}`,
      );
      if (fallback && fallback[id]) {
        return fallback[id];
      }
      const entry = await this.catalog.get(id);
      if (!entry) {
        return null;
      }
      return {
        satellite: entry,
        orbit: null,
        relations: await this.graph.listRelations(id),
        provenance: [],
      };
    },
    async getOrbits(): Promise<{ csv: string | null; version: string }> {
      const { orbitVersion } = await this.versions();
      const keys = readModelKeys('unused', orbitVersion);
      let csv = await readModels.getText(keys.orbits);
      if (csv === null && readModels !== seed.readModels) {
        csv = await seed.readModels.getText(keys.orbits);
      }
      if (csv === null) {
        const seedKeys = readModelKeys('unused', seed.snapshot.orbitVersion);
        csv = await seed.readModels.getText(seedKeys.orbits);
      }
      return { csv, version: orbitVersion };
    },
    async layers(): Promise<Layer[]> {
      return (await this.readModel<Layer[]>('layers')) ?? [];
    },
    async links(): Promise<LayerLinks[]> {
      const flat = (await this.readModel<Link[]>('links')) ?? [];
      const layers = await this.layers();
      return layers.map((layer) => {
        const links = flat.filter((link) => link.layerId === layer.id);
        return {
          layerId: layer.id,
          links,
          relayAssignments: links.filter(
            (link) => link.type === 'RELAY_SERVES',
          ),
        };
      });
    },
    async constellations(): Promise<Constellation[]> {
      return (await this.readModel<Constellation[]>('constellations')) ?? [];
    },
    async manifest(): Promise<Manifest> {
      const stored = await this.readModel<Manifest>('manifest');
      const versions = await this.versions();
      const modes = { graph: this.graphMode, agent: this.agentMode };
      const base =
        stored ??
        buildManifest(seed.snapshot, modes);
      return {
        ...base,
        ...versions,
        modes,
        generatedAt: stored?.generatedAt ?? seed.snapshot.generatedAt,
      };
    },
    async recentEvents(
      sinceHours: number,
      limit: number,
    ): Promise<DomainEventView[]> {
      return events.list(sinceHours, limit);
    },
  };

  return services;
}
