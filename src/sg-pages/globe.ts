import {circularPosition, displayRadius, GROUP_BY_ID, hasLineOfSight, RAD} from './model.ts';
import type {DisplayEdge, Position, Satellite} from './orbit_types.ts';

export interface ScreenPoint {
  x: number;
  y: number;
  depth: number;
  hidden: boolean;
  id: string;
  sat: Satellite;
  position: Position;
}
interface GlobeOptions {
  getVisible(): Satellite[];
  getSelected(): Satellite|undefined;
  getPositions(): Map<string, Position>;
  getEdges(): DisplayEdge[];
  onSelect(id: string): void;
  onError(message: string): void;
  onHover(p: ScreenPoint|null, x?: number, y?: number): void;
  onFollowChange(follow: boolean): void;
}

const TAU = Math.PI * 2;
const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + [(n >> 16) & 255, (n >> 8) & 255, n & 255, a].join(',') +
      ')';
};
function inPolygon(x: number, y: number, poly: number[][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a[1] > y) !== (b[1] > y) &&
        x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}
export class Globe {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  options: GlobeOptions;
  view: {yaw: number; pitch: number; zoom: number};
  auto: boolean;
  follow: boolean;
  target: {yaw: number; pitch: number}|null;
  drag: {x: number; y: number; moved: number}|null;
  screen: ScreenPoint[];
  dots: number[][];
  land: number[][][];
  path: {id: string; points: number[][]}|null;
  stars: number[][];
  resizeObserver: ResizeObserver;
  dpr = 1;
  w = 0;
  h = 0;
  cx = 0;
  cy = 0;
  radius = 0;

