/**
 * Runtime bindings. Every binding is optional so the same code boots in the
 * local seed mode, on Cloudflare Pages and in the scheduler worker.
 */
export interface SatgraphEnv {
  SATGRAPH_KV?: KVNamespace;
  SATGRAPH_DB?: D1Database;
  AI?: Ai;
  GRAPH_REFRESH_WORKFLOW?: Workflow;
  BACKUP_WORKFLOW?: Workflow;

  GRAPH_BACKEND?: 'neo4j' | 'd1' | 'seed';
  AGENT_MODE?: 'fake' | 'workers-ai' | 'byok';

  NEO4J_HTTP_URL?: string;
  NEO4J_DATABASE?: string;
  NEO4J_USER?: string;
  NEO4J_PASSWORD?: string;

  B2_ENDPOINT?: string;
  B2_BUCKET?: string;
  B2_KEY_ID?: string;
  B2_APP_KEY?: string;
  B2_REGION?: string;

  AI_MODEL?: string;
  BYOK_BASE_URL?: string;
  BYOK_API_KEY?: string;
  BYOK_MODEL?: string;

  TURNSTILE_SECRET?: string;
  PUBLIC_ORIGIN?: string;
}

export type Env = SatgraphEnv;
