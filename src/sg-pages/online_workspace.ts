import {elements} from './dom.ts';
import {askAssistant, describe, errorCode, isRecord, jsonApi, type JsonRecord, resolveAction, session, type ToolResult} from './online_client.ts';

interface Fields {
  context: Record<string, string>;
  q: string;
  id: string
}
interface WorkspaceState {
  status: string;
  records: ToolResult[];
  views: ToolResult[];
  text: string;
  busy: boolean
}
interface Turnstile {
  render(el: HTMLElement, options: {
    sitekey: string; action: string; callback(token: string): void;
    'error-callback'(): void;
    'expired-callback'(): void
  }): string;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: Turnstile
  }
}

const base = '/api/v1/';
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const contextKeys = [
  'from', 'to', 'scenario_id', 'analysis_time', 'purpose', 'orbit_manifest_id',
  'model_version'
];
const analysis = ['path', 'neighbors', 'common-neighbors', 'degree'];
const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify(body)
});

function manualRoute(
    kind: string, fields: Fields, revision: number): [string, RequestInit] {
  if (analysis.includes(kind)) {
    const pair = kind === 'path' || kind === 'common-neighbors';
    const body: Record<string, string|number> = {context_revision: revision};
    for (const key of contextKeys.filter(key => key !== 'to' || pair)) {
      const value = fields.context[key];
      if (!value || !identifier.test(value)) {
        throw Error('CONDITIONS_REQUIRED');
      }
      body[key] = value;
    }
    return [base + 'analysis/' + kind, post(body)];
  }
  if (kind === 'search') {
    return [
      base + 'catalog/search?' +
          new URLSearchParams({q: fields.q, limit: '25'}),
      {}
    ];
  }
  if (kind === 'statistics') {
    return [base + 'catalog/statistics', {}];
  }
  if (kind === 'scenarios') {
    return [base + 'scenarios?limit=25', {}];
  }
  if (!fields.id || !identifier.test(fields.id)) {
    throw Error('ID_REQUIRED');
  }
  const id = encodeURIComponent(fields.id);
  const routes: Record<string, string> = {
    entity: 'satellites/' + id,
    evidence: 'evidence/' + id,
    system: 'systems/' + id,
    scenario: 'scenarios/' + id,
    members: 'systems/' + id + '/members',
    relations: 'graph/relations?' + new URLSearchParams({root: fields.id})
  };
  if (!Object.hasOwn(routes, kind)) {
    throw Error('INVALID_QUERY');
  }
  return [base + routes[kind], {}];
}

