import {json2satrec} from './vendor/satellite/io.js';
import {gstime, propagate} from './vendor/satellite/propagation.js';
import {eciToEcf, eciToGeodetic} from './vendor/satellite/transforms.js';

let records = [];
let generation = 0;
self.onmessage = ({data}) => {
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
            .filter(Boolean);
    self.postMessage({type: 'ready', generation, count: records.length});
  }
  if (data.type === 'path' && data.generation === generation) {
    const item = records.find(r => r.id === data.id), points = [];
    if (item) {
      for (let k = 0; k <= 160; k++) {
        try {
          const date = new Date(data.ms + (k / 160 - .5) * data.period * 60000),
                state = propagate(item.record, date);
          if (!state?.position) continue;
          const ecf = eciToEcf(state.position, gstime(date));
          if ([ecf.x, ecf.y, ecf.z].every(Number.isFinite))
            points.push([ecf.x, ecf.y, ecf.z]);
        } catch { /* 无法传播的采样点不绘制。 */
        }
      }
      self.postMessage({type: 'path', generation, id: data.id, points});
    }
  }
  if (data.type === 'positions' && data.generation === generation) {
    const date = new Date(data.ms), theta = gstime(date), positions = [];
    for (const {id, record} of records) {
      try {
        const state = propagate(record, date);
        if (!state || !state.position || typeof state.position !== 'object')
          continue;
        const ecef = eciToEcf(state.position, theta),
              geo = eciToGeodetic(state.position, theta);
        const physical = [ecef.x, ecef.y, ecef.z], r = Math.hypot(...physical);
        if (!Number.isFinite(r) || !Number.isFinite(geo.height) ||
            geo.height < 0)
          continue;
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
    self.postMessage({
      type: 'positions',
      generation,
      ms: data.ms,
      positions,
      failed: records.length - positions.length
    });
  }
};
