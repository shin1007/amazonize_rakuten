/* src の中の AZR.i18n.add({...}) を集めて、tools/translations/en.json に書き出す（一回きりの移行用）
 *
 *   node tools/i18n-extract.mjs        en.json を作る（既にあれば中身を足す）
 *   node tools/i18n-extract.mjs strip  src から AZR.i18n.add({...}) のブロックを消す
 *
 * 文言は日本語の原文がキー。訳は tools/translations/<言語>.json に置き、
 * tools/build-locales.mjs が _locales/<言語>/messages.json を作る。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools/translations');
const BLOCK = /[ \t]*AZR\.i18n\.add\(\{\n([\s\S]*?)\n[ \t]*\}\);\n/g;

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

const files = walk(join(ROOT, 'src'));
const [cmd] = process.argv.slice(2);

if (cmd === 'strip') {
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    const crlf = s.includes('\r\n');
    const t = s.replace(/\r\n/g, '\n').replace(BLOCK, '');
    if (t !== s.replace(/\r\n/g, '\n')) {
      writeFileSync(f, crlf ? t.replace(/\n/g, '\r\n') : t);
      console.log('stripped', f);
    }
  }
} else {
  const dict = {};
  for (const f of files) {
    const s = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    for (const m of s.matchAll(BLOCK)) Object.assign(dict, new Function(`return {${m[1]}}`)());
  }
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, 'en.json');
  const prev = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  writeFileSync(path, JSON.stringify({ ...prev, ...dict }, null, 2) + '\n');
  console.log(Object.keys(dict).length, 'keys ->', path);
}
