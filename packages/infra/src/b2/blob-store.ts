/**
 * Backblaze B2 through the S3-compatible API. Used for weekly graph snapshots
 * and long-lived raw source archives; it is never on a user request path.
 */
import { AwsClient } from 'aws4fetch';

export interface B2Config {
  endpoint: string;
  bucket: string;
  keyId: string;
  appKey: string;
  region: string;
}

export class B2BlobStore {
  private readonly client: AwsClient;

  constructor(private readonly config: B2Config) {
    this.client = new AwsClient({
      accessKeyId: config.keyId,
      secretAccessKey: config.appKey,
      service: 's3',
      region: config.region,
    });
  }

  private objectUrl(key: string): string {
    const endpoint = this.config.endpoint.replace(/\/$/, '');
    return `${endpoint}/${this.config.bucket}/${key.replace(/^\//, '')}`;
  }

  async put(key: string, body: ArrayBuffer | string, contentType: string): Promise<void> {
    const response = await this.client.fetch(this.objectUrl(key), {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body,
    });
    if (!response.ok) {
      throw new Error(`B2 upload failed (${response.status}) for ${key}`);
    }
  }

  /** Returns a time-limited GET URL; the bucket should stay private. */
  async presignGet(key: string, expiresSeconds: number): Promise<string> {
    const url = new URL(this.objectUrl(key));
    url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
    const signed = await this.client.sign(url, {
      method: 'GET',
      aws: { signQuery: true },
    });
    return signed.url.toString();
  }
}
