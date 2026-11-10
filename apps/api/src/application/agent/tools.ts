/**
 * Server-side agent tools. Every tool is a pure read against the same services
 * as the public API, so answers cannot exceed what the UI can show.
 */
import { z } from 'zod';
import type {
  Citation,
  Link,
  SatelliteDetail,
  ViewContext,
} from '@satgraph/contracts';
import type { Services } from '../../container';

export interface AgentToolContext {
  services: Services;
  view: ViewContext;
}

export interface AgentToolOutcome {
  ok: boolean;
  summary: string;
  data: unknown;
  citations: Citation[];
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  execute(
    args: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<AgentToolOutcome>;
}

const searchArgs = z.object({
  query: z.string().min(1).max(120),
  limit: z.number().int().min(1).max(20).default(8),
});

const relationArgs = z.object({
  satelliteId: z.string().min(1),
  types: z.array(z.string()).optional(),
});

const constellationArgs = z.object({
  constellationId: z.string().min(1),
});

const eventsArgs = z.object({
  sinceHours: z.number().int().min(1).max(336).default(48),
  limit: z.number().int().min(1).max(50).default(8),
});

const pathArgs = z.object({
  fromId: z.string().min(1),
  toId: z.string().min(1),
});

const linkArgs = z.object({
  layerId: z.string().optional(),
});

export const TOOLS: AgentTool[] = [
  {
    name: 'search_satellites',
    description:
      'Search the satellite catalog by name, alias, NORAD or COSPAR identifier. Returns catalog entries with layer and orbit class.',
    parameters: searchArgs,
    async execute(args, context) {
      const parsed = searchArgs.parse(args);
      const entries = await context.services.catalog.search({
        text: parsed.query,
        limit: parsed.limit,
      });
      const top = entries
        .slice(0, 5)
        .map((entry) => `${entry.name} (${entry.noradId})`)
        .join(', ');
      return {
        ok: true,
        summary:
          entries.length === 0
            ? `No satellite matched "${parsed.query}".`
            : `Found ${entries.length} matching satellites. ${top}.`,
        data: entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          noradId: entry.noradId,
          constellation: entry.constellationName,
          layerId: entry.layerId,
          orbitClass: entry.orbitClass,
          status: entry.status,
        })),
        citations: [{ label: 'SatGraph satellite catalog', source: 'catalog' }],
      };
    },
  },
  {
    name: 'get_satellite',
    description:
      'Return one satellite with orbit summary, provenance and its direct graph relations.',
    parameters: z.object({ satelliteId: z.string().min(1) }),
    async execute(args, context) {
      const { satelliteId } = z
        .object({ satelliteId: z.string().min(1) })
        .parse(args);
      const detail = await context.services.getSatelliteDetail(satelliteId);
      if (!detail) {
        return {
          ok: false,
          summary: `Satellite ${satelliteId} is not in the catalog.`,
          data: null,
          citations: [],
        };
      }
      return {
        ok: true,
        summary: describeSatellite(detail),
        data: {
          satellite: detail.satellite,
          orbit: detail.orbit?.summary ?? null,
          relationCount: detail.relations.length,
        },
        citations: provenanceCitations(detail),
      };
    },
  },
  {
    name: 'get_relations',
    description:
      'List graph relations for a satellite, optionally filtered by relation type. Includes confidence level and method.',
    parameters: relationArgs,
    async execute(args, context) {
      const parsed = relationArgs.parse(args);
      const relations = await context.services.graph.listRelations(
        parsed.satelliteId,
      );
      const filtered = parsed.types?.length
        ? relations.filter((relation) => parsed.types?.includes(relation.type))
        : relations;
      const byConfidence = countBy(filtered, (relation) => relation.confidence);
      const byType = countBy(filtered, (relation) => relation.type);
      const names = filtered
        .slice(0, 4)
        .map((relation) => `${relation.type} to ${relation.to.name}`)
        .join('; ');
      return {
        ok: true,
        summary:
          filtered.length === 0
            ? `No matching relations were found for ${parsed.satelliteId}.`
            : `Found ${filtered.length} relations: ${Object.entries(byConfidence)
                .map(([level, count]) => `${count} ${level.toLowerCase()}`)
                .join(', ')}. Types: ${Object.entries(byType)
                .map(([type, count]) => `${type} ${count}`)
                .join(', ')}. ${names}.`,
        data: filtered.slice(0, 25),
        citations: [
          { label: 'SatGraph graph relations', source: 'knowledge graph' },
        ],
      };
    },
  },
  {
    name: 'get_constellation',
    description:
      'Return a constellation projection: planes, slots, active and inactive members.',
    parameters: constellationArgs,
    async execute(args, context) {
      const parsed = constellationArgs.parse(args);
      const direct = await context.services.readModel<{
        id: string;
        name: string;
        planes: { slots: unknown[] }[];
        slotCount: number;
        activeCount: number;
        inactiveCount: number;
        healthNote: string | null;
      }>(`constellation:${parsed.constellationId}`);
      const constellation =
        direct ??
        (await context.services
          .constellations()
          .then((items) => items.find((item) => item.id === parsed.constellationId)));
      if (!constellation) {
        return {
          ok: false,
          summary: `Constellation ${parsed.constellationId} is not published.`,
          data: null,
          citations: [],
        };
      }
      const planeSizes = constellation.planes
        .map((plane) => plane.slots.length)
        .join(', ');
      return {
        ok: true,
        summary: `${constellation.name} has ${constellation.planes.length} planes and ${constellation.slotCount} slots, with ${constellation.activeCount} active and ${constellation.inactiveCount} inactive satellites. Plane sizes: ${planeSizes}.`,
        data: constellation,
        citations: [
          { label: 'Published constellation read model', source: 'projection' },
        ],
      };
    },
  },
  {
    name: 'layer_stats',
    description: 'Count satellites per visualization layer.',
    parameters: z.object({}),
    async execute(_args, context) {
      const layers = await context.services.layers();
      const total = layers.reduce((sum, layer) => sum + layer.count, 0);
      const breakdown = layers
        .map((layer) => `${layer.name}: ${layer.count}`)
        .join(', ');
      return {
        ok: true,
        summary: `The globe currently publishes ${total} satellites across ${layers.length} layers. ${breakdown}.`,
        data: layers.map((layer) => ({
          id: layer.id,
          name: layer.name,
          count: layer.count,
        })),
        citations: [{ label: 'Published layer read models', source: 'projection' }],
      };
    },
  },
  {
    name: 'get_recent_events',
    description: 'List recent domain events such as maneuvers and membership changes.',
    parameters: eventsArgs,
    async execute(args, context) {
      const parsed = eventsArgs.parse(args);
      const events = await context.services.recentEvents(
        parsed.sinceHours,
        parsed.limit,
      );
      const titles = events.slice(0, 4).map((event) => event.title).join('; ');
      return {
        ok: true,
        summary:
          events.length === 0
            ? `No domain events in the last ${parsed.sinceHours} hours.`
            : `${events.length} events in the last ${parsed.sinceHours} hours. ${titles}.`,
        data: events,
        citations: [{ label: 'Domain event log', source: 'events' }],
      };
    },
  },
  {
    name: 'find_shortest_path',
    description:
      'Find the shortest relation path between two satellites, up to three hops.',
    parameters: pathArgs,
    async execute(args, context) {
      const parsed = pathArgs.parse(args);
      const path = await context.services.graph.path(
        parsed.fromId,
        parsed.toId,
        3,
      );
      if (!path) {
        return {
          ok: false,
          summary: `No path of at most three hops connects ${parsed.fromId} and ${parsed.toId}.`,
          data: null,
          citations: [],
        };
      }
      const names = path.nodes.map((node) => node.name).join(' -> ');
      return {
        ok: true,
        summary: `Shortest path uses ${path.edges.length} relations: ${names}.`,
        data: path,
        citations: [{ label: 'SatGraph graph relations', source: 'knowledge graph' }],
      };
    },
  },
  {
    name: 'get_links',
    description:
      'List modeled inter-satellite links and declared relay links, optionally for one layer.',
    parameters: linkArgs,
    async execute(args, context) {
      const parsed = linkArgs.parse(args);
      const groups = await context.services.links();
      const all = groups.flatMap((group) => group.links);
      const links = parsed.layerId
        ? all.filter((link) => link.layerId === parsed.layerId)
        : all;
      const byType = countBy(links, (link: Link) => link.type);
      const byConfidence = countBy(links, (link) => link.confidence);
      return {
        ok: true,
        summary: `${links.length} links match. Types: ${Object.entries(byType)
          .map(([type, count]) => `${type} ${count}`)
          .join(', ')}. Confidence: ${Object.entries(byConfidence)
          .map(([level, count]) => `${count} ${level.toLowerCase()}`)
          .join(', ')}.`,
        data: links.slice(0, 30),
        citations: [
          { label: 'Modeled link read models', source: 'modeled topology' },
        ],
      };
    },
  },
];

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function describeSatellite(detail: SatelliteDetail): string {
  const satellite = detail.satellite;
  const orbit = detail.orbit?.summary;
  const orbitText = orbit
    ? `Orbit class ${orbit.orbitClass}, perigee ${orbit.perigeeKm} km, apogee ${orbit.apogeeKm} km, period ${orbit.periodMin} minutes, inclination ${orbit.inclinationDeg} degrees.`
    : 'No published orbit elements.';
  const constellation = satellite.constellationName
    ? ` It belongs to ${satellite.constellationName}.`
    : '';
  return `${satellite.name} (NORAD ${satellite.noradId}) is a ${satellite.status.toLowerCase()} ${satellite.purpose} satellite.${constellation} ${orbitText} The graph records ${detail.relations.length} direct relations.`;
}

