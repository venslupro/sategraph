import {mountCatalog, mountLayers} from './catalog_views.tsx';
import {elements} from './dom.ts';
import {Globe, type ScreenPoint} from './globe.ts';
import {circularPosition, demoCatalog, GROUP_BY_ID, GROUPS, hasLineOfSight, neighborIds, normalizeOmm, orbitLabel, relatedSatellites, searchCatalog, SOURCES} from './model.ts';
import {mountWorkspace} from './online_workspace.ts';
import type {DisplayEdge, OrbitReply, OrbitRequest, Position, Satellite} from './orbit_types.ts';

const $ = elements(document);
interface ImportMetaData {
  local_import: boolean;
  filename: string;
  fetched_at: string;
  source: string;
  source_url: string
}
const icon = (id: string) =>
    '<svg class="icon small"><use href="#i-' + id + '"/></svg>';
const esc = (value: unknown) => String(value ?? '')
                                    .replace(
                                        /[&<>"']/g,
                                        c =>
                                            ({
                                              '&': '&amp;',
                                              '<': '&lt;',
                                              '>': '&gt;',
                                              '"': '&quot;',
                                              '\'': '&#39;'
                                            }[c] ??
                                             c));
const fmt = (n: number) => Number(n).toLocaleString('zh-CN');
const utc = (ms: number) =>
    new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const state = {
  mode: 'demo',
  catalog: demoCatalog(),
  byId: new Map<string, Satellite>(),
  selected: 'demo-bds-0-0',
  view: 'globe',
  layers: new Set(GROUPS.map(g => g.id)),
  speed: 1,
  simMs: Date.now(),
  positions: new Map<string, Position>(),
  relations: {membership: true, los: false, model: true},
  visible: [] as Satellite[],
  edges: [] as DisplayEdge[],
  meta: null as ImportMetaData | null,
  generation: 0,
  workerBusy: false,
  workerReady: false,
  positionMs: null as number | null,
  failed: 0,
  catalogPage: 0
};
state.byId = new Map(state.catalog.map(s => [s.id, s]));
let toastTimer: number|undefined;
let worker: Worker|null = null;
let lastWorker = 0;
let lastUi = 0;
let lastGraph = 0;
let lastDemo = 0;
let lastFrame = performance.now();
const globe: Globe = new Globe($('globe'), {
  getVisible: () => state.visible,
  getSelected: () => state.byId.get(state.selected),
  getPositions: () => state.positions,
  getEdges: () => state.edges,
  onSelect: id => selectSatellite(id),
  onHover: (p, x, y) => showHover(p, x, y),
  onError: toast,
  onFollowChange: () => {
    const b = document.getElementById('follow-sat');
    if (b) {
      b.classList.toggle('follow-active', globe.follow);
      b.setAttribute('aria-pressed', String(globe.follow));
    }
  }
});
$('auto-rotate').classList.toggle('active', globe.auto);
$('auto-rotate').setAttribute('aria-pressed', String(globe.auto));

function toast(message: string) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').hidden = true, 6500);
}
const online = mountWorkspace(document);
function showHover(p: ScreenPoint|null, x = 0, y = 0) {
  const tip = $('sat-tooltip');
  if (!p) {
    tip.hidden = true;
    return;
  }
  tip.innerHTML = '<strong>' + esc(p.sat.name) + '</strong><span>' +
      esc(GROUP_BY_ID[p.sat.group].name) + ' · ' +
      (p.sat.demo ? '示意数据' : '公开轨道推算') + '</span>';
  tip.hidden = false;
  tip.style.left =
      Math.min(x + 16, $('globe').clientWidth - tip.offsetWidth - 10) + 'px';
  tip.style.top = Math.max(130, y - 45) + 'px';
}
function updateVisible() {
  state.visible = state.catalog.filter(s => state.layers.has(s.group));
  $('total-count').textContent = fmt(state.catalog.length);
  $('visible-count').textContent = fmt(state.visible.length) + ' 颗已启用';
  $('bottom-mode').textContent = state.mode === 'demo' ?
      '示意目录 · 非实际在轨统计' :
      state.meta?.local_import ? '本地 OMM · 来源待核验' :
                                 'CelesTrak active · 公开目录';
  updateEdges();
}
const drawLayers = mountLayers($('layers'), id => {
  online.contextChanged();
  state.layers.has(id) ? state.layers.delete(id) : state.layers.add(id);
  renderLayers();
  updateVisible();
  if (state.view === 'graph') {
    renderGraph();
  }
});
const drawCatalog = mountCatalog($('catalog-body'));
function renderLayers() {
  drawLayers(state.catalog, state.layers, state.mode === 'public');
}
function updateEdges() {
  const selected = state.byId.get(state.selected);
  state.edges = [];
  if (!selected || !state.layers.has(selected.group)) {
    return;
  }
  if (state.relations.model && state.mode === 'demo' &&
      ['bds', 'iridium', 'starlink'].includes(selected.group)) {
    for (const id of neighborIds(selected, state.catalog)) {
      state.edges.push({a: selected.id, b: id, type: 'model'});
    }
  }
  if (state.relations.los) {
    const a = state.positions.get(selected.id);
    if (a) {
      for (const b of relatedSatellites(selected, state.visible, 36)) {
        if (selected.group === 'other') {
          break;
        }
        const p = state.positions.get(b.id);
        if (p && hasLineOfSight(a.physical, p.physical)) {
          state.edges.push({a: selected.id, b: b.id, type: 'los'});
        }
        if (state.edges.filter(e => e.type === 'los').length >= 8) {
          break;
        }
      }
    }
  }
}
function selectSatellite(id: string, {focus = true} = {}) {
  const sat = state.byId.get(id);
  if (!sat) {
    return;
  }
  if (id !== state.selected) {
    online.contextChanged();
  }
  state.selected = id;
  state.layers.add(sat.group);
  globe.follow = false;
  globe.path = null;
  $('suggestions').hidden = true;
  $('sat-tooltip').hidden = true;
  renderLayers();
  updateVisible();
  renderDetails();
  renderGraph();
  if (focus) {
    globe.focus(state.positions.get(id));
  }
  requestPath();
}
function detailField(label: string, value: string, mono = false) {
  return '<div class="profile-row"><dt>' + esc(label) + '</dt><dd' +
      (mono ? ' class="mono"' : '') + '>' + esc(value) + '</dd></div>';
}
function renderDetails() {
  const sat = state.byId.get(state.selected);
  const root = $('detail-content');
  $('close-detail').hidden = !sat;
  if (!sat) {
    const watch = ['25544', '48274', '40697', '39084']
                      .map(id => state.byId.get(id))
                      .filter(s => s !== undefined);
    const picks = watch.length ? watch : state.catalog.slice(0, 5);
    root.innerHTML =
        '<div class="empty-detail"><h1>每颗卫星，<br>都有自己的运行轨迹。</h1><p>点击轨道上的卫星，或在目录中搜索，查看档案与关系证据。</p></div><section class="detail-section"><h2>快速探索</h2>' +
        picks
            .map(
                s => '<button class="watch-item" data-select="' + esc(s.id) +
                    '"><i class="color-dot" style="--dot:' +
                    GROUP_BY_ID[s.group].color + '"></i>' + esc(s.name) +
                    icon('arrow') + '</button>')
            .join('') +
        '</section>';
    return;
  }
  const group = GROUP_BY_ID[sat.group];
  const publicMode = state.mode === 'public';
  const profile: [string, string, boolean?][] = [
    ['NORAD 编号', sat.norad || '未使用真实编号', true],
    ['COSPAR 编号', sat.cospar || '—', true], ['轨道类型', orbitLabel(sat)],
    ['轨道倾角', sat.inc.toFixed(2) + '°', true],
    ['轨道周期', sat.period.toFixed(1) + ' min', true],
    ['偏心率', sat.eccentricity.toFixed(6), true],
    [
      '系统运营方', group.operator + (sat.group === 'other' ? '' : '（系统级）')
    ],
    [
      '系统分类',
      publicMode ? '由名称规则推导，待交叉核验' : '演示设定，非真实卫星清单'
    ],
    [
      '轨道历元',
      publicMode && sat.epoch !== undefined ? utc(sat.epoch) + ' UTC' :
                                              '圆轨道近似，无真实轨道历元',
      publicMode
    ]
  ];
  root.innerHTML =
      '<div class="sat-heading" style="--system-color:' + group.color +
      '"><span class="system-badge"><i class="color-dot" style="--dot:' +
      group.color + '"></i>' + esc(group.name) + '</span>' +
      '<h1>' + esc(sat.name) + '</h1><span class="sat-subtitle">' +
      (publicMode ? '公开轨道 · SGP4 推算' : '示意卫星 · 圆轨道演示') +
      (sat.norad ? ' <span class="mono">/ ' + esc(sat.norad) + '</span>' : '') +
      '</span></div>' +
      '<div class="detail-actions"><button id="focus-sat" class="primary">' +
      icon('focus') +
      '聚焦</button><button id="follow-sat" aria-pressed="false">跟随</button><button id="graph-sat">' +
      icon('graph') + '图谱</button></div>' +
      '<section class="position-card"><h2><i class="status-dot"></i>' +
      (publicMode ? '轨道推算 · 非实测' : '模拟位置 · 非真实轨道') +
      '</h2><div class="position-grid">' +
      '<div><small>纬度</small><strong id="pos-lat">—</strong></div><div><small>经度</small><strong id="pos-lon">—</strong></div>' +
      '<div><small>轨道高度</small><strong id="pos-alt">—</strong></div><div><small>惯性速度</small><strong id="pos-speed">—</strong></div></div></section>' +
      '<section class="detail-section profile-section"><h2>卫星档案 <span class="tiny">/ PROFILE</span></h2><dl class="profile-list">' +
      profile.map(f => detailField(...f)).join('') + '</dl></section>' +
      '<section class="detail-section relations-section"><h2>关联关系 <span class="tiny">/ RELATIONS</span></h2>' +
      '<button class="relation-card" data-evidence="membership"><span class="relation-card-top"><span>系统归属</span><em class="mini-tag ' +
      (publicMode ? 'derived' : 'modeled') + '">' +
      (publicMode ? '名称规则推导' : '演示设定') + '</em></span><p>' +
      esc(sat.group === 'other' ? '尚无足够证据确定系统，保留为待分类。' :
                                  sat.name + ' → ' + group.name) +
      '</p></button>' +
      '<button class="relation-card" data-evidence="links"><span class="relation-card-top"><span>星间链路</span><em class="mini-tag modeled">' +
      (publicMode ? '未接入实测' : '架构示意') + '</em></span><p>' +
      (publicMode ? '不推定真实星对通信；可查看几何通视候选。' :
                    '连线用于演示关系类型，不表示实际星对、时隙或路由。') +
      '</p></button>' +
      '<div id="relation-evidence" class="evidence-box" hidden></div></section>' +
      '<p class="detail-source">' +
      (publicMode ?
           '位置来自平均轨道根数传播，不是实时遥测。<br>' +
               (state.meta?.local_import ?
                    '数据为本地导入，来源需自行核验。<br><a href="' +
                        SOURCES[0].url +
                        '" target="_blank" rel="noopener noreferrer">OMM 格式说明 ↗</a>' :
                    '目录来源：<a href="' +
                        esc(state.meta?.source_url || SOURCES[0].url) +
                        '" target="_blank" rel="noopener noreferrer">CelesTrak GP ↗</a>') :
           '所有动态位置和星间连线均为演示。<br>不用于导航、通信调度、碰撞预警或任务规划。') +
      '</p>';
  updatePositionDisplay();
}
function updatePositionDisplay() {
  const sat = state.byId.get(state.selected);
  if (!sat || !document.getElementById('pos-lat')) {
    return;
  }
  const p = state.positions.get(sat.id);
  for (const key of ['lat', 'lon', 'alt', 'speed']) {
    $('pos-' + key).textContent = '—';
  }
  if (!p) {
    return;
  }
  $('pos-lat').innerHTML = Math.abs(p.lat).toFixed(3) + '° <span>' +
      (p.lat >= 0 ? 'N' : 'S') + '</span>';
  $('pos-lon').innerHTML = Math.abs(p.lon).toFixed(3) + '° <span>' +
      (p.lon >= 0 ? 'E' : 'W') + '</span>';
  $('pos-alt').innerHTML = fmt(Math.round(p.alt)) + ' <span>km</span>';
  $('pos-speed').innerHTML = p.speed.toFixed(2) + ' <span>km/s</span>';
}
function showEvidence(type: string, target = '') {
  const box = document.getElementById('relation-evidence');
  const sat = state.byId.get(state.selected);
  if (!box || !sat) {
    return;
  }
  const g = GROUP_BY_ID[sat.group];
  box.hidden = false;
  if (type === 'membership') {
    box.innerHTML = '<strong>证据类型：' +
        (state.mode === 'public' ? '推导' : '建模 / 演示设定') +
        '</strong><p>' +
        (state.mode === 'public' ?
             '原始名称：' + esc(sat.name) +
                 '。当前通过明确前缀 / 名称规则匹配系统“' + esc(g.name) +
                 '”，不把名称规则当成运营方正式声明。应使用 GCAT、官方系统清单交叉核验。' :
             '该节点属于演示目录，归属关系由原型预先设定，未宣称对应某颗真实卫星。') +
        '</p><span class="muted">规则版本：name-rules-v1 · 未分类对象不强制归属</span>';
  } else if (type === 'los') {
    const p = state.positions.get(sat.id);
    const q = state.positions.get(target);
    const d = p && q ?
        Math.hypot(...p.physical.map((v, i) => v - q.physical[i])) :
        null;
    box.innerHTML =
        '<strong>证据类型：几何推导 · 非通信证据</strong><p>检查两颗卫星间的线段是否与半径 6,371 km 的球形地球相交。只说明几何无遮挡，不包含天线指向、距离阈值、链路预算、载荷能力或任务调度。</p><span class="muted">计算时刻：' +
        utc(state.positionMs || state.simMs) + ' UTC' +
        (d ? ' · 星间距离 ' + fmt(Math.round(d)) + ' km' : '') + '</span>';
  } else {
    box.innerHTML = '<strong>证据类型：架构建模 · 非真实拓扑</strong><p>' +
        (state.mode === 'demo' ?
             '演示目录使用同轨相邻槽位与邻轨相同槽位的假设连线，未采用真实星对连接或通信调度。仅为图谱交互示意。' :
             '未获取运营方实际链路数据，因此不绘制实际星间通信连接。轨道、同系统归属和几何通视都不能证明通信已建立。') +
        '</p><a href="' + SOURCES[6].url +
        '" target="_blank" rel="noopener noreferrer">北斗系统级星间链路能力的公开资料 ↗</a>';
  }
}
function svgEl<K extends keyof SVGElementTagNameMap>(
    tag: K, attrs: Record<string, string|number> = {}, text?: string) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}
