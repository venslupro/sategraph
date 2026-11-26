import {format as clangFormat} from '@wasm-fmt/clang-format';
import {globSync, readFileSync, writeFileSync} from 'node:fs';
import {format as prettierFormat} from 'prettier';

const write = process.argv.includes('--write');
const style = readFileSync('.clang-format', 'utf8');
const files = globSync(
    ['{src,scripts,tests}/**/*.{js,ts,tsx,html,css}', 'eslint.config.js']);
for (const file of files.sort()) {
  const source = readFileSync(file, 'utf8');
  const formatted = /.(js|ts)$/.test(file) ?
      clangFormat(source, file, style) :
      await prettierFormat(
          source, {filepath: file, singleQuote: true, bracketSpacing: false});
  if (source !== formatted) {
    if (write) {
      writeFileSync(file, formatted);
    } else {
      console.error(file);
      process.exitCode = 1;
    }
  }
}