  constructor(canvas: HTMLCanvasElement, options: GlobeOptions) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw Error('当前浏览器不能创建 Canvas 2D 画布');
    }
    this.ctx = ctx;
    this.options = options;
    this.view = {yaw: -.32, pitch: -.27, zoom: 1};
    this.auto = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.follow = false;
    this.target = null;
    this.drag = null;
    this.screen = [];
    this.dots = [];
    this.land = [];
    this.path = null;
    this.stars = Array.from({length: 290}, (_, i) => {
      const rand = (n: number) => {
        const x = Math.sin(i * 127.1 + n * 311.7) * 43758.5453;
        return x - Math.floor(x);
      };
      return [rand(1), rand(2), rand(3), rand(4)];
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.installEvents();
    this.loadLand();
  }
  async loadLand() {
    try {
      this.land = await (await fetch('./data/land.json')).json();
      for (let lat = -84; lat < 87; lat += 1.65) {
        const la = lat * RAD;
        for (let lon = -180; lon < 180;
             lon += 1.65 / Math.max(.12, Math.cos(la))) {
          if (lat < -71 || this.land.some(poly => inPolygon(lon, lat, poly))) {
            const lo = lon * RAD;
            this.dots.push([
              Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo),
              Math.sin(la)
            ]);
          }
        }
      }
    } catch {
      this.options.onError?.('海岸线未加载，仍可浏览轨道。');
    }
  }
  resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.max(1, Math.round(this.w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.h * this.dpr));
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }
  installEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      this.drag = {x: e.clientX, y: e.clientY, moved: 0};
      this.target = null;
      c.style.cursor = 'grabbing';
    });
    c.addEventListener('pointermove', e => {
      if (this.drag) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        this.drag.x = e.clientX;
        this.drag.y = e.clientY;
        this.drag.moved += Math.abs(dx) + Math.abs(dy);
        this.view.yaw -= dx * .006 / this.view.zoom;
        this.view.pitch = Math.max(
            -1.42,
            Math.min(1.42, this.view.pitch - dy * .006 / this.view.zoom));
        if (this.drag.moved > 5 && this.follow) {
          this.follow = false;
          this.options.onFollowChange?.(false);
        }
      } else {
        const rect = c.getBoundingClientRect();
        const p = this.pick(e.clientX - rect.left, e.clientY - rect.top);
        c.style.cursor = p ? 'pointer' : 'grab';
        this.options.onHover?.(p, e.clientX - rect.left, e.clientY - rect.top);
      }
    });
    c.addEventListener('pointerup', e => {
      if (!this.drag) {
        return;
      }
      const click = this.drag.moved < 5;
      this.drag = null;
      c.style.cursor = 'grab';
      if (click) {
        const rect = c.getBoundingClientRect();
        const s = this.pick(e.clientX - rect.left, e.clientY - rect.top);
        if (s) {
          this.options.onSelect(s.id);
        }
      }
    });
    c.addEventListener('pointercancel', () => {
      this.drag = null;
      c.style.cursor = 'grab';
    });
    c.addEventListener('pointerleave', () => this.options.onHover?.(null));
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.zoom(Math.exp(-e.deltaY * .001));
    }, {passive: false});
    c.addEventListener('keydown', e => {
      if ([
            'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-',
            'Escape'
          ].includes(e.key)) {
        e.preventDefault();
      }
      if (e.key === 'ArrowLeft') {
        this.view.yaw -= .12;
      }
      if (e.key === 'ArrowRight') {
        this.view.yaw += .12;
      }
      if (e.key === 'ArrowUp') {
        this.view.pitch = Math.min(1.42, this.view.pitch + .12);
      }
      if (e.key === 'ArrowDown') {
        this.view.pitch = Math.max(-1.42, this.view.pitch - .12);
      }
      if (e.key === '+') {
        this.zoom(1.15);
      }
      if (e.key === '-') {
        this.zoom(1 / 1.15);
      }
      if (e.key === 'Escape') {
        this.reset();
      }
    });
  }
  zoom(factor: number) {
    this.view.zoom = Math.max(.55, Math.min(2.7, this.view.zoom * factor));
  }
  reset() {
    this.view = {yaw: -.32, pitch: -.27, zoom: 1};
    this.target = null;
    this.follow = false;
    this.options.onFollowChange?.(false);
  }
  focus(position: Position|undefined) {
    if (!position) {
      return;
    }
    const wanted = Math.PI / 2 - position.lon * RAD;
    const delta =
        ((wanted - this.view.yaw) % (TAU) + 3 * Math.PI) % TAU - Math.PI;
    this.target = {
      yaw: this.view.yaw + delta,
      pitch: Math.max(-1.3, Math.min(1.3, -position.lat * RAD))
    };
  }
  pick(x: number, y: number) {
    let best = null;
    let distance = 12;
    for (const s of this.screen) {
      const d = Math.hypot(x - s.x, y - s.y);
      if (!s.hidden && d < distance) {
        best = s;
        distance = d;
      }
    }
    return best;
  }
  project(v: number[]) {
    const {yaw, pitch} = this.view;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const x = v[0] * c - v[1] * s;
    const y = v[0] * s + v[1] * c;
    const z = v[2];
    const depth = y * cp - z * sp;
    const up = y * sp + z * cp;
    return {
      x: this.cx + x * this.radius,
      y: this.cy - up * this.radius,
      depth,
      hidden: depth < 0 && x * x + up * up < 1
    };
  }
  drawPath(points: number[][], color: string, width = 1, dash: number[] = []) {
    const ctx = this.ctx;
    ctx.beginPath();
    let pen = false;
    for (const v of points) {
      const p = this.project(v);
      if (p.hidden) {
        pen = false;
        continue;
      }
      if (pen) {
        ctx.lineTo(p.x, p.y);
      } else {
        ctx.moveTo(p.x, p.y);
      }
      pen = true;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  draw(now: number, dt: number, ms: number) {
    const ctx = this.ctx;
    const W = this.w;
    const H = this.h;
    if (!W || !H) {
      return;
    }
    this.cx = W * .5;
    this.cy = H * .445;
    this.radius = Math.min(W * .235, H * .25) * this.view.zoom;
    const selected = this.options.getSelected();
    const positions = this.options.getPositions();
    const catalog = this.options.getVisible();
    const selectedPosition = selected && positions.get(selected.id);
    if (this.follow && selectedPosition && !this.drag) {
      this.focus(selectedPosition);
    }
    if (this.target && !this.drag) {
      const k = Math.min(1, dt * 5);
      this.view.yaw += (this.target.yaw - this.view.yaw) * k;
      this.view.pitch += (this.target.pitch - this.view.pitch) * k;
      if (!this.follow && Math.abs(this.target.yaw - this.view.yaw) < .001 &&
          Math.abs(this.target.pitch - this.view.pitch) < .001) {
        this.target = null;
      }
    } else if (this.auto && !this.drag) {
      this.view.yaw -= dt * .022;
    }
    const S = this.radius;
    const cx = this.cx;
    const cy = this.cy;
    ctx.clearRect(0, 0, W, H);
    for (const [x, y, brightness, size] of this.stars) {
      ctx.fillStyle = 'rgba(163,195,229,' + (.08 + brightness * .42) + ')';
      const d = size > .96 ? 1.5 : .7;
      ctx.fillRect(x * W, y * H, d, d);
    }
    const halo = ctx.createRadialGradient(cx, cy, S * .92, cx, cy, S * 1.24);
    halo.addColorStop(0, 'rgba(63,177,255,.23)');
    halo.addColorStop(.45, 'rgba(32,120,219,.07)');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, S * 1.24, 0, TAU);
    ctx.fill();
    const sea = ctx.createRadialGradient(
        cx - S * .4, cy - S * .35, S * .05, cx + S * .12, cy + S * .05,
        S * 1.05);
    sea.addColorStop(0, '#102c49');
    sea.addColorStop(.55, '#0a1e35');
    sea.addColorStop(1, '#040e1e');
    ctx.fillStyle = sea;
    ctx.beginPath();
    ctx.arc(cx, cy, S, 0, TAU);
    ctx.fill();
    const globeLine = (points: number[][]) => {
      ctx.beginPath();
      let pen = false;
      for (const v of points) {
        const p = this.project(v);
        if (p.depth < 0) {
          pen = false;
          continue;
        }
        if (pen) {
          ctx.lineTo(p.x, p.y);
        } else {
          ctx.moveTo(p.x, p.y);
        }
        pen = true;
      }
      ctx.stroke();
    };
    ctx.strokeStyle = 'rgba(63,173,230,.11)';
    ctx.lineWidth = .65;
    for (let la = -60; la <= 60; la += 30) {
      const line = [];
      for (let lo = -180; lo <= 180; lo += 3) {
        line.push([
          Math.cos(la * RAD) * Math.cos(lo * RAD),
          Math.cos(la * RAD) * Math.sin(lo * RAD), Math.sin(la * RAD)
        ]);
      }
      globeLine(line);
    }
    for (let lo = -180; lo < 180; lo += 30) {
      const line = [];
      for (let la = -90; la <= 90; la += 3) {
        line.push([
          Math.cos(la * RAD) * Math.cos(lo * RAD),
          Math.cos(la * RAD) * Math.sin(lo * RAD), Math.sin(la * RAD)
        ]);
      }
      globeLine(line);
    }
    for (const v of this.dots) {
      const p = this.project(v);
      if (p.depth < .02) {
        continue;
      }
      const light =
          .25 + .75 * Math.max(0, (v[0] * -.3 + v[1] * .8 + v[2] * .5));
      ctx.fillStyle = 'rgba(' +
          [
            76 + Math.round(55 * light), 155 + Math.round(65 * light),
            211 + Math.round(34 * light),
            (.3 + .6 * light) * (.45 + .55 * p.depth)
          ].join(',') +
          ')';
      const d = Math.max(.8, Math.min(1.8, S / 125)) * (.6 + .4 * p.depth);
      ctx.fillRect(p.x - d / 2, p.y - d / 2, d, d);
    }
    ctx.strokeStyle = 'rgba(113,218,255,.14)';
    ctx.lineWidth = .65;
    for (const polygon of this.land) {
      globeLine(polygon.map(
          ([lo, la]) =>
              [Math.cos(la * RAD) * Math.cos(lo * RAD),
               Math.cos(la * RAD) * Math.sin(lo * RAD), Math.sin(la * RAD)]));
    }
    ctx.strokeStyle = 'rgba(91,202,255,.42)';
    ctx.lineWidth = .9;
    ctx.beginPath();
    ctx.arc(cx, cy, S, 0, TAU);
    ctx.stroke();
    // 示意目录的圆轨道与真实 SGP4 轨迹分开绘制。
    const orbits = new Set();
    for (const s of catalog) {
      if (!s.demo || s.kind === 'geo' ||
          !['bds', 'gps', 'gal', 'glo', 'iridium'].includes(s.group)) {
        continue;
      }
      const key = s.group + '-' + s.plane;
      if (orbits.has(key) || orbits.size > 21) {
        continue;
      }
      orbits.add(key);
      const points = [];
      for (let k = 0; k <= 96; k++) {
        const pos =
            circularPosition({...s, u0: k * 360 / 96}, Date.UTC(2026, 0, 1));
        const r = displayRadius(s.alt);
        points.push(pos.unit.map(v => v * r));
      }
      this.drawPath(
          points,
          rgba(
              GROUP_BY_ID[s.group].color,
              s.group === selected?.group?.trim() ? .20 : .085),
          .65);
    }
    const screen: ScreenPoint[] = [];
    const screenById = new Map<string, ScreenPoint>();
    for (const s of catalog) {
      const pos = positions.get(s.id);
      if (!pos) {
        continue;
      }
      const r = displayRadius(pos.alt);
      const p = this.project(pos.unit.map(v => v * r));
      const entry = {...p, id: s.id, sat: s, position: pos};
      screen.push(entry);
      screenById.set(s.id, entry);
    }
    this.screen = screen;
    if (selected && selectedPosition) {
      if (selected.demo) {
        const points = [];
        for (let k = 0; k <= 150; k++) {
          const p = circularPosition(
              selected, ms + (k / 150 - .5) * selected.period * 60000);
          points.push(p.unit.map(v => v * displayRadius(p.alt)));
        }
        this.drawPath(
            points, rgba(GROUP_BY_ID[selected.group].color, .55), 1.1);
      } else if (this.path?.id === selected.id) {
        this.drawPath(
            this.path.points.map(p => {
              const r = Math.hypot(...p);
              return p.map(v => v / r * displayRadius(r - 6371));
            }),
            rgba(GROUP_BY_ID[selected.group].color, .55), 1.1);
      }
    }
    for (const edge of this.options.getEdges()) {
      const a = screenById.get(edge.a);
      const b = screenById.get(edge.b);
      if (!a || !b || a.hidden || b.hidden ||
          !hasLineOfSight(a.position.physical, b.position.physical)) {
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = edge.type === 'los' ? 'rgba(190,210,228,.35)' :
                                              'rgba(63,208,255,.48)';
      ctx.lineWidth = .9;
      ctx.setLineDash(edge.type === 'los' ? [4, 4] : [8, 3, 2, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    screen.sort((a, b) => a.depth - b.depth);
    const crowded = screen.length > 3000;
    for (const p of screen) {
      if (p.hidden) {
        continue;
      }
      const s = p.sat;
      const col = GROUP_BY_ID[s.group].color;
      const isSelected = s.id === selected?.id;
      if (isSelected) {
        continue;
      }
      const r = crowded ? 1.05 : (s.group === 'station' ? 2.5 : 1.65);
      if (!crowded) {
        ctx.fillStyle = rgba(col, .08);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 3.5, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = p.depth < 0 ? .5 : .9;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    const p = selected && screenById.get(selected.id);
    if (selected && p && !p.hidden) {
      const color = GROUP_BY_ID[selected.group].color;
      const pulse = 1 + Math.sin(now / 650) * .08;
      ctx.strokeStyle = rgba(color, .4);
      ctx.lineWidth = .8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 11 * pulse, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = rgba(color, .18);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 16 * pulse, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.3, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
      const label = selected.name.length > 28 ?
          selected.name.slice(0, 26) + '…' :
          selected.name;
      ctx.font = '10px "PingFang SC",system-ui,sans-serif';
      const width = ctx.measureText(label).width + 17;
      let x = p.x + 18;
      const y = p.y - 16;
      if (x + width > W - 12) {
        x = p.x - width - 18;
      }
      ctx.fillStyle = '#081222e8';
      ctx.strokeStyle = rgba(color, .35);
      ctx.lineWidth = .7;
      ctx.beginPath();
      ctx.roundRect(x, y, width, 26, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText(label, x + 8, y + 17);
      ctx.beginPath();
      ctx.moveTo(p.x + 5, p.y);
      ctx.lineTo(x > p.x ? x : x + width, y + 13);
      ctx.strokeStyle = rgba(color, .45);
      ctx.stroke();
    }
    const compassY = H - 195;
    if (W > 380) {
      ctx.strokeStyle = '#294157';
      ctx.lineWidth = .65;
      ctx.beginPath();
      ctx.arc(38, compassY, 15, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = '#7896af';
      ctx.font = '8px monospace';
      ctx.fillText('N', 35, compassY - 21);
      ctx.fillStyle = '#3fd0ff';
      ctx.beginPath();
      ctx.moveTo(38, compassY - 10);
      ctx.lineTo(35, compassY + 4);
      ctx.lineTo(41, compassY + 4);
      ctx.closePath();
      ctx.fill();
    }
  }
}