function graphLine(
    svg: SVGSVGElement, a: {x: number; y: number}, b: {x: number; y: number},
    type: string, label: string, target: string) {
  const col = type === 'membership' ? '#ffb85b' :
      type === 'los'                ? '#b3c5db' :
                                      '#3fd0ff';
  const line = svgEl('line', {
    x1: a.x,
    y1: a.y,
    x2: b.x,
    y2: b.y,
    stroke: col,
    'stroke-opacity': .5,
    'stroke-width': type === 'membership' ? 1 : 1.3,
    'stroke-dasharray': type === 'membership' ?
        (state.mode === 'public' ? '6 4' : '2 5') :
        type === 'los' ? '6 4' :
                         '9 4 2 4'
  });
  const hit = svgEl('line', {
    x1: a.x,
    y1: a.y,
    x2: b.x,
    y2: b.y,
    stroke: 'transparent',
    'stroke-width': 14,
    class: 'graph-edge',
    tabindex: 0,
    role: 'button',
    'aria-label': label + '，查看证据'
  });
  const show = () =>
      showEvidence(type === 'membership' ? 'membership' : type, target);
  hit.addEventListener('click', show);
  hit.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      show();
    }
  });
  svg.append(line, hit);
}
function renderGraph() {
  const svg = $('graph');
  svg.replaceChildren();
  const selected = state.byId.get(state.selected);
  svg.setAttribute('viewBox', '0 0 620 520');
  if (!selected) {
    svg.append(svgEl(
        'text', {
          x: 310,
          y: 250,
          'text-anchor': 'middle',
          fill: '#8fa6c1',
          'font-size': 13
        },
        '请先选择卫星以探索关系'));
    return;
  }
  const group = GROUP_BY_ID[selected.group];
  const modelIds = neighborIds(selected, state.catalog);
  const related = selected.group === 'other' ?
      [] :
      relatedSatellites(selected, state.catalog, 12);
  const relatedMap = new Map([
    ...modelIds.map(id => state.byId.get(id)).filter(s => s !== undefined),
    ...related
  ].map(s => [s.id, s]));
  const satellites =
      [selected, ...Array.from(relatedMap.values()).slice(0, 12)];
  const orbit = svgEl('circle', {
    cx: 310,
    cy: 250,
    r: 200,
    fill: 'none',
    stroke: '#1a344d',
    'stroke-width': .7,
    'stroke-dasharray': '3 6'
  });
  svg.append(orbit, svgEl('circle', {
               cx: 310,
               cy: 250,
               r: 126,
               fill: 'none',
               stroke: '#112b43',
               'stroke-width': .7
             }));
  const nodes = satellites.map((sat, i) => {
    const angle = (i / satellites.length) * Math.PI * 2 - Math.PI / 2;
    return {
      sat,
      x: 310 + Math.cos(angle) * 200,
      y: 250 + Math.sin(angle) * 200
    };
  });
  if (state.relations.membership && selected.group !== 'other') {
    const center = {x: 310, y: 250};
    for (const node of nodes) {
      graphLine(svg, center, node, 'membership', '系统归属', node.sat.id);
    }
    const hub = svgEl('g', {
      class: 'graph-node',
      tabindex: 0,
      role: 'button',
      'aria-label': group.name + '，查看分类证据'
    });
    hub.append(
        svgEl('circle', {
          cx: 310,
          cy: 250,
          r: 46,
          fill: '#0c2035',
          stroke: group.color,
          'stroke-opacity': .6,
          'stroke-width': 1.1
        }),
        svgEl('circle', {
          cx: 310,
          cy: 250,
          r: 55,
          fill: 'none',
          stroke: group.color,
          'stroke-opacity': .1,
          'stroke-width': 1
        }));
    hub.append(
        svgEl(
            'text', {
              x: 310,
              y: 248,
              'text-anchor': 'middle',
              style: 'font-size:15px;fill:' + group.color
            },
            group.short),
        svgEl(
            'text', {
              x: 310,
              y: 268,
              'text-anchor': 'middle',
              style: 'font-size:8px;fill:#718aa5'
            },
            state.mode === 'demo' ? '示意系统节点' : '名称规则分类'));
    hub.addEventListener('click', () => showEvidence('membership'));
    hub.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        showEvidence('membership');
      }
    });
    svg.append(hub);
  } else if (selected.group === 'other') {
    svg.append(svgEl(
        'text', {
          x: 310,
          y: 245,
          'text-anchor': 'middle',
          fill: '#8fa6c1',
          'font-size': 11
        },
        '系统待分类，不强行建立归属'));
  }
  const byId = new Map(nodes.map(n => [n.sat.id, n]));
  for (const edge of state.edges) {
    const a = byId.get(edge.a);
    const b = byId.get(edge.b);
    if (a && b) {
      graphLine(
          svg, a, b, edge.type,
          edge.type === 'los' ? '几何通视候选' : '架构示意', edge.b);
    }
  }
  for (const node of nodes) {
    const active = node.sat.id === selected.id;
    const color = GROUP_BY_ID[node.sat.group].color;
    const el = svgEl('g', {
      class: 'graph-node',
      tabindex: 0,
      role: 'button',
      'aria-label': node.sat.name + '，选择卫星'
    });
    if (active) {
      el.append(svgEl('circle', {
        cx: node.x,
        cy: node.y,
        r: 24,
        fill: color,
        'fill-opacity': .07,
        stroke: color,
        'stroke-opacity': .3,
        'stroke-width': 1
      }));
    }
    el.append(svgEl('circle', {
      cx: node.x,
      cy: node.y,
      r: active ? 12 : 7,
      fill: active ? '#163148' : '#0d2338',
      stroke: color,
      'stroke-width': active ? 2 : 1.1
    }));
    el.append(svgEl(
        'circle', {cx: node.x, cy: node.y, r: active ? 3 : 2, fill: color}));
    const name = node.sat.name.length > 24 ? node.sat.name.slice(0, 22) + '…' :
                                             node.sat.name;
    el.append(svgEl(
        'text', {
          x: node.x,
          y: node.y + 31,
          'text-anchor': 'middle',
          style: active ? 'fill:' + color + ';font-size:11px' : ''
        },
        name));
    el.append(svgEl(
        'text', {
          x: node.x,
          y: node.y + 45,
          'text-anchor': 'middle',
          style: 'fill:#526d87;font-size:8px'
        },
        node.sat.norad ? 'NORAD ' + node.sat.norad : '演示节点'));
    const choose = () => selectSatellite(node.sat.id, {focus: false});
    el.addEventListener('click', choose);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        choose();
      }
    });
    svg.append(el);
  }
  const legend = svgEl('g');
  legend.append(svgEl(
      'text', {
        x: 310,
        y: 510,
        'text-anchor': 'middle',
        fill: '#627e99',
        'font-size': 8
      },
      '所选卫星的局部关系 · 最多展示 13 个卫星节点 · 非完整通信网络'));
  svg.append(legend);
}
function switchView(view: 'globe'|'graph') {
  state.view = view;
  $('globe').hidden = view !== 'globe';
  $('graph-view').hidden = view !== 'graph';
  for (const tab of document.querySelectorAll<HTMLElement>('[data-view]')) {
    const active = tab.dataset.view === view;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  $('view-label').textContent = view === 'globe' ? '轨道空间 / ORBITAL VIEW' :
                                                   '关系空间 / KNOWLEDGE GRAPH';
  $('scene-description').textContent = view === 'globe' ?
      '径向比例压缩 · 地球与轨道非等比例' :
      '以所选卫星为中心 · 每条连线均有证据类型';
  $('auto-rotate').hidden = view !== 'globe';
  $('zoom-in').parentElement!.hidden = view !== 'globe';
  $('scene-help').textContent = view === 'globe' ?
      '拖动旋转 · 滚轮缩放 · 点击卫星' :
      '点击节点选择 · 点击连线查看证据';
  if (view === 'graph') {
    renderGraph();
  } else {
    globe.resize();
  }
}
function searchSuggestions() {
  const query = $('search').value.trim();
  const list = $('suggestions');
  if (!query) {
    list.hidden = true;
    return;
  }
  const hits = searchCatalog(state.catalog, query);
  list.innerHTML =
      hits.slice(0, 7)
          .map(
              s => '<button class="suggestion" data-select="' + esc(s.id) +
                  '"><i class="color-dot" style="--dot:' +
                  GROUP_BY_ID[s.group].color + '"></i><span>' + esc(s.name) +
                  '</span><small>' +
                  esc(s.norad || GROUP_BY_ID[s.group].short) +
                  '</small></button>')
          .join('') +
      '<div class="suggestion-note">' +
      (hits.length ?
           '匹配 ' + fmt(hits.length) + ' 颗，点击或按 Enter 选择首项' :
           '没有匹配结果，试试系统名或 NORAD 编号') +
      '</div>';
  list.hidden = false;
}
function updateDataUi() {
  const live = state.mode === 'public';
  $('data-badge').textContent =
      live ? (state.meta?.local_import ? '本地导入' : '公开快照') : '演示模式';
  $('data-badge').className = 'mini-tag ' + (live ? 'derived' : 'modeled');
  $('use-demo').hidden = !live;
  $('load-public').textContent = live ? '导入另一份 OMM' : '导入 OMM';
  $('data-description').textContent = live && state.meta ?
      (state.meta?.local_import ?
           '本地导入：' + state.meta.filename + '。文件修改时间 ' +
               utc(Date.parse(state.meta.fetched_at)) +
               ' UTC；请自行核验来源。' :
           '快照获取于 ' + utc(Date.parse(state.meta.fetched_at)) +
               ' UTC。位置由 SGP4 推算；分类来自名称规则。') :
      '当前为圆轨道示意。在线源暂不可用时，可导入公开 OMM JSON；不会自动重复下载。';
  $('mode-note').textContent =
      live ? '公开轨道推算 · 非实时遥测' : '示意轨道，不用于导航与安全决策';
  $('rel-model').disabled = live;
  $('link-note').textContent = live ?
      '未接入真实链路数据。通视、同系统归属不等于通信连接。' :
      '架构连线只在演示模式显示，不代表实际通信拓扑。';
  $('rel-membership').parentElement!.querySelector('em')!.textContent =
      live ? '推导' : '设定';
}
function startWorker() {
  if (worker) {
    return;
  }
  try {
    worker = new Worker(
        new URL('./orbit-worker.js', import.meta.url), {type: 'module'});
    worker.onmessage = ({data}: MessageEvent<OrbitReply>) => {
      if (data.generation !== state.generation || state.mode !== 'public') {
        return;
      }
      if (data.type === 'ready') {
        state.workerReady = true;
        state.workerBusy = false;
        requestPositions();
        requestPath();
      }
      if (data.type === 'positions') {
        const first = !state.positions.size;
        state.positions = new Map(data.positions.map(p => [p.id, p]));
        state.positionMs = data.ms;
        state.failed = data.failed;
        state.workerBusy = false;
        updateEdges();
        updatePositionDisplay();
        if (first) {
          globe.focus(state.positions.get(state.selected));
        }
        if (state.view === 'graph') {
          renderGraph();
        }
      }
      if (data.type === 'path' && data.id === state.selected) {
        globe.path = data;
      }
    };
    worker.onerror = () => {
      state.workerBusy = false;
      state.workerReady = false;
      toast(
          '轨道计算模块未能运行，请确认已执行 npm install。可继续使用演示模式。');
    };
  } catch {
    toast('当前浏览器不支持独立计算线程，请使用新版浏览器。');
  }
}
function requestPositions() {
  if (state.mode !== 'public' || !worker || !state.workerReady ||
      state.workerBusy) {
    return;
  }
  state.workerBusy = true;
  worker.postMessage({
    type: 'positions',
    generation: state.generation,
    ms: state.simMs
  } satisfies OrbitRequest);
  lastWorker = performance.now();
}
function requestPath() {
  const s = state.byId.get(state.selected);
  if (state.mode === 'public' && s && worker && state.workerReady) {
    worker.postMessage({
      type: 'path',
      generation: state.generation,
      id: s.id,
      ms: state.simMs,
      period: s.period
    } satisfies OrbitRequest);
  }
}
function activatePublic(rows: unknown, meta: ImportMetaData) {
  if (!Array.isArray(rows)) {
    throw Error('轨道数据必须是 JSON 数组');
  }
  const catalog = normalizeOmm(rows);
  if (!catalog.length) {
    throw new Error('文件没有可传播的 OMM 轨道记录，请检查格式');
  }
  online.contextChanged();
  const previous = state.byId.get(state.selected)?.norad;
  state.catalog = catalog;
  state.byId = new Map(catalog.map(s => [s.id, s]));
  state.mode = 'public';
  state.meta = meta;
  state.failed = 0;
  state.generation++;
  state.positions = new Map();
  state.positionMs = null;
  state.workerReady = false;
  state.workerBusy = false;
  state.selected = previous && state.byId.has(previous) ?
      previous :
      (catalog.find(s => s.group === 'bds') || catalog[0]).id;
  state.layers = new Set(GROUPS.map(g => g.id));
  state.simMs = Date.now();
  state.speed = 1;
  document.querySelectorAll<HTMLElement>('[data-speed]').forEach(b => {
    b.classList.toggle('active', b.dataset.speed === '1');
    b.setAttribute('aria-pressed', String(b.dataset.speed === '1'));
  });
  globe.path = null;
  globe.follow = false;
  renderLayers();
  updateVisible();
  renderDetails();
  renderGraph();
  updateDataUi();
  startWorker();
  worker?.postMessage({
    type: 'catalog',
    generation: state.generation,
    rows: catalog.map(s => s.omm)
  } satisfies OrbitRequest);
  const ignored = rows.length - catalog.length;
  if (ignored) {
    toast(
        '已加载 ' + fmt(catalog.length) + ' 颗；跳过 ' + fmt(ignored) +
        ' 条重复或不可用记录。');
  }
}
function activateDemo() {
  online.contextChanged();
  state.mode = 'demo';
  state.generation++;
  state.catalog = demoCatalog();
  state.byId = new Map(state.catalog.map(s => [s.id, s]));
  state.positions = new Map();
  state.selected = 'demo-bds-0-0';
  state.layers = new Set(GROUPS.map(g => g.id));
  state.positionMs = null;
  state.failed = 0;
  globe.path = null;
  globe.follow = false;
  updateDemo();
  renderLayers();
  updateVisible();
  renderDetails();
  renderGraph();
  updateDataUi();
}
function updateDemo() {
  state.positions =
      new Map(state.catalog.map(s => [s.id, circularPosition(s, state.simMs)]));
  state.positionMs = state.simMs;
}
function renderCatalog() {
  const group = $('catalog-group').value;
  const query = $('catalog-search').value;
  const hits = searchCatalog(state.catalog, query)
                   .filter(s => !group || s.group === group);
  const size = 40;
  const pages = Math.max(1, Math.ceil(hits.length / size));
  state.catalogPage = Math.min(state.catalogPage, pages - 1);
  $('catalog-summary').textContent = fmt(hits.length) + ' 条匹配 · ' +
      (state.mode === 'demo' ? '演示目录，不代表真实在轨数量' :
           state.meta?.local_import ?
                               '本地 OMM 文件，系统按名称分类' :
                               'CelesTrak active 公开目录，系统按名称分类');
  drawCatalog(
      hits.slice(state.catalogPage * size, (state.catalogPage + 1) * size));
  $('catalog-page').textContent = (state.catalogPage + 1) + ' / ' + pages;
  $('catalog-prev').disabled = state.catalogPage === 0;
  $('catalog-next').disabled = state.catalogPage >= pages - 1;
}
function openCatalog() {
  $('catalog-group').innerHTML = '<option value="">全部系统</option>' +
      GROUPS
          .map(g => '<option value="' + g.id + '">' + esc(g.name) + '</option>')
          .join('');
  state.catalogPage = 0;
  renderCatalog();
  $('catalog-dialog').showModal();
}
function runPrompt(text: string) {
  return online.ask(text);
}
document.addEventListener('click', e => {
  if (!(e.target instanceof Element)) {
    return;
  }
  const select = e.target.closest<HTMLElement>('[data-select]');
  if (select?.dataset.select) {
    selectSatellite(select.dataset.select);
    if ($('catalog-dialog').open) {
      $('catalog-dialog').close();
    }
    return;
  }
  const source = e.target.closest('[data-action="sources"]');
  if (source) {
    $('sources-dialog').showModal();
    return;
  }
  const close = e.target.closest<HTMLElement>('[data-close]');
  if (close?.dataset.close) {
    const dialog = document.getElementById(close.dataset.close);
    if (dialog instanceof HTMLDialogElement) {
      dialog.close();
    }
    return;
  }
  const prompt = e.target.closest<HTMLElement>('[data-prompt]');
  if (prompt?.dataset.prompt) {
    runPrompt(prompt.dataset.prompt);
    return;
  }
  const view = e.target.closest<HTMLElement>('[data-view]');
  if (view?.dataset.view === 'globe' || view?.dataset.view === 'graph') {
    switchView(view.dataset.view);
    return;
  }
  const evidence = e.target.closest<HTMLElement>('[data-evidence]');
  if (evidence?.dataset.evidence) {
    showEvidence(evidence.dataset.evidence);
    return;
  }
  if (e.target.closest('#focus-sat')) {
    globe.focus(state.positions.get(state.selected));
    switchView('globe');
  }
  const followButton = e.target.closest<HTMLButtonElement>('#follow-sat');
  if (followButton) {
    globe.follow = !globe.follow;
    followButton.classList.toggle('follow-active', globe.follow);
    followButton.setAttribute('aria-pressed', String(globe.follow));
    switchView('globe');
  }
  if (e.target.closest('#graph-sat')) {
    switchView('graph');
  }
  if (!e.target.closest('.search-wrap')) {
    $('suggestions').hidden = true;
  }
});
document.addEventListener('keydown', e => {
  if (e.key === '/' &&
      !['INPUT', 'TEXTAREA', 'SELECT'].includes(
          document.activeElement?.tagName ?? '')) {
    e.preventDefault();
    $('search').focus();
  }
  if (e.key === 'Escape') {
    $('suggestions').hidden = true;
    $('assistant-result').hidden = true;
  }
  const row = e.target instanceof Element &&
      e.target.closest<HTMLElement>('#catalog-body tr[data-select]');
  if (row && row.dataset.select && e.key === 'Enter') {
    selectSatellite(row.dataset.select);
    $('catalog-dialog').close();
  }
});
$('all-layers').onclick = () => {
  online.contextChanged();
  state.layers = new Set(GROUPS.map(g => g.id));
  renderLayers();
  updateVisible();
};
$('no-layers').onclick = () => {
  online.contextChanged();
  state.layers.clear();
  renderLayers();
  updateVisible();
};
for (const type of ['membership', 'los', 'model'] as const) {
  $(`rel-${type}`).onchange = () => {
    online.contextChanged();
    state.relations[type] = $(`rel-${type}`).checked;
    updateEdges();
    renderGraph();
    if (type === 'los' && state.relations.los) {
      toast('几何通视只说明无遮挡，不代表通信链路存在。');
    }
  };
}
$('search').addEventListener('input', searchSuggestions);
$('search').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const hits = searchCatalog(state.catalog, $('search').value);
    if (hits[0]) {
      selectSatellite(hits[0].id);
    }
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    $('suggestions').querySelector('button')?.focus();
  }
});
$('auto-rotate').onclick = () => {
  globe.auto = !globe.auto;
  $('auto-rotate').classList.toggle('active', globe.auto);
  $('auto-rotate').setAttribute('aria-pressed', String(globe.auto));
};
$('reset-view').onclick = () => {
  globe.reset();
  if (state.view === 'graph') {
    selectSatellite(state.selected, {focus: false});
  }
  toast('已重置视角。');
};
$('zoom-in').onclick = () => globe.zoom(1.2);
$('zoom-out').onclick = () => globe.zoom(1 / 1.2);
$('close-detail').onclick = () => {
  online.contextChanged();
  state.selected = '';
  globe.follow = false;
  updateEdges();
  renderDetails();
  renderGraph();
};
for (const b of document.querySelectorAll<HTMLElement>('[data-speed]')) {
  b.onclick = () => {
    online.contextChanged();
    state.speed = Number(b.dataset.speed);
    document.querySelectorAll('[data-speed]').forEach(el => {
      const active = el === b;
      el.classList.toggle('active', active);
      el.setAttribute('aria-pressed', String(active));
    });
    if (state.speed > 1 && state.mode === 'public') {
      toast('已开启时间快进。远离轨道历元的预测误差会增大。');
    }
  };
}
$('assistant-form').onsubmit = e => {
  e.preventDefault();
  runPrompt($('assistant-query').value);
};
$('catalog-button').onclick = openCatalog;
for (const id of ['catalog-search', 'catalog-group']) {
  $(id).addEventListener(id === 'catalog-search' ? 'input' : 'change', () => {
    state.catalogPage = 0;
    renderCatalog();
  });
}
$('catalog-prev').onclick = () => {
  state.catalogPage--;
  renderCatalog();
};
$('catalog-next').onclick = () => {
  state.catalogPage++;
  renderCatalog();
};
$('use-demo').onclick = () => {
  activateDemo();
  toast('已切换为明确标注的演示数据。');
};
$('source-grid').innerHTML =
    SOURCES
        .map(
            s =>
                '<article class="source-card"><div class="source-card-head"><h3>' +
                esc(s.name) + '</h3><span class="source-tag">' + esc(s.tag) +
                '</span></div><p>' + esc(s.text) +
                '</p><div class="source-card-foot"><span>' + esc(s.access) +
                ' · ' + esc(s.status) + '</span><a href="' + esc(s.url) +
                '" target="_blank" rel="noopener noreferrer">官方来源 ↗</a></div></article>')
        .join('');
