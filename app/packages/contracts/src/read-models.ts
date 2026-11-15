/**
 * Published language shared by the API, the scheduler and the browser.
 * Read models are the only data shapes the visualisation context consumes.
 */
import { z } from 'zod';

export const confidenceSchema = z.enum(['DECLARED', 'DERIVED', 'MODELED']);
export type Confidence = z.infer<typeof confidenceSchema>;

export const lifecycleStatusSchema = z.enum([
  'CATALOGED',
  'ACTIVE',
  'INACTIVE',
  'DECAYED',
]);
export type LifecycleStatus = z.infer<typeof lifecycleStatusSchema>;

export const orbitClassSchema = z.enum([
  'LEO',
  'SSO',
  'MEO',
  'GEO',
  'IGSO',
  'HEO',
]);
export type OrbitClass = z.infer<typeof orbitClassSchema>;

export const relationTypeSchema = z.enum([
  'MEMBER_OF',
  'IN_PLANE',
  'IN_SLOT',
  'ISL_MODELED',
  'RELAY_SERVES',
  'DOCKED_TO',
  'FORMATION_WITH',
  'LAUNCHED_IN',
  'OPERATED_BY',
  'OWNED_BY',
  'BUILT_BY',
  'USES_BUS',
  'CO_LOCATED',
  'SUCCEEDS',
]);
export type RelationType = z.infer<typeof relationTypeSchema>;

export const nodeKindSchema = z.enum([
  'Satellite',
  'Constellation',
  'OrbitalPlane',
  'Organization',
  'Launch',
  'Bus',
]);
export type NodeKind = z.infer<typeof nodeKindSchema>;

export const orbitSummarySchema = z.object({
  semiMajorAxisKm: z.number(),
  perigeeKm: z.number(),
  apogeeKm: z.number(),
  periodMin: z.number(),
  inclinationDeg: z.number(),
  eccentricity: z.number(),
  orbitClass: orbitClassSchema,
  geoLongitudeDeg: z.number().nullable(),
});
export type OrbitSummary = z.infer<typeof orbitSummarySchema>;

export const provenanceEntrySchema = z.object({
  field: z.string(),
  value: z.string(),
  source: z.string(),
  license: z.string(),
  url: z.string().url().optional(),
  retrievedAt: z.string(),
  candidates: z
    .array(
      z.object({
        value: z.string(),
        source: z.string(),
      }),
    )
    .default([]),
});
export type ProvenanceEntry = z.infer<typeof provenanceEntrySchema>;

export const catalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  noradId: z.string(),
  cosparId: z.string().nullable(),
  jcatId: z.string().nullable(),
  wikidataId: z.string().nullable(),
  purpose: z.string(),
  status: lifecycleStatusSchema,
  country: z.string().nullable(),
  operator: z.string().nullable(),
  manufacturer: z.string().nullable(),
  constellationId: z.string().nullable(),
  constellationName: z.string().nullable(),
  layerId: z.string(),
  orbitClass: orbitClassSchema.nullable(),
  launchDate: z.string().nullable(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const layerSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  color: z.string(),
  kind: z.enum(['constellation', 'group']),
  count: z.number().int().nonnegative(),
  satelliteIds: z.array(z.string()),
  defaultLinks: z.array(z.string()).default([]),
  colorBy: z.enum(['layer', 'purpose', 'orbit_class']).default('layer'),
});
export type Layer = z.infer<typeof layerSchema>;

export const slotSchema = z.object({
  index: z.number().int().nonnegative(),
  satelliteId: z.string(),
  name: z.string(),
  status: lifecycleStatusSchema,
});
export type Slot = z.infer<typeof slotSchema>;

export const planeSchema = z.object({
  index: z.number().int().nonnegative(),
  inclinationDeg: z.number(),
  raanDeg: z.number(),
  slots: z.array(slotSchema),
});
export type Plane = z.infer<typeof planeSchema>;

export const constellationSchema = z.object({
  id: z.string(),
  name: z.string(),
  designPattern: z.string().nullable(),
  planes: z.array(planeSchema),
  slotCount: z.number().int().nonnegative(),
  activeCount: z.number().int().nonnegative(),
  inactiveCount: z.number().int().nonnegative(),
  healthNote: z.string().nullable(),
});
export type Constellation = z.infer<typeof constellationSchema>;

