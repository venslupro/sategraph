/**
 * Neo4j graph read adapter. This is the authoritative graph store in a live
 * deployment; D1 and the seed snapshot are degraded alternatives.
 */
import type {
  Confidence,
  GraphNode,
  Neighborhood,
  Relation,
  RelationEndpoint,
  RelationPath,
  RelationType,
} from '@sategraph/contracts';
import type { GraphReadPort, GraphWritePort } from '@sategraph/graph';
import type { Neo4jClient, Neo4jNode, Neo4jRelationship } from './client';

const RELATION_TYPES = new Set<string>([
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

const CONFIDENCE = new Set<string>(['DECLARED', 'DERIVED', 'MODELED']);

function stringProperty(
  properties: Record<string, unknown>,
  key: string,
): string | null {
  const value = properties[key];
  return typeof value === 'string' ? value : null;
}

function nodeKind(labels: readonly string[]): RelationEndpoint['kind'] {
  if (labels.includes('Satellite')) {
    return 'Satellite';
  }
  if (labels.includes('Constellation')) {
    return 'Constellation';
  }
  if (labels.includes('OrbitalPlane')) {
    return 'OrbitalPlane';
  }
  if (labels.includes('Organization')) {
    return 'Organization';
  }
  if (labels.includes('Launch')) {
    return 'Launch';
  }
  return 'Bus';
}

function toEndpoint(node: Neo4jNode): RelationEndpoint {
  const properties = node.properties;
  const id =
    stringProperty(properties, 'objectId') ??
    stringProperty(properties, 'id') ??
    node.elementId;
  const name =
    stringProperty(properties, 'name') ??
    stringProperty(properties, 'itemLabel') ??
    id;
  return { id, name, kind: nodeKind(node.labels) };
}

function toEvidence(
  value: unknown,
): { label: string; source: string; url?: string }[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        label: stringProperty(item, 'label') ?? 'Recorded relationship',
        source: stringProperty(item, 'source') ?? 'unknown',
        url: stringProperty(item, 'url') ?? undefined,
      }));
  }
  if (typeof value === 'string') {
    try {
      return toEvidence(JSON.parse(value));
    } catch {
      return [{ label: value, source: 'neo4j' }];
    }
  }
  return [];
}

function toConfidence(value: unknown): Confidence {
  return typeof value === 'string' && CONFIDENCE.has(value)
    ? (value as Confidence)
    : 'DECLARED';
}

export class Neo4jGraphRepository implements GraphReadPort, GraphWritePort {
  constructor(private readonly client: Neo4jClient) {}

  async listRelations(satelliteId: string): Promise<Relation[]> {
    const rows = await this.client.query(
      `MATCH (a:Satellite {objectId: $id})-[r]-(b)
       RETURN r, a, b
       LIMIT 500`,
      { id: satelliteId },
    );
    return this.toRelations(rows);
  }

  async listByType(type: RelationType, limit: number): Promise<Relation[]> {
    if (!RELATION_TYPES.has(type)) {
      throw new Error(`Unsupported relation type: ${type}`);
    }
    const rows = await this.client.query(
      `MATCH (a)-[r:${type}]->(b)
       RETURN r, a, b
       LIMIT $limit`,
      { limit },
    );
    return this.toRelations(rows);
  }

  async neighborhood(
    satelliteId: string,
    depth: number,
    limit: number,
  ): Promise<Neighborhood> {
    const safeDepth = Math.min(3, Math.max(1, depth));
    const rows = await this.client.query(
      `MATCH p=(a:Satellite {objectId: $id})-[*1..${safeDepth}]-(b)
       WITH p LIMIT $limit
       RETURN nodes(p) AS nodes, relationships(p) AS rels`,
      { id: satelliteId, limit },
    );
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, Relation>();
    for (const row of rows) {
      const rowNodes = (row.nodes as Neo4jNode[] | undefined) ?? [];
      const rowRels = (row.rels as Neo4jRelationship[] | undefined) ?? [];
      for (const node of rowNodes) {
        const endpoint = toEndpoint(node);
        nodes.set(endpoint.id, {
          id: endpoint.id,
          name: endpoint.name,
          kind: endpoint.kind,
          layerId:
            endpoint.kind === 'Satellite'
              ? stringProperty(node.properties, 'layerId')
              : null,
          status:
            endpoint.kind === 'Satellite'
              ? (stringProperty(node.properties, 'status') as GraphNode['status'])
              : null,
        });
      }
      for (const relation of this.toRelationsFromParts(rowNodes, rowRels)) {
        edges.set(relation.id, relation);
      }
    }
    return {
      centerId: satelliteId,
      depth: safeDepth,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      truncated: edges.size >= limit,
    };
  }

