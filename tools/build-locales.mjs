/* 訳（tools/translations）から _locales/<言語>/messages.json を作る
 *
 *   node tools/build-locales.mjs          messages.json を作り直す
 *   node tools/build-locales.mjs split    _bulk.json（番号→訳）を言語ごとの <言語>.json に分ける（移行用の一回きり）
 *
 * 文言は日本語の原文がキー。ID は src/lib/i18n.js の messageId と同じ（FNV-1a）。
 * 訳が無い文言は、その言語の messages.json に入れない（拡張は原文の日本語を出す）ので、足りなければ警告する。
 * 日本語（既定の言語）には文言を入れず、名前と説明だけを置く。
 * 対応していない言語のブラウザ向けに、英語の訳を src/lib/i18n-en.js にも書き出す（i18n.js が最後の頼みにする）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TR = join(ROOT, 'tools/translations');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n');

const messageId = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return 'm' + h.toString(16).padStart(8, '0');
};

/** 原文の前後の空白を訳にも付ける（「 ＋送料」のように、つなぎ目の空白も文言のうち） */
const withEdges = (src, text) => src.match(/^\s*/)[0] + text.trim() + src.match(/\s*$/)[0];

const source = read(join(TR, 'en.json')); // 原文の一覧（キー）。値は英語
const keys = Object.keys(source);

const [cmd] = process.argv.slice(2);

if (cmd === 'split') {
  const bulk = read(join(TR, '_bulk.json'));
  for (const [lang, byNo] of Object.entries(bulk)) {
    const out = {};
    keys.forEach((k, i) => {
      const t = byNo[String(i + 1)];
      if (t == null) console.warn(`${lang}: ${i + 1} (${k}) が無い`);
      else out[k] = withEdges(k, t);
    });
    write(join(TR, `${lang}.json`), out);
    console.log(lang, Object.keys(out).length);
  }
} else {
  const app = read(join(TR, '_app.json'));
  const ids = new Map();
  for (const k of keys) {
    const id = messageId(k);
    if (ids.has(id)) throw new Error(`ID が衝突: ${k} / ${ids.get(id)}`);
    ids.set(id, k);
  }
  const enJs = join(ROOT, 'src/lib/i18n-en.js');
  writeFileSync(enJs, `/* 自動生成（node tools/build-locales.mjs）。i18n.js が、対応していない表示言語で英語を出すのに使う */
(() => {
  const AZR = (window.AZR = window.AZR || {});
  AZR.enFallback = ${JSON.stringify(source, null, 2).split('\n').join('\n  ')};
})();
`);
  console.log('src/lib/i18n-en.js');
  const langs = readdirSync(TR).filter((f) => /^[a-z]{2}(_[A-Z]{2})?\.json$/.test(f)).map((f) => f.replace('.json', ''));
  for (const lang of Object.keys(app)) {
    const msgs = {};
    const a = app[lang];
    if (a.description.length > 132) throw new Error(`${lang}: 説明が132文字を超える (${a.description.length})`);
    msgs.appName = { message: a.name };
    msgs.appDescription = { message: a.description };
    if (langs.includes(lang)) {
      const dict = read(join(TR, `${lang}.json`));
      for (const k of keys) {
        if (dict[k] == null) { console.warn(`${lang}: 訳が無い: ${k}`); continue; }
        // 差し込みの {名前} が原文と食い違うと、画面に {n} がそのまま出る
        const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
        if (ph(k) !== ph(dict[k])) console.warn(`${lang}: {} が食い違う: ${k} -> ${dict[k]}`);
        msgs[messageId(k)] = { message: dict[k] };
      }
    }
    const dir = join(ROOT, '_locales', lang);
    mkdirSync(dir, { recursive: true });
    write(join(dir, 'messages.json'), msgs);
    console.log(`_locales/${lang}/messages.json`, Object.keys(msgs).length);
  }
}
