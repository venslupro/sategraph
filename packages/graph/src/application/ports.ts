/**
 * Read and write ports of the graph context. Adapters (Neo4j, D1, memory) live
 * in the infrastructure layer; the domain depends only on these interfaces.
 */
import type {
  Neighborhood,
  Relation,
  RelationPath,
  RelationType,
} from '@satgraph/contracts';

export interface GraphReadPort {
  listRelations(satelliteId: string): Promise<Relation[]>;
  listByType(type: RelationType, limit: number): Promise<Relation[]>;
  neighborhood(
    satelliteId: string,
    depth: number,
    limit: number,
  ): Promise<Neighborhood>;
  path(
    fromId: string,
    toId: string,
    maxDepth: number,
  ): Promise<RelationPath | null>;
}

export interface GraphWritePort {
  /** Executes a generated Cypher batch; used by workflows only. */
  execute(cypher: string, parameters: Record<string, unknown>): Promise<{
    rowsAffected: number;
  }>;
}

export interface GraphStats {
  nodes: number;
  relationships: number;
}
