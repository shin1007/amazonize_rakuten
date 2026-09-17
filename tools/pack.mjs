/* ウェブストアに上げるzipを作る
 *
 *   node tools/pack.mjs
 *
 * 出力は tools/out/amazonize-rakuten-<version>.zip（manifest の version から）。
 * 入れるのは manifest.json / src / icons / LICENSE だけ（tests・tools・store・fixtures は入れない）。
 * Windows の Compress-Archive は区切りに \ を使ったzipを作るので、ここで自前で書いている。
 */
import { deflateRawSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = ['manifest.json', 'LICENSE', 'src', 'icons'];

/** 入れるファイルを、zipの中での名前（/区切り）で並べる */
function collect(rel) {
  const abs = join(ROOT, rel);
  if (!statSync(abs).isDirectory()) return [rel];
  return readdirSync(abs).sort().flatMap((name) => collect(`${rel}/${name}`));
}

const CRC = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const files = INCLUDE.flatMap(collect);
const local = [];
const central = [];
let offset = 0;

for (const name of files) {
  const raw = readFileSync(join(ROOT, name));
  const body = deflateRawSync(raw, { level: 9 });
  const nameBuf = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);      // 展開に要るバージョン
  head.writeUInt16LE(0x0800, 6);  // 名前はUTF-8
  head.writeUInt16LE(8, 8);       // deflate
  head.writeUInt32LE(crc32(raw), 14);
  head.writeUInt32LE(body.length, 18);
  head.writeUInt32LE(raw.length, 22);
  head.writeUInt16LE(nameBuf.length, 26);

  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4);
  head.copy(dir, 6, 4, 30); // バージョン〜名前の長さまでは同じ
  dir.writeUInt32LE((0o100644 << 16) >>> 0, 38); // 外部属性（読める普通のファイル）
  dir.writeUInt32LE(offset, 42);
  dir.writeUInt16LE(nameBuf.length, 28);

  local.push(head, nameBuf, body);
  central.push(dir, nameBuf);
  offset += head.length + nameBuf.length + body.length;
}

const dirBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(dirBuf.length, 12);
end.writeUInt32LE(offset, 16);

const { version } = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const out = join(ROOT, 'tools/out', `amazonize-rakuten-${version}.zip`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([...local, dirBuf, end]));
console.log(`${out}  ${files.length}件  ${readFileSync(out).length}バイト`);
