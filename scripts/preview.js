import {Miniflare} from 'miniflare';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';

import {buildPages} from './build_pages.js';

const port = Number(process.env.PORT ?? 8765);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('端口无效');
}
const directory = await buildPages(tmpdir());
const runtime = new Miniflare({
  host: '127.0.0.1',
  port,
  cf: false,
  compatibilityDate: '2026-07-01',
  modules: true,
  assets: {directory, binding: 'ASSETS'},
  script:
      'export default {fetch(request, env) {return env.ASSETS.fetch(request);}};',
});
async function close() {
  await runtime.dispose();
  await rm(directory, {recursive: true, force: true});
}
try {
  console.log('本地 Pages 预览：' + await runtime.ready);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
} catch (error) {
  await close();
  throw error;
}
