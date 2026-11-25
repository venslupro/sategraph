import {askAssistant, describe, jsonApi, resolveAction, session} from './online_client.js';

const base = '/api/v1/';
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const contextKeys = [
  'from', 'to', 'scenario_id', 'analysis_time', 'purpose', 'orbit_manifest_id',
  'model_version'
];
const analysis = ['path', 'neighbors', 'common-neighbors', 'degree'];
const isRecord = value =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const post = body => ({
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify(body)
});

function manualRoute(kind, fields, revision) {
  if (analysis.includes(kind)) {
    const pair = kind === 'path' || kind === 'common-neighbors';
    const body = {context_revision: revision};
    for (const key of contextKeys.filter(key => key !== 'to' || pair)) {
      const value = fields.context[key];
      if (!value || !identifier.test(value)) throw Error('CONDITIONS_REQUIRED');
      body[key] = value;
    }
    return [base + 'analysis/' + kind, post(body)];
  }
  if (kind === 'search')
    return [
      base + 'catalog/search?' +
          new URLSearchParams({q: fields.q, limit: '25'}),
      {}
    ];
  if (kind === 'statistics') return [base + 'catalog/statistics', {}];
  if (kind === 'scenarios') return [base + 'scenarios?limit=25', {}];
  if (!fields.id || !identifier.test(fields.id)) throw Error('ID_REQUIRED');
  const id = encodeURIComponent(fields.id);
  const routes = {
    entity: 'satellites/' + id,
    evidence: 'evidence/' + id,
    system: 'systems/' + id,
    scenario: 'scenarios/' + id,
    members: 'systems/' + id + '/members',
    relations: 'graph/relations?' + new URLSearchParams({root: fields.id})
  };
  if (!Object.hasOwn(routes, kind)) throw Error('INVALID_QUERY');
  return [base + routes[kind], {}];
}

// 每次提交冻结自己的条件；晚到的结果不能改变较新请求的面板或历史。
export function workspace({fields, render, send = fetch}) {
  const memory = session();
  let state = {status: '', records: [], views: [], text: '', busy: false};
  const show = patch => {
    state = {...state, ...patch};
    render(state);
  };
  const clear = (status, busy = false) =>
      show({status, records: [], views: [], text: '', busy});
  function invalidate(status) {
    memory.invalidate();
    if (state.busy || state.status) clear(status);
  }
  async function ask(message) {
    message = message.trim();
    if (!message) return;
    const req = memory.begin(), refs = new Map(), cited = new Set(),
          actions = [];
    let terminal = '', error = '', answer = '';
    clear('RUNNING', true);
    try {
      const input = {
        message,
        context_revision: req.revision,
        context: fields().context,
        history: memory.history.slice()
      };
      await askAssistant(input, e => {
        if (!req.current()) return;
        const d = e.data;
        switch (e.event) {
          case 'request_started':
          case 'step_started':
            break;
          case 'tool_result':
            if (refs.size >= 8 || d.ref !== refs.size + 1 ||
                typeof d.tool !== 'string' || !isRecord(d.data))
              throw Error('INTERRUPTED');
            refs.set(d.ref, d);
            show({records: [...refs.values()]});
            break;
          case 'text_delta':
            if (typeof d.text !== 'string' ||
                (d.refs !== undefined &&
                 (!Array.isArray(d.refs) || !d.refs.every(n => refs.has(n)))))
              throw Error('INVALID_REFERENCE');
            for (const n of d.refs || []) cited.add(n);
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
            terminal = d.status;
            break;
          default:
            throw Error('INTERRUPTED');
        }
      }, req.signal, send);
      if (!req.current()) return;
      if (error) {
        show({status: error, busy: false});
        return;
      }
      if (!['COMPLETED', 'WAITING_USER'].includes(terminal) || !answer ||
          (terminal === 'COMPLETED' && !cited.size))
        throw Error('INTERRUPTED');
      const views = terminal === 'COMPLETED' ?
          actions.filter(a => cited.has(a.ref))
              .map(a => resolveAction(a, refs, req.revision))
              .filter(Boolean) :
          [];
      memory.remember('user', message);
      memory.remember('assistant', answer);
      show({status: terminal, views, busy: false});
    } catch (err) {
      if (req.current()) show({status: err.message, busy: false, views: []});
    }
  }
  async function manual(kind) {
    const req = memory.begin();
    clear('RUNNING', true);
    try {
      const [path, init] = manualRoute(kind, fields(), req.revision);
      const data = await jsonApi(path, {...init, signal: req.signal}, send);
      if (!req.current()) return;
      if (!isRecord(data) ||
          (analysis.includes(kind) && data.context_revision !== req.revision))
        throw Error('INTERRUPTED');
      const record = {ref: 1, tool: kind, data};
      show(
          {status: data.status || 'COMPLETED', busy: false, records: [record]});
    } catch (err) {
      if (req.current()) show({status: err.message, busy: false});
    }
  }
  return {
    ask,
    manual,
    cancel: () => invalidate('CANCELLED'),
    contextChanged: () => invalidate('CONTEXT_CHANGED')
  };
}

