export type JsonRecord = Record<string, unknown>;
export interface ToolResult {
  ref: number;
  tool: string;
  data: JsonRecord
}
export interface AssistantEvent {
  event: string;
  data: JsonRecord;
  seq: number;
  request_id: string;
  context_revision: number
}
export function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export const errorCode = (error: unknown) =>
    error instanceof Error ? error.message : 'SERVICE_UNAVAILABLE';
const messages: Record<string, string> = {
  SESSION_REQUIRED: '请先验证访问权限，再重新提交。',
  ACCESS_NOT_CONFIGURED: '尚未配置访问验证。',
  MODEL_UNAVAILABLE: '在线助手未启用或暂不可用，可使用手动查询。',
  TIMEOUT: '请求超时，未自动重试。',
  LIMIT_REACHED: '已达到本次查询上限。',
  QUOTA_EXCEEDED: '额度不足，未重新推理。',
  INTERRUPTED: '响应中断，已收到的部分不代表完整结果。',
  DATA_INSUFFICIENT: '当前资料不足，不能据此判断无路径。'
};
Object.assign(messages, {
  RUNNING: '正在查询…',
  COMPLETED: '查询完成。',
  OK: '查询完成。',
  WAITING_USER: '请补充查询条件。',
  CANCELLED: '本次查询已停止。',
  CONTEXT_CHANGED: '查询条件已更改，请重新提交。',
  CONDITIONS_REQUIRED:
      '请先填写本次分析所需的端点、已有场景、UTC 时刻、用途、轨道清单和模型版本。',
  ID_REQUIRED: '请填写有效的对象 ID。',
  NOT_FOUND: '没有找到可展示的记录。',
  VERIFICATION_UNAVAILABLE: '访问验证暂不可用。',
  VERIFICATION_EXPIRED: '验证已过期，请重新验证。',
  VERIFICATION_FAILED: '验证未通过，请重新验证。',
  SERVICE_UNAVAILABLE: '当前未连接在线服务。',
  NO_PATH_OBSERVED: '本次查询在所给条件下未观测到路径。',
  FOUND: '已找到符合条件的拓扑路径，未验证实际转发。',
  INVALID_REFERENCE: '收到无效的查询引用，未更改视图。'
});
export function describe(code: string) {
  return Object.hasOwn(messages, code) ? messages[code] : ('查询状态：' + code);
}
export async function jsonApi(
    path: string, init: RequestInit = {}, send = fetch): Promise<JsonRecord> {
  const res = await send(path, {
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    ...init
  });
  if (!res.headers.get('content-type')?.includes('application/json')) {
    throw Error('SERVICE_UNAVAILABLE');
  }
  const body: unknown = await res.json();
  if (!isRecord(body)) {
    throw Error('INTERRUPTED');
  }
  if (!res.ok) {
    throw Error(String(body.error || body.status || 'SERVICE_UNAVAILABLE'));
  }
  return body;
}
export async function askAssistant(
    input: {context_revision: number}&JsonRecord,
    onEvent: (event: AssistantEvent) => void, signal: AbortSignal,
    send = fetch) {
  const res = await send('/api/v1/assistant/query', {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    signal,
    headers: {accept: 'text/event-stream', 'content-type': 'application/json'},
    body: JSON.stringify(input)
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Error(data.error || data.status || 'SERVICE_UNAVAILABLE');
  }
  if (!res.headers.get('content-type')?.startsWith('text/event-stream') ||
      !res.body) {
    throw Error('INTERRUPTED');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let rest = '';
  let seq = 0;
  let request = '';
  let done = false;
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) {
        break;
      }
      bytes += part.value.byteLength;
      if (bytes > 98304) {
        throw Error('LIMIT_REACHED');
      }
      rest += decoder.decode(part.value, {stream: true});
      let end;
      while ((end = rest.indexOf('\n\n')) !== -1) {
        const frame = rest.slice(0, end);
        rest = rest.slice(end + 2);
        const match = /^event: ([a-z_]+)\ndata: (.+)$/.exec(frame);
        if (!match || done) {
          throw Error('INTERRUPTED');
        }
        const e: unknown = JSON.parse(match[2]);
        if (!isRecord(e) || e.event !== match[1] || e.seq !== ++seq ||
            e.context_revision !== input.context_revision ||
            !isRecord(e.data) || typeof e.request_id !== 'string' ||
            !e.request_id ||
            (!request ?
                 e.event !== 'request_started' :
                 request !== e.request_id || e.event === 'request_started')) {
          throw Error('INTERRUPTED');
        }
        request = e.request_id;
        done = e.event === 'request_finished';
        onEvent({
          event: e.event,
          seq,
          request_id: request,
          context_revision: input.context_revision,
          data: e.data
        });
      }
    }
    if (rest || decoder.decode() || !done) {
      throw Error('INTERRUPTED');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
// 判定动作只依赖当前请求内已收到的服务端结果，不接受客户端历史作为依据。
export function resolveAction(
    action: JsonRecord, refs: ReadonlyMap<number, ToolResult>,
    expectedRevision: number) {
  const valid = (s: unknown) =>
      typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(s);
  if (!action || Object.keys(action).length !== 3 ||
      typeof action.ref !== 'number' || !Number.isSafeInteger(action.ref)) {
    return null;
  }
  const ref = refs.get(action.ref);
  if (!ref?.data) {
    return null;
  }
  if (action.action === 'select_entity' && ref.tool === 'get_entity' &&
      valid(action.entity_id) && ref.data.entity_id === action.entity_id) {
    return ref;
  }
  if (action.action === 'show_path' && ref.tool === 'find_path' &&
      ref.data.status === 'FOUND' &&
      ref.data.query_execution_complete === true &&
      ref.data.context_revision === expectedRevision &&
      valid(action.result_id) && ref.data.result_id === action.result_id) {
    return ref;
  }
  return null;
}
export function session() {
  let revision = 0;
  let active: AbortController|null = null;
  const history: {role: 'user'|'assistant'; text: string}[] = [];
  const invalidate = () => {
    revision++;
    active?.abort();
    active = null;
  };
  return {
    history,
    invalidate,
    begin() {
      invalidate();
      const current = revision;
      active = new AbortController();
      return {
        revision: current,
        signal: active.signal,
        current: () => revision === current
      };
    },
    remember(role: 'user'|'assistant', text: string) {
      history.push({role, text: text.slice(0, 600)});
      if (history.length > 6) {
        history.shift();
      }
    }
  };
}
