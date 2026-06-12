// Captures the Chrome Web Store listing assets into docs/store/ using headless
// Chrome over the DevTools pipe (same approach as tools/e2e.mjs, no deps).
//
//   screenshot-1-onboarding.png  1280x800  the live-proof welcome page
//   screenshot-2-harness.png     1280x800  the calmed test page, statuses green
//   screenshot-3-popup.png       1280x800  the popup staged in context
//   tile-small.png               440x280   promo tile
//
// Usage: node tools/gen-store-assets.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs', 'store');
const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer((req, res) => {
  const name = req.url.split('?')[0].replace(/[^a-z0-9.-]/gi, '');
  try {
    const body = readFileSync(join(ROOT, 'test', name));
    res.writeHead(200, { 'content-type': name.endsWith('.html') ? 'text/html' : 'image/gif' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const profile = mkdtempSync(join(tmpdir(), 'steady-store-'));
const chrome = spawn(CHROME, [
  '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--headless',
  '--disable-gpu', `--user-data-dir=${profile}`, '--no-first-run',
  '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

let buf = '';
const pending = new Map();
let nextId = 1;
chrome.stdio[4].setEncoding('utf8');
chrome.stdio[4].on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const id = nextId++;
  pending.set(id, res);
  chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
});

try {
  const load = await send('Extensions.loadUnpacked', { path: ROOT });
  const extId = load.result.id;
  await sleep(800);
  // close the auto-opened onboarding tab so focus stays deterministic
  const { result: { targetInfos } } = await send('Target.getTargets');
  const auto = targetInfos.find((t) => t.url.includes('onboarding.html'));
  if (auto) await send('Target.closeTarget', { targetId: auto.targetId });

  const SHOTS = [
    { file: 'screenshot-1-onboarding.png', url: `chrome-extension://${extId}/onboarding.html`, w: 1280, h: 800, wait: 1400 },
    { file: 'screenshot-2-harness.png', url: `http://127.0.0.1:${port}/harness.html`, w: 1280, h: 800, wait: 3000, scroll: 1000 },
    { file: "screenshot-3-popup.png", url: `chrome-extension://${extId}/tools/store/popup-stage.html`, w: 1280, h: 800, wait: 2800 },
    { file: 'tile-small.png', url: `chrome-extension://${extId}/tools/store/tile.html`, w: 440, h: 280, wait: 500 },
    { file: 'tile-marquee.png', url: `chrome-extension://${extId}/tools/store/marquee.html`, w: 1400, h: 560, wait: 600 },
  ];

  mkdirSync(OUT_DIR, { recursive: true });
  for (const shot of SHOTS) {
    const { result: { targetId } } = await send('Target.createTarget', { url: shot.url });
    const at = await send('Target.attachToTarget', { targetId, flatten: true });
    const sid = at.result.sessionId;
    await send('Page.bringToFront', {}, sid);
    await send('Emulation.setDeviceMetricsOverride',
      { width: shot.w, height: shot.h, deviceScaleFactor: 1, mobile: false }, sid);
    await sleep(shot.wait);
    if (shot.scroll) {
      await send('Runtime.evaluate',
        { expression: `window.scrollTo(0, ${shot.scroll})`, returnByValue: true }, sid);
      await sleep(400);
    }
    const cap = await send('Page.captureScreenshot', { format: 'png' }, sid);
    writeFileSync(join(OUT_DIR, shot.file), Buffer.from(cap.result.data, 'base64'));
    console.log(`wrote docs/store/${shot.file} (${shot.w}x${shot.h})`);
    await send('Target.closeTarget', { targetId });
  }
} finally {
  chrome.kill('SIGKILL');
  await sleep(300);
  server.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log('done');