// 每次提交冻结自己的条件；晚到的结果不能改变较新请求的面板或历史。
export function workspace({fields, render, send = fetch}: {
  fields(): Fields; render(state: WorkspaceState): void;
  send?: typeof fetch;
}) {
  const memory = session();
  let state: WorkspaceState =
      {status: '', records: [], views: [], text: '', busy: false};
  const show = (patch: Partial<WorkspaceState>) => {
    state = {...state, ...patch};
    render(state);
  };
  const clear = (status: string, busy = false) =>
      show({status, records: [], views: [], text: '', busy});
  function invalidate(status: string) {
    memory.invalidate();
    if (state.busy || state.status) {
      clear(status);
    }
  }
  async function ask(message: string) {
    message = message.trim();
    if (!message) {
      return;
    }
    const req = memory.begin();
    const refs = new Map<number, ToolResult>();
    const cited = new Set<number>();
    const actions: JsonRecord[] = [];
    let terminal = '';
    let error = '';
    let answer = '';
    clear('RUNNING', true);
    try {
      const input = {
        message,
        context_revision: req.revision,
        context: fields().context,
        history: memory.history.slice()
      };
      await askAssistant(input, e => {
        if (!req.current()) {
          return;
        }
        const d = e.data;
        switch (e.event) {
          case 'request_started':
          case 'step_started':
            break;
          case 'tool_result':
            if (refs.size >= 8 || d.ref !== refs.size + 1 ||
                typeof d.tool !== 'string' || !isRecord(d.data)) {
              throw Error('INTERRUPTED');
            }
            refs.set(d.ref, {ref: d.ref, tool: d.tool, data: d.data});
            show({records: [...refs.values()]});
            break;
          case 'text_delta':
            if (typeof d.text !== 'string' ||
                (d.refs !== undefined &&
                 (!Array.isArray(d.refs) || !d.refs.every(n => refs.has(n))))) {
              throw Error('INVALID_REFERENCE');
            }
            for (const n of d.refs || []) {
              cited.add(n);
            }
            answer += d.text;
            show({text: answer});
            break;
          case 'view_action':
            actions.push(d);
            break;
          case 'error':
            error = typeof d.code === 'string' ? d.code : 'INTERRUPTED';
            break;
          case 'request_finished':
            if (typeof d.status !== 'string') {
              throw Error('INTERRUPTED');
            }
            terminal = d.status;
            break;
          default:
            throw Error('INTERRUPTED');
        }
      }, req.signal, send);
      if (!req.current()) {
        return;
      }
      if (error) {
        show({status: error, busy: false});
        return;
      }
      if (!['COMPLETED', 'WAITING_USER'].includes(terminal) || !answer ||
          (terminal === 'COMPLETED' && !cited.size)) {
        throw Error('INTERRUPTED');
      }
      const views = terminal === 'COMPLETED' ?
          actions.filter(a => typeof a.ref === 'number' && cited.has(a.ref))
              .map(a => resolveAction(a, refs, req.revision))
              .filter(r => r !== null) :
          [];
      memory.remember('user', message);
      memory.remember('assistant', answer);
      show({status: terminal, views, busy: false});
    } catch (err) {
      if (req.current()) {
        show({status: errorCode(err), busy: false, views: []});
      }
    }
  }
  async function manual(kind: string) {
    const req = memory.begin();
    clear('RUNNING', true);
    try {
      const [path, init] = manualRoute(kind, fields(), req.revision);
      const data = await jsonApi(path, {...init, signal: req.signal}, send);
      if (!req.current()) {
        return;
      }
      if (!isRecord(data) ||
          (analysis.includes(kind) && data.context_revision !== req.revision)) {
        throw Error('INTERRUPTED');
      }
      const record = {ref: 1, tool: kind, data};
      show({
        status: typeof data.status === 'string' ? data.status : 'COMPLETED',
        busy: false,
        records: [record]
      });
    } catch (err) {
      if (req.current()) {
        show({status: errorCode(err), busy: false});
      }
    }
  }
  return {
    ask,
    manual,
    cancel: () => invalidate('CANCELLED'),
    contextChanged: () => invalidate('CONTEXT_CHANGED')
  };
}

const readerNames: Record<string, string> = {
  search_catalog: '目录搜索',
  catalog_statistics: '目录统计',
  get_entity: '卫星档案',
  get_evidence: '来源证据',
  get_system: '系统档案',
  get_scenario: '场景详情',
  list_scenarios: '现有场景',
  list_system_members: '系统成员',
  information_relations: '信息关系',
  find_path: '拓扑路径',
  neighbors: '邻居',
  common_neighbors: '共同邻居',
  degree: '度数'
};
function summary(d: JsonRecord) {
  if (d.status === 'FOUND' && Array.isArray(d.ordered_node_ids)) {
    return d.ordered_node_ids.join(' → ') + '（' + d.hop_count +
        ' 跳；未验证实际转发）';
  }
  if (Number.isSafeInteger(d.objects_with_orbit)) {
    return '获准展示的有轨道对象：' + d.objects_with_orbit + ' 个';
  }
  if (Array.isArray(d.items)) {
    return '本页 ' + d.items.length + ' 条' +
        (d.next_cursor ? '，尚有后续记录' : '');
  }
  if (d.entity_id) {
    return [d.display_name, d.entity_id, d.source_id].filter(Boolean).join(
        ' · ');
  }
  return describe(typeof d.status === 'string' ? d.status : 'COMPLETED');
}

function loadTurnstile(doc: Document): Promise<Turnstile> {
  if (doc.defaultView?.turnstile) {
    return Promise.resolve(doc.defaultView.turnstile);
  }
  return new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    script.src =
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => doc.defaultView?.turnstile ?
        resolve(doc.defaultView.turnstile) :
        reject(Error('VERIFICATION_UNAVAILABLE'));
    script.onerror = () => {
      script.remove();
      reject(Error('VERIFICATION_UNAVAILABLE'));
    };
    doc.head.append(script);
  });
}

