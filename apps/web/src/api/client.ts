/** Typed client for the public SatGraph API. */
import type {
  AgentEvent,
  AgentShare,
  CatalogEntry,
  Constellation,
  DomainEventView,
  Layer,
  LayerLinks,
  Manifest,
  Neighborhood,
  SatelliteDetail,
  SearchResponse,
} from '@satgraph/contracts';

export interface ApiMeta {
  graphVersion: string;
  orbitVersion: string;
  generatedAt: string;
  cached: boolean;
  source?: string;
}

export interface Envelope<T> {
  data: T;
  meta: ApiMeta;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<Envelope<T>> {
  const response = await fetch(path, { signal, headers: { accept: 'application/json' } });
  const body = (await response.json()) as Envelope<T> | { error?: { code?: string; message?: string } };
  if (!response.ok) {
    const failure = body as { error?: { code?: string; message?: string } };
    throw new ApiError(
      response.status,
      failure.error?.code ?? 'REQUEST_FAILED',
      failure.error?.message ?? `Request failed with ${response.status}`,
    );
  }
  return body as Envelope<T>;
}

async function getText(path: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(path, { signal });
  if (!response.ok) {
    throw new ApiError(response.status, 'REQUEST_FAILED', `Request failed with ${response.status}`);
  }
  return response.text();
}

export const api = {
  manifest: (signal?: AbortSignal) => getJson<Manifest>('/api/v1/manifest', signal),
  layers: (signal?: AbortSignal) => getJson<Layer[]>('/api/v1/layers', signal),
  catalog: (signal?: AbortSignal) => getJson<CatalogEntry[]>('/api/v1/catalog', signal),
  constellations: (signal?: AbortSignal) =>
    getJson<Constellation[]>('/api/v1/constellations', signal),
  constellation: (id: string, signal?: AbortSignal) =>
    getJson<Constellation>(`/api/v1/constellations/${encodeURIComponent(id)}`, signal),
  links: (signal?: AbortSignal) => getJson<LayerLinks[]>('/api/v1/links', signal),
  detail: (id: string, signal?: AbortSignal) =>
    getJson<SatelliteDetail>(`/api/v1/satellites/${encodeURIComponent(id)}`, signal),
  events: (signal?: AbortSignal) =>
    getJson<DomainEventView[]>('/api/v1/events?limit=12', signal),
  search: (query: string, signal?: AbortSignal) =>
    getJson<SearchResponse>(
      `/api/v1/search?q=${encodeURIComponent(query)}&limit=18`,
      signal,
    ),
  neighborhood: (id: string, depth = 2, signal?: AbortSignal) =>
    getJson<Neighborhood>(
      `/api/v1/graph/neighborhood?id=${encodeURIComponent(id)}&depth=${depth}`,
      signal,
    ),
  share: (id: string, signal?: AbortSignal) =>
    getJson<AgentShare>(`/api/v1/agent/share/${encodeURIComponent(id)}`, signal),
  orbits: (signal?: AbortSignal) => getText('/api/v1/orbits', signal),
};

export interface ChatBody {
  messages: { role: 'user' | 'assistant'; content: string }[];
  context: {
    selectedId: string | null;
    layerIds: string[];
    linkIds: string[];
    time: string | null;
  };
  shareId?: string;
}

/**
 * Streams the agent response. The API emits one SSE frame per reasoning event,
 * so the UI can show tool progress before the answer is complete.
 */
export async function streamChat(
  body: ChatBody,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/v1/agent/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    let message = `Agent request failed with ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      message = payload.error?.message ?? message;
    } catch {
      // Keep the status-based message.
    }
    throw new ApiError(response.status, 'AGENT_FAILED', message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (!data) {
        continue;
      }
      try {
        onEvent(JSON.parse(data) as AgentEvent);
      } catch {
        // Ignore malformed keep-alive frames.
      }
    }
  }
}
