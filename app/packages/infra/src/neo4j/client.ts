/**
 * Neo4j Query API v2 client. Only HTTPS is used, so the platform never needs a
 * Bolt driver or a Node compatibility layer.
 */
export interface Neo4jConfig {
  url: string;
  database: string;
  user: string;
  password: string;
}

export interface Neo4jNode {
  elementId: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface Neo4jRelationship {
  elementId: string;
  type: string;
  startNodeElementId: string;
  endNodeElementId: string;
  properties: Record<string, unknown>;
}

interface QueryApiResponse {
  data?: {
    fields: string[];
    values: unknown[][];
  };
  errors?: { message: string }[];
  /** 'r' for read-only statements, 'rw' for writes (Query API v2). */
  queryType?: string;
}

export interface Neo4jQueryOptions {
  /** Aborts the statement server-side after this many milliseconds. */
  maxExecutionTimeMs?: number;
  /** Verifies the server reports the statement as read-only (queryType 'r'). */
  expectReadOnly?: boolean;
}

export class Neo4jClient {
  constructor(private readonly config: Neo4jConfig) {}

  async query(
    statement: string,
    parameters: Record<string, unknown> = {},
    options: Neo4jQueryOptions = {},
  ): Promise<Record<string, unknown>[]> {
    const endpoint = `${this.config.url.replace(/\/$/, '')}/db/${encodeURIComponent(
      this.config.database,
    )}/query/v2`;
    const credentials = btoa(
      `${this.config.user}:${this.config.password}`,
    );
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        statement,
        parameters,
        ...(options.maxExecutionTimeMs
          ? { maxExecutionTime: options.maxExecutionTimeMs }
          : {}),
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Neo4j query failed (${response.status}): ${body.slice(0, 300)}`);
    }
    const payload = (await response.json()) as QueryApiResponse;
    if (payload.errors && payload.errors.length > 0) {
      throw new Error(payload.errors.map((error) => error.message).join('; '));
    }
    if (
      options.expectReadOnly &&
      payload.queryType !== undefined &&
      payload.queryType !== 'r'
    ) {
      throw new Error(
        `Read-only endpoint received a write statement (queryType ${payload.queryType})`,
      );
    }
    const fields = payload.data?.fields ?? [];
    const values = payload.data?.values ?? [];
    return values.map((row) => {
      const record: Record<string, unknown> = {};
      fields.forEach((field, index) => {
        record[field] = row[index];
      });
      return record;
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.query('RETURN 1 AS ok');
      return true;
    } catch {
      return false;
    }
  }
}