export const relationEndpointSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: nodeKindSchema,
});
export type RelationEndpoint = z.infer<typeof relationEndpointSchema>;

export const relationSchema = z.object({
  id: z.string(),
  type: relationTypeSchema,
  from: relationEndpointSchema,
  to: relationEndpointSchema,
  confidence: confidenceSchema,
  method: z.string(),
  evidence: z
    .array(
      z.object({
        label: z.string(),
        url: z.string().url().optional(),
        source: z.string(),
      }),
    )
    .default([]),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  updatedVersion: z.string(),
});
export type Relation = z.infer<typeof relationSchema>;

export const satelliteDetailSchema = z.object({
  satellite: catalogEntrySchema,
  orbit: z
    .object({
      epoch: z.string(),
      summary: orbitSummarySchema,
      omm: z.record(z.union([z.string(), z.number()])),
    })
    .nullable(),
  relations: z.array(relationSchema),
  provenance: z.array(provenanceEntrySchema),
});
export type SatelliteDetail = z.infer<typeof satelliteDetailSchema>;

export const sourceHealthSchema = z.object({
  source: z.string(),
  status: z.enum(['OK', 'STALE', 'DEGRADED', 'PAUSED']),
  lastSuccessAt: z.string().nullable(),
  dataTime: z.string().nullable(),
  message: z.string().nullable(),
  license: z.string(),
});
export type SourceHealth = z.infer<typeof sourceHealthSchema>;

export const manifestSchema = z.object({
  orbitVersion: z.string(),
  graphVersion: z.string(),
  generatedAt: z.string(),
  satelliteCount: z.number().int().nonnegative(),
  activeCount: z.number().int().nonnegative(),
  relationCount: z.number().int().nonnegative(),
  modes: z.object({
    graph: z.enum(['neo4j', 'd1', 'seed']),
    agent: z.enum(['workers-ai', 'fake', 'byok']),
  }),
  sources: z.array(sourceHealthSchema),
});
export type Manifest = z.infer<typeof manifestSchema>;

export const eventSchema = z.object({
  id: z.string(),
  type: z.enum([
    'SATELLITE_CATALOGED',
    'SATELLITE_MANEUVERED',
    'SATELLITE_DECAYED',
    'CONSTELLATION_MEMBERSHIP_CHANGED',
    'RELATION_CREATED',
  ]),
  occurredAt: z.string(),
  aggregateId: z.string(),
  title: z.string(),
  detail: z.string(),
  graphVersion: z.string(),
});
export type DomainEventView = z.infer<typeof eventSchema>;

export const graphNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: nodeKindSchema,
  layerId: z.string().nullable(),
  status: lifecycleStatusSchema.nullable(),
});
export type GraphNode = z.infer<typeof graphNodeSchema>;

export const neighborhoodSchema = z.object({
  centerId: z.string(),
  depth: z.number().int().min(1).max(3),
  nodes: z.array(graphNodeSchema),
  edges: z.array(relationSchema),
  truncated: z.boolean(),
});
export type Neighborhood = z.infer<typeof neighborhoodSchema>;

export const pathSchema = z.object({
  fromId: z.string(),
  toId: z.string(),
  nodes: z.array(graphNodeSchema),
  edges: z.array(relationSchema),
});
export type RelationPath = z.infer<typeof pathSchema>;

export const searchResponseSchema = z.object({
  query: z.string(),
  total: z.number().int().nonnegative(),
  entries: z.array(catalogEntrySchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const linkSchema = z.object({
  id: z.string(),
  type: relationTypeSchema,
  fromId: z.string(),
  toId: z.string(),
  confidence: confidenceSchema,
  layerId: z.string(),
  method: z.string(),
});
export type Link = z.infer<typeof linkSchema>;

export const layerLinksSchema = z.object({
  layerId: z.string(),
  links: z.array(linkSchema),
  relayAssignments: z.array(linkSchema),
});
export type LayerLinks = z.infer<typeof layerLinksSchema>;
