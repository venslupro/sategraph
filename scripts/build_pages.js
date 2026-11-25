import {copyFile, glob, mkdir, mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const pages = fileURLToPath(new URL('../src/sg-pages/', import.meta.url));
const vendor =
    fileURLToPath(new URL('../node_modules/satellite.js/', import.meta.url));

/** 输出至新目录，只复制已列出的公开文件，不沿用旧构建目录中的内容。 */
export async function buildPages(parent) {
  await mkdir(parent, {recursive: true});
  const out = await mkdtemp(join(parent, 'pages-'));
  await mkdir(join(out, 'data'));
  await mkdir(join(out, 'vendor/satellite/propagation'), {recursive: true});
  const files = [
    'index.html', 'style.css', 'app.js', 'model.js', 'globe.js',
    'orbit-worker.js', 'online_client.js', 'online_workspace.js',
    'data/land.json'
  ];
  await Promise.all(files.map(f => copyFile(join(pages, f), join(out, f))));
  const dist = join(vendor, 'dist');
  for await (const f of glob(['*.js', 'propagation/*.js'], {cwd: dist})) {
    await copyFile(join(dist, f), join(out, 'vendor/satellite', f));
  }
  await copyFile(
      join(vendor, 'LICENSE.md'), join(out, 'vendor/satellite/LICENSE.md'));
  return out;
}

if (import.meta.main) console.log(await buildPages('dist'));