const importInput = document.createElement('input');
importInput.type = 'file';
importInput.accept = '.json,application/json';
importInput.hidden = true;
importInput.id = 'import-omm';
document.body.append(importInput);
$('load-public').onclick = () => importInput.click();
importInput.onchange = async () => {
  const file = importInput.files?.[0];
  if (!file) {
    return;
  }
  try {
    if (file.size > 30_000_000) {
      throw new Error('文件超过 30 MB，请先缩小目录范围');
    }
    const data = JSON.parse(await file.text());
    const rows = Array.isArray(data) ? data : data.rows;
    activatePublic(rows, {
      source: '本地导入的 OMM JSON',
      local_import: true,
      filename: file.name,
      fetched_at: new Date(file.lastModified).toISOString(),
      source_url: SOURCES[0].url
    });
    toast('已导入 ' + fmt(state.catalog.length) + ' 条 OMM 轨道记录。');
  } catch (error) {
    toast(
        '导入失败：' +
        (error instanceof Error ? error.message : '无法读取文件'));
  } finally {
    importInput.value = '';
  }
};
function frame(now: number) {
  const dt = Math.min(.1, (now - lastFrame) / 1000);
  lastFrame = now;
  state.simMs += dt * 1000 * state.speed;
  if (state.mode === 'demo' && now - lastDemo > 100) {
    updateDemo();
    updateEdges();
    lastDemo = now;
  }
  if (state.mode === 'public' && now - lastWorker > 1100) {
    requestPositions();
  }
  if (state.view === 'globe') {
    globe.draw(now, dt, state.simMs);
  }
  if (now - lastUi > 500) {
    $('clock').textContent = utc(state.simMs);
    updatePositionDisplay();
    const ok = state.visible.reduce(
        (n, s) => n + (state.positions.has(s.id) ? 1 : 0), 0);
    $('render-status').textContent = fmt(ok) + ' 颗可视化' +
        (state.mode === 'demo' ? ' · 圆轨道示意' : ' · SGP4') +
        (state.failed ? ' · ' + fmt(state.failed) + ' 颗传播失败' : '');
    const epoch = state.byId.get(state.selected)?.epoch;
    if (state.mode === 'public' && epoch !== undefined &&
        Math.abs(state.simMs - epoch) > 7 * 86400000) {
      $('render-status').textContent += ' · 轨道历元相差超过 7 天';
    }
    lastUi = now;
  }
  if (state.view === 'graph' && now - lastGraph > 3500) {
    renderGraph();
    lastGraph = now;
  }
  requestAnimationFrame(frame);
}
updateDemo();
renderLayers();
updateVisible();
renderDetails();
renderGraph();
updateDataUi();
requestAnimationFrame(frame);
