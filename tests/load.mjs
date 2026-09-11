/* content script（window.AZR に生やす IIFE）を Node で読むための最小の土台。
 * ブラウザでしか意味のない部分（DOM・postMessage）は空の実装で置き換える。 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** files を manifest と同じ順に読み、window.AZR を返す */
export function loadAZR(files) {
  const noop = () => {};
  const window = { addEventListener: noop, postMessage: noop };
  const context = vm.createContext({
    window,
    document: { readyState: 'complete', addEventListener: noop },
    location: { host: '', pathname: '/', origin: 'https://example.invalid' },
    console
  });
  for (const f of files) {
    vm.runInContext(readFileSync(join(ROOT, f), 'utf8'), context, { filename: f });
  }
  return window.AZR;
}
