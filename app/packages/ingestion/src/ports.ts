/**
 * Ingestion ports. The scheduler performs I/O only: it downloads bytes, hands
 * them to blob/KV stores and asks Neo4j to run generated Cypher.
 */
export interface HttpResponseLike {
  status: number;
  etag: string | null;
  lastModified: string | null;
  body: ArrayBuffer;
}

export interface HttpGetOptions {
  etag?: string | null;
  lastModified?: string | null;
  accept?: string;
  timeoutMs?: number;
}

export interface HttpClient {
  get(url: string, options?: HttpGetOptions): Promise<HttpResponseLike>;
}

export interface BlobWriter {
  put(key: string, body: ArrayBuffer | string, contentType: string): Promise<void>;
  presignGet(key: string, expiresSeconds: number): Promise<string>;
}

export interface KvWriter {
  put(key: string, value: string, expirationTtlSeconds?: number): Promise<void>;
}

export interface HealthRecord {
  source: string;
  status: 'OK' | 'STALE' | 'DEGRADED' | 'PAUSED';
  lastSuccessAt: string | null;
  dataTime: string | null;
  message: string | null;
  license: string;
}

export interface HealthStore {
  write(record: HealthRecord): Promise<void>;
  read(source: string): Promise<HealthRecord | null>;
  list(): Promise<HealthRecord[]>;
}

export interface WorkflowStarter {
  start(kind: 'graph-refresh' | 'backup', payload: Record<string, unknown>): Promise<string>;
}