  async path(
    fromId: string,
    toId: string,
    maxDepth: number,
  ): Promise<RelationPath | null> {
    const safeDepth = Math.min(3, Math.max(1, maxDepth));
    const rows = await this.client.query(
      `MATCH p=shortestPath((a:Satellite {objectId: $from})-[*..${safeDepth}]-(b:Satellite {objectId: $to}))
       RETURN nodes(p) AS nodes, relationships(p) AS rels`,
      { from: fromId, to: toId },
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    const rowNodes = (row.nodes as Neo4jNode[] | undefined) ?? [];
    const rowRels = (row.rels as Neo4jRelationship[] | undefined) ?? [];
    return {
      fromId,
      toId,
      nodes: rowNodes.map((node) => {
        const endpoint = toEndpoint(node);
        return {
          id: endpoint.id,
          name: endpoint.name,
          kind: endpoint.kind,
          layerId:
            endpoint.kind === 'Satellite'
              ? stringProperty(node.properties, 'layerId')
              : null,
          status:
            endpoint.kind === 'Satellite'
              ? (stringProperty(node.properties, 'status') as GraphNode['status'])
              : null,
        };
      }),
      edges: this.toRelationsFromParts(rowNodes, rowRels),
    };
  }

  async execute(
    cypher: string,
    parameters: Record<string, unknown>,
  ): Promise<{ rowsAffected: number }> {
    const rows = await this.client.query(cypher, parameters);
    return { rowsAffected: rows.length };
  }

  private toRelations(rows: Record<string, unknown>[]): Relation[] {
    return rows
      .map((row) => {
        const rel = row.r as Neo4jRelationship | undefined;
        const from = row.a as Neo4jNode | undefined;
        const to = row.b as Neo4jNode | undefined;
        if (!rel || !from || !to) {
          return null;
        }
        return this.toRelation(toEndpoint(from), toEndpoint(to), rel);
      })
      .filter((relation): relation is Relation => relation !== null);
  }

  private toRelationsFromParts(
    nodes: Neo4jNode[],
    relationships: Neo4jRelationship[],
  ): Relation[] {
    const byElementId = new Map(
      nodes.map((node) => [node.elementId, toEndpoint(node)]),
    );
    return relationships
      .map((relationship) => {
        const from = byElementId.get(relationship.startNodeElementId);
        const to = byElementId.get(relationship.endNodeElementId);
        if (!from || !to) {
          return null;
        }
        return this.toRelation(from, to, relationship);
      })
      .filter((relation): relation is Relation => relation !== null);
  }

  private toRelation(
    from: RelationEndpoint,
    to: RelationEndpoint,
    relationship: Neo4jRelationship,
  ): Relation {
    const properties = relationship.properties;
    const type = relationship.type as RelationType;
    return {
      id:
        stringProperty(properties, 'id') ??
        `${type}:${from.id}:${to.id}`,
      type,
      from,
      to,
      confidence: toConfidence(properties.confidence),
      method: stringProperty(properties, 'method') ?? 'Neo4j@1',
      evidence: toEvidence(properties.evidence),
      validFrom: stringProperty(properties, 'validFrom'),
      validTo: stringProperty(properties, 'validTo'),
      updatedVersion: stringProperty(properties, 'updatedVersion') ?? 'live',
    };
  }
}
