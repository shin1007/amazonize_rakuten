/* icons/icon.svg から拡張用のPNGを書き出す
 *
 *   node tools/make-icons.mjs
 *
 * - playwright はリポジトリに入れない。PLAYWRIGHT_DIR（既定はユーザーのtoolbox）から読む。
 * - SVGを直したら、これを流し直してPNGも一緒にコミットする。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PW_DIR = process.env.PLAYWRIGHT_DIR || join(process.env.USERPROFILE || process.env.HOME, '.claude/tools/browser');
const { chromium } = createRequire(join(PW_DIR, 'package.json'))('playwright');

const ICONS = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'icons');
const SIZES = [16, 32, 48, 128];

const svg = readFileSync(join(ICONS, 'icon.svg'), 'utf8');
const browser = await chromium.launch();
try {
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
    );
    await page.screenshot({ path: join(ICONS, `icon-${size}.png`), omitBackground: true });
    await page.close();
    console.log(`icons/icon-${size}.png`);
  }
} finally {
  await browser.close();
}
