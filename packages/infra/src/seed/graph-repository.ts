/**
 * In-memory graph adapter. It serves the seed path and the tests with the same
 * GraphReadPort used by the Neo4j and D1 adapters.
 */
import type {
  GraphNode,
  Neighborhood,
  Relation,
  RelationPath,
  RelationType,
} from '@sategraph/contracts';
import type { GraphReadPort } from '@sategraph/graph';
import type { GraphSnapshot } from '@sategraph/publishing';

export class SnapshotGraphRepository implements GraphReadPort {
  private readonly relations: Relation[];
  private readonly adjacency = new Map<string, Relation[]>();
  private readonly nodes = new Map<string, GraphNode>();

  constructor(snapshot: GraphSnapshot) {
    this.relations = [...snapshot.relations];
    for (const relation of this.relations) {
      this.push(relation.from.id, relation);
      this.push(relation.to.id, relation);
      this.nodes.set(relation.from.id, {
        id: relation.from.id,
        name: relation.from.name,
        kind: relation.from.kind,
        layerId: null,
        status: null,
      });
      this.nodes.set(relation.to.id, {
        id: relation.to.id,
        name: relation.to.name,
        kind: relation.to.kind,
        layerId: null,
        status: null,
      });
    }
    for (const satellite of snapshot.satellites) {
      this.nodes.set(satellite.id, {
        id: satellite.id,
        name: satellite.name,
        kind: 'Satellite',
        layerId: satellite.layerId,
        status: satellite.status,
      });
    }
  }

  private push(id: string, relation: Relation): void {
    const bucket = this.adjacency.get(id) ?? [];
    bucket.push(relation);
    this.adjacency.set(id, bucket);
  }

  async listRelations(satelliteId: string): Promise<Relation[]> {
    return [...(this.adjacency.get(satelliteId) ?? [])];
  }

  async listByType(type: RelationType, limit: number): Promise<Relation[]> {
    return this.relations.filter((relation) => relation.type === type).slice(0, limit);
  }

  async neighborhood(
    satelliteId: string,
    depth: number,
    limit: number,
  ): Promise<Neighborhood> {
    const visited = new Set<string>([satelliteId]);
    const edges = new Map<string, Relation>();
    let frontier = [satelliteId];
    for (let level = 0; level < depth; level += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const relation of this.adjacency.get(id) ?? []) {
          if (edges.size >= limit) {
            break;
          }
          edges.set(relation.id, relation);
          const other = relation.from.id === id ? relation.to.id : relation.from.id;
          if (!visited.has(other)) {
            visited.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
      if (edges.size >= limit) {
        break;
      }
    }
    const center = this.nodes.get(satelliteId);
    const nodeIds = new Set<string>([satelliteId]);
    for (const edge of edges.values()) {
      nodeIds.add(edge.from.id);
      nodeIds.add(edge.to.id);
    }
    const nodes = [...nodeIds]
      .map((id) => this.nodes.get(id))
      .filter((node): node is GraphNode => Boolean(node));
    if (center && !nodes.some((node) => node.id === center.id)) {
      nodes.unshift(center);
    }
    return {
      centerId: satelliteId,
      depth,
      nodes,
      edges: [...edges.values()],
      truncated: edges.size >= limit,
    };
  }

  async path(
    fromId: string,
    toId: string,
    maxDepth: number,
  ): Promise<RelationPath | null> {
    const queue: string[] = [fromId];
    const visited = new Set<string>([fromId]);
    const parent = new Map<string, { previous: string; relation: Relation }>();
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (current === toId) {
        break;
      }
      const depth = this.depthOf(current, fromId, parent);
      if (depth >= maxDepth) {
        continue;
      }
      for (const relation of this.adjacency.get(current) ?? []) {
        const other = relation.from.id === current ? relation.to.id : relation.from.id;
        if (visited.has(other)) {
          continue;
        }
        visited.add(other);
        parent.set(other, { previous: current, relation });
        queue.push(other);
      }
    }
    if (!parent.has(toId) && fromId !== toId) {
      return null;
    }
    const nodeIds: string[] = [toId];
    const edges: Relation[] = [];
    let cursor = toId;
    while (cursor !== fromId) {
      const step = parent.get(cursor);
      if (!step) {
        break;
      }
      edges.unshift(step.relation);
      nodeIds.unshift(step.previous);
      cursor = step.previous;
    }
    return {
      fromId,
      toId,
      nodes: nodeIds
        .map((id) => this.nodes.get(id))
        .filter((node): node is GraphNode => Boolean(node)),
      edges,
    };
  }

  private depthOf(
    id: string,
    fromId: string,
    parent: Map<string, { previous: string; relation: Relation }>,
  ): number {
    let depth = 0;
    let cursor = id;
    while (cursor !== fromId && depth < 10) {
      const step = parent.get(cursor);
      if (!step) {
        break;
      }
      cursor = step.previous;
      depth += 1;
    }
    return depth;
  }
}