const readerNames = {
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
function summary(d) {
  if (d.status === 'FOUND' && Array.isArray(d.ordered_node_ids))
    return d.ordered_node_ids.join(' → ') + '（' + d.hop_count +
        ' 跳；未验证实际转发）';
  if (Number.isSafeInteger(d.objects_with_orbit))
    return '获准展示的有轨道对象：' + d.objects_with_orbit + ' 个';
  if (Array.isArray(d.items))
    return '本页 ' + d.items.length + ' 条' +
        (d.next_cursor ? '，尚有后续记录' : '');
  if (d.entity_id)
    return [d.display_name, d.entity_id, d.source_id].filter(Boolean).join(
        ' · ');
  return describe(d.status || 'COMPLETED');
}

function loadTurnstile(doc) {
  if (doc.defaultView.turnstile)
    return Promise.resolve(doc.defaultView.turnstile);
  return new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    script.src =
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => doc.defaultView.turnstile ?
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
    doc, {send = fetch, challenge = loadTurnstile} = {}) {
  const el = id => doc.getElementById(id), form = el('manual-query');
  const fields = () => {
    const context = {};
    for (const key of contextKeys) {
      const value = form.elements.namedItem(key).value.trim();
      if (value) context[key] = value;
    }
    const id = el('online-id').value.trim();
    if (id && el('manual-kind').value === 'entity') context.entity_id = id;
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
        const details = doc.createElement('details'),
              title = doc.createElement('summary'),
              pre = doc.createElement('pre');
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
        if (r.tool === 'get_entity') {
          el('online-id').value = r.data.entity_id;
          el('manual-kind').value = 'entity';
        }
      }
    }
  });
  const dialog = el('online-dialog');
  const open = () => {
    if (!dialog.open) dialog.showModal();
  };
  const ask = text => {
    if (!text.trim()) return;
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
  doc.defaultView.addEventListener('pagehide', ws.cancel);
  const start = el('access-start'), notice = el('access-status');
  let api, widget, attempt = 0;
  start.onclick = async () => {
    const current = ++attempt;
    start.disabled = true;
    notice.textContent = '正在读取访问配置…';
    try {
      if (widget !== undefined) {
        api.remove(widget);
        widget = undefined;
      }
      const {sitekey} = await jsonApi(base + 'access/config', {}, send);
      if (typeof sitekey !== 'string' ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(sitekey))
        throw Error('ACCESS_NOT_CONFIGURED');
      api = await challenge(doc);
      notice.textContent = '请完成验证。';
      const fail = code => {
        if (current === attempt) {
          notice.textContent = describe(code);
          start.disabled = false;
        }
      };
      widget = api.render(el('access-widget'), {
        sitekey,
        action: 'sategraph_access',
        callback: async token => {
          if (current !== attempt) return;
          try {
            const data =
                await jsonApi(base + 'access/verify', post({token}), send);
            if (data.verified !== true) throw Error('VERIFICATION_FAILED');
            if (current === attempt) {
              notice.textContent = '验证通过。请手动提交要执行的查询。';
              start.disabled = false;
            }
          } catch (err) {
            fail(err.message);
          }
        },
        'error-callback': () => fail('VERIFICATION_UNAVAILABLE'),
        'expired-callback': () => fail('VERIFICATION_EXPIRED')
      });
    } catch (err) {
      notice.textContent = describe(err.message);
      start.disabled = false;
    }
  };
  return {ask, contextChanged: ws.contextChanged};
}
