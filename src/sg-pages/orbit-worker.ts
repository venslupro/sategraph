// 只打包纯 JS 的 SGP4 模块，不让包总入口引入 Node/WASM 运行时。
import {json2satrec} from '#sgp4/io.js';
import {gstime, propagate} from '#sgp4/propagation.js';
import {eciToEcf, eciToGeodetic} from '#sgp4/transforms.js';
import type {SatRec} from 'satellite.js';

import type {OrbitReply, OrbitRequest} from './orbit_types.ts';

const worker: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;
const reply = (message: OrbitReply) => worker.postMessage(message);
let records: {id: string; record: SatRec}[] = [];
let generation = 0;
worker.onmessage = ({data}: MessageEvent<OrbitRequest>) => {
  if (data.type === 'catalog') {
    generation = data.generation;
    records =
        data.rows
            .map(row => {
              try {
                return {id: String(row.NORAD_CAT_ID), record: json2satrec(row)};
              } catch {
                return null;
              }
            })
            .filter(row => row !== null);
    reply({type: 'ready', generation, count: records.length});
  }
  if (data.type === 'path' && data.generation === generation) {
    const item = records.find(r => r.id === data.id);
    const points = [];
    if (item) {
      for (let k = 0; k <= 160; k++) {
        try {
          const date = new Date(data.ms + (k / 160 - .5) * data.period * 60000);
          const state = propagate(item.record, date);
          if (!state?.position) {
            continue;
          }
          const ecf = eciToEcf(state.position, gstime(date));
          if ([ecf.x, ecf.y, ecf.z].every(Number.isFinite)) {
            points.push([ecf.x, ecf.y, ecf.z]);
          }
        } catch { /* 无法传播的采样点不绘制。 */
        }
      }
      reply({type: 'path', generation, id: data.id, points});
    }
  }
  if (data.type === 'positions' && data.generation === generation) {
    const date = new Date(data.ms);
    const theta = gstime(date);
    const positions = [];
    for (const {id, record} of records) {
      try {
        const state = propagate(record, date);
        if (!state || !state.position || typeof state.position !== 'object') {
          continue;
        }
        const ecef = eciToEcf(state.position, theta);
        const geo = eciToGeodetic(state.position, theta);
        const physical = [ecef.x, ecef.y, ecef.z];
        const r = Math.hypot(...physical);
        if (!Number.isFinite(r) || !Number.isFinite(geo.height) ||
            geo.height < 0) {
          continue;
        }
        positions.push({
          id,
          unit: physical.map(v => v / r),
          physical,
          alt: geo.height,
          lat: geo.latitude * 180 / Math.PI,
          lon: geo.longitude * 180 / Math.PI,
          speed:
              Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z)
        });
      } catch { /* 单颗传播失败不影响其余目录；失败数返回界面。 */
      }
    }
    reply({
      type: 'positions',
      generation,
      ms: data.ms,
      positions,
      failed: records.length - positions.length
    });
  }
};
