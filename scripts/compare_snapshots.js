import {readFile} from 'node:fs/promises';

import {compareSnapshots} from './validation/snapshots.ts';

const paths = process.argv.slice(2);
if (paths.length !== 2) {
  console.error('用法：npm run snapshots -- 前一份GP.json 后一份GP.json');
  process.exitCode = 2;
} else {
  try {
    const [before, after] = await Promise.all(
        paths.map(async path => JSON.parse(await readFile(path, 'utf8'))));
    console.log(JSON.stringify(compareSnapshots(before, after), null, 2));
  } catch {
    console.error(
        '未生成统计。请检查文件可读、非空，且包含唯一 NORAD_CAT_ID 的平面 JSON 记录。');
    process.exitCode = 1;
  }
}