export function mountWorkspace(
    doc: Document, {send = fetch, challenge = loadTurnstile} = {}) {
  const el = elements(doc);
  const form = el('manual-query');
  const fields = () => {
    const context: Record<string, string> = {};
    for (const key of contextKeys) {
      const input = form.elements.namedItem(key);
      const value =
          input && 'value' in input && typeof input.value === 'string' ?
          input.value.trim() :
          '';
      if (value) {
        context[key] = value;
      }
    }
    const id = el('online-id').value.trim();
    if (id && el('manual-kind').value === 'entity') {
      context.entity_id = id;
    }
    return {context, id, q: el('online-q').value.trim()};
  };
  const ws = workspace({
    fields,
    send,
    render(s) {
      const status = [describe(s.status), s.text].filter(Boolean).join(' ');
      el('online-stop').disabled = !s.busy;
      el('online-status').textContent = status;
      const dock = el('assistant-result');
      dock.hidden = false;
      dock.textContent = status;
      const results = el('online-results');
      results.replaceChildren();
      for (const r of s.records) {
        const details = doc.createElement('details');
        const title = doc.createElement('summary');
        const pre = doc.createElement('pre');
        title.textContent = '[' + r.ref + '] ' +
            (readerNames[r.tool] || '手动结果') + '：' + summary(r.data);
        pre.textContent = JSON.stringify(r.data, null, 2);
        details.append(title, pre);
        results.append(details);
      }
      const view = el('online-view');
      view.replaceChildren();
      for (const r of s.views) {
        const line = doc.createElement('p');
        line.textContent =
            (r.tool === 'get_entity' ? '当前在线档案：' : '当前在线路径：') +
            summary(r.data);
        view.append(line);
        if (r.tool === 'get_entity' && typeof r.data.entity_id === 'string') {
          el('online-id').value = r.data.entity_id;
          el('manual-kind').value = 'entity';
        }
      }
    }
  });
  const dialog = el('online-dialog');
  const open = () => {
    if (!dialog.open) {
      dialog.showModal();
    }
  };
  const ask = (text: string) => {
    if (!text.trim()) {
      return;
    }
    open();
    el('panel-query').value = text;
    el('assistant-query').value = text;
    return ws.ask(text);
  };
  el('open-online').onclick = open;
  el('online-stop').onclick = ws.cancel;
  el('online-ask').onsubmit = e => {
    e.preventDefault();
    return ask(el('panel-query').value);
  };
  form.onsubmit = e => {
    e.preventDefault();
    return ws.manual(el('manual-kind').value);
  };
  form.addEventListener('input', ws.contextChanged);
  doc.defaultView?.addEventListener('pagehide', ws.cancel);
  const start = el('access-start');
  const notice = el('access-status');
  let api: Turnstile|undefined;
  let widget: string|undefined;
  let attempt = 0;
  start.onclick = async () => {
    const current = ++attempt;
    start.disabled = true;
    notice.textContent = '正在读取访问配置…';
    try {
      if (api && widget !== undefined) {
        api.remove(widget);
        widget = undefined;
      }
      const {sitekey} = await jsonApi(base + 'access/config', {}, send);
      if (typeof sitekey !== 'string' ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(sitekey)) {
        throw Error('ACCESS_NOT_CONFIGURED');
      }
      api = await challenge(doc);
      notice.textContent = '请完成验证。';
      const fail = (code: string) => {
        if (current === attempt) {
          notice.textContent = describe(code);
          start.disabled = false;
        }
      };
      widget = api.render(el('access-widget'), {
        sitekey,
        action: 'sategraph_access',
        callback: async token => {
          if (current !== attempt) {
            return;
          }
          try {
            const data =
                await jsonApi(base + 'access/verify', post({token}), send);
            if (data.verified !== true) {
              throw Error('VERIFICATION_FAILED');
            }
            if (current === attempt) {
              notice.textContent = '验证通过。请手动提交要执行的查询。';
              start.disabled = false;
            }
          } catch (err) {
            fail(errorCode(err));
          }
        },
        'error-callback': () => fail('VERIFICATION_UNAVAILABLE'),
        'expired-callback': () => fail('VERIFICATION_EXPIRED')
      });
    } catch (err) {
      notice.textContent = describe(errorCode(err));
      start.disabled = false;
    }
  };
  return {ask, contextChanged: ws.contextChanged};
}
