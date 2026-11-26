import {build} from 'esbuild';
import {copyFile, mkdir, mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const pages = fileURLToPath(new URL('../src/sg-pages/', import.meta.url));

/** 输出至新目录，只复制已列出的公开文件，不沿用旧构建目录中的内容。 */
export async function buildPages(parent) {
  await mkdir(parent, {recursive: true});
  const out = await mkdtemp(join(parent, 'pages-'));
  await mkdir(join(out, 'data'));
  const files = ['index.html', 'data/land.json'];
  await Promise.all(files.map(f => copyFile(join(pages, f), join(out, f))));
  await build({
    entryPoints: ['app.ts', 'orbit-worker.ts', 'style.css'].map(
        name => join(pages, name)),
    tsconfig: fileURLToPath(new URL('../tsconfig.pages.json', import.meta.url)),
    outdir: out,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    legalComments: 'inline',
    define: {'process.env.NODE_ENV': '"production"'}
  });
  await mkdir(join(out, 'licenses'));
  for (const [name, file] of [
           ['satellite.js', 'LICENSE.md'], ['react', 'LICENSE'],
           ['react-dom', 'LICENSE'], ['scheduler', 'LICENSE']]) {
    await copyFile(
        fileURLToPath(
            new URL('../node_modules/' + name + '/' + file, import.meta.url)),
        join(out, 'licenses', name + '.txt'));
  }
  return out;
}

if (import.meta.main) {
  console.log(await buildPages('dist'));
}
