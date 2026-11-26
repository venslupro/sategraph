import {ReadError, requestObject} from './read_contract.ts';
import {issueCookie, validSession} from './session.ts';

interface Env {
  DATA: Fetcher;
  GRAPH: Fetcher;
  ASSISTANT: Fetcher;
  TURNSTILE_SITE_KEY?: string;
  PUBLIC_HOSTNAME: string;
  TURNSTILE_SECRET: string;
  SESSION_KEYS: string;
  STATUS: {
    status(): Promise<{phase: string; run_status: string; data_quality: string}>
  };
}

function json(status: number, data: object, cookie?: string) {
  const headers = new Headers(
      {'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
  if (cookie) {
    headers.set('set-cookie', cookie);
  }
  return Response.json(data, {status, headers});
}

async function readToken(request: Request): Promise<string|null> {
  if (!request.headers.get('content-type')
           ?.match(/^application\/json(?:;|$)/i) ||
      !request.body) {
    return null;
  }
  const reader = request.body.getReader();
  const body = new Uint8Array(4096);
  let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) {
        break;
      }
      if (size + value.byteLength > body.length) {
        await reader.cancel();
        return null;
      }
      body.set(value, size);
      size += value.byteLength;
    }
    const {token} =
        JSON.parse(new TextDecoder().decode(body.subarray(0, size)));
    return typeof token === 'string' && token.trim() && token.length <= 2048 ?
        token :
        null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export async function handle(
    request: Request, env: Env, send: typeof fetch = fetch) {
  const {origin, protocol, host, pathname} = new URL(request.url);
  if (protocol !== 'https:' || host !== env.PUBLIC_HOSTNAME) {
    return json(403, {error: 'INVALID_HOST'});
  }
  if (request.method !== 'GET' && request.headers.get('origin') !== origin) {
    return json(403, {error: 'ORIGIN_MISMATCH'});
  }
  try {
    if (pathname === '/api/v1/access/config' && request.method === 'GET') {
      return env.TURNSTILE_SITE_KEY ?
          json(200, {sitekey: env.TURNSTILE_SITE_KEY}) :
          json(503, {error: 'ACCESS_NOT_CONFIGURED'});
    }
    if (pathname === '/api/v1/access/verify') {
      if (request.method !== 'POST') {
        return json(405, {error: 'METHOD_NOT_ALLOWED'});
      }
      const token = await readToken(request);
      if (!token) {
        return json(422, {error: 'INVALID_TOKEN'});
      }
      if (!env.TURNSTILE_SECRET) {
        throw new Error('CONFIG_REQUIRED');
      }
      const res = await send(
          'https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            redirect: 'manual',
            signal: AbortSignal.timeout(8000),
            body: new URLSearchParams(
                {secret: env.TURNSTILE_SECRET, response: token}),
          });
      if (!res.ok) {
        throw new Error('SITEVERIFY_UNAVAILABLE');
      }
      const reply = await res.json() as {
        success?: boolean;
        hostname?: string;
        action?: string
      };
      if (reply.success !== true || reply.hostname !== host ||
          reply.action !== 'sategraph_access') {
        return json(403, {error: 'VERIFICATION_FAILED'});
      }
      return json(
          200, {verified: true}, await issueCookie(env.SESSION_KEYS, host));
    }
    if (request.method === 'GET' && pathname === '/api/v1/status') {
      const {phase, run_status, data_quality} = await env.STATUS.status();
      return json(200, {phase, run_status, data_quality});
    }
    if (!pathname.startsWith('/api/v1/')) {
      return json(404, {error: 'NOT_FOUND'});
    }
    if (!await validSession(
            request.headers.get('cookie') ?? '', env.SESSION_KEYS, host)) {
      return json(401, {error: 'SESSION_REQUIRED'});
    }
    if (pathname === '/api/v1/status/detail' && request.method === 'GET') {
      return json(200, await env.STATUS.status());
    }
    const graphRead =
        /^[/]api[/]v1[/](graph[/]relations|systems[/][^/]+([/]members)?|scenarios([/][^/]+)?)$/
            .test(pathname);
    const analysis =
        /^[/]api[/]v1[/]analysis[/](path|neighbors|common-neighbors|degree)$/
            .test(pathname);
    const assistant = pathname === '/api/v1/assistant/query';
    if (isCatalogRoute(pathname) || graphRead || analysis || assistant) {
      const post = analysis || assistant;
      if (request.method !== (post ? 'POST' : 'GET')) {
        return json(405, {error: 'METHOD_NOT_ALLOWED'});
      }
      const headers = new Headers();
      let body: string|undefined;
      if (post) {
        body = JSON.stringify(
            await requestObject(request, assistant ? 16384 : 8192));
        headers.set('content-type', 'application/json');
      }
      const sse =
          assistant && request.headers.get('accept') === 'text/event-stream';
      if (sse) {
        headers.set('accept', 'text/event-stream');
      }
      const binding = assistant   ? env.ASSISTANT :
          (graphRead || analysis) ? env.GRAPH :
                                    env.DATA;
      const result = await binding.fetch(new Request(request.url, {
        method: request.method,
        redirect: 'manual',
        headers,
        body,
        signal: request.signal
      }));
      if (result.status >= 300 && result.status < 400) {
        await result.body?.cancel();
        return json(503, {error: 'DEPENDENCY_UNAVAILABLE'});
      }
      return new Response(result.body, {
        status: result.status,
        headers: {
          'content-type': sse &&
                  result.headers.get('content-type')
                      ?.startsWith('text/event-stream') ?
              'text/event-stream' :
              'application/json',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        },
      });
    }
    return json(404, {error: 'NOT_FOUND'});
  } catch (err) {
    return err instanceof ReadError ?
        json(err.status, {error: err.message}) :
        json(503, {error: 'DEPENDENCY_UNAVAILABLE'});
  }
}

export default {
  fetch: (req, env) => handle(req, env)
} satisfies ExportedHandler<Env>;
function isCatalogRoute(path: string): boolean {
  return path === '/api/v1/catalog/search' ||
      path === '/api/v1/catalog/statistics' ||
      /^[/]api[/]v1[/](satellites|evidence|datasets)[/][^/]+$/.test(path);
}