function provenanceCitations(detail: SatelliteDetail): Citation[] {
  const sources = new Set(detail.provenance.map((entry) => entry.source));
  return [...sources].map((source) => ({
    label: `${detail.satellite.name} field provenance`,
    source,
  }));
}

export function toolDefinitions(): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.parameters),
  }));
}

/**
 * Minimal JSON Schema projection for the tool parameters we use. A full
 * converter is unnecessary because every schema is a flat object.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
  if (!shape) {
    return { type: 'object', properties: {} };
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const field = value as z.ZodTypeAny;
    const optional = field.isOptional();
    const description = field.description;
    let type: string | undefined;
    let items: unknown;
    let enumValues: unknown;
    if (field instanceof z.ZodString) {
      type = 'string';
    } else if (field instanceof z.ZodNumber) {
      type = 'number';
    } else if (field instanceof z.ZodArray) {
      type = 'array';
      items = { type: 'string' };
    } else if (field instanceof z.ZodEnum) {
      type = 'string';
      const options = (field as z.ZodEnum<[string, ...string[]]>).options;
      enumValues = options;
    } else if (field instanceof z.ZodOptional) {
      const inner = field._def.innerType as z.ZodTypeAny;
      type = inner instanceof z.ZodString ? 'string' : 'object';
    } else {
      type = 'object';
    }
    properties[key] = {
      type,
      description,
      ...(items ? { items } : {}),
      ...(enumValues ? { enum: enumValues } : {}),
    };
    if (!optional) {
      required.push(key);
    }
  }
  return { type: 'object', properties, required };
}
