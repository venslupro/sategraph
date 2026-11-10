/**
 * Conditional HTTP client for scheduled source polling. Sends ETag and
 * Last-Modified so unchanged sources cost a 304 instead of a full download.
 */
import type { HttpClient, HttpGetOptions, HttpResponseLike } from '@satgraph/ingestion';

export class ConditionalHttpClient implements HttpClient {
  async get(
    url: string,
    options: HttpGetOptions = {},
  ): Promise<HttpResponseLike> {
    const headers: Record<string, string> = {
      'User-Agent': 'SatGraph/1.0 (+https://satgraph.example; public research)',
      Accept: options.accept ?? '*/*',
    };
    if (options.etag) {
      headers['If-None-Match'] = options.etag;
    }
    if (options.lastModified) {
      headers['If-Modified-Since'] = options.lastModified;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);
    try {
      const response = await fetch(url, {
        headers,
        signal: controller.signal,
        redirect: 'follow',
      });
      return {
        status: response.status,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        body: await response.arrayBuffer(),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
