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
}

export class Neo4jClient {
  constructor(private readonly config: Neo4jConfig) {}

  async query(
    statement: string,
    parameters: Record<string, unknown> = {},
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
      body: JSON.stringify({ statement, parameters }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Neo4j query failed (${response.status}): ${body.slice(0, 300)}`);
    }
    const payload = (await response.json()) as QueryApiResponse;
    if (payload.errors && payload.errors.length > 0) {
      throw new Error(payload.errors.map((error) => error.message).join('; '));
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
