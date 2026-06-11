// End-to-end check for Steady using headless Chrome and the DevTools protocol.
// No dependencies: speaks CDP over --remote-debugging-pipe (JSON messages,
// NUL-terminated, fd 3 = chrome stdin, fd 4 = chrome stdout) and loads the
// extension with Extensions.loadUnpacked (works on Chrome 126+, including
// branded builds where --load-extension is blocked).
//
// It serves test/harness.html over localhost, runs it twice (baseline vs
// extension loaded), and asserts what Steady must change: animation duration,
// autoplay video/audio paused, GIF frozen to a PNG data URL, fixed-background
// parallax pinned, reveal-on-scroll content still visible, page still
// scrollable. It then flips the global toggle off via the service worker and
// asserts the live restore path (style removed, GIF source restored).
//
// Usage: node tools/e2e.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tiny static server for test/ ------------------------------------------

function startServer() {
  const types = { html: 'text/html', gif: 'image/gif' };
  const server = createServer((req, res) => {
    const name = req.url.split('?')[0].replace(/[^a-z0-9.-]/gi, '');
    try {
      const body = readFileSync(join(ROOT, 'test', name));
      res.writeHead(200, { 'content-type': types[name.split('.').pop()] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---- minimal CDP-over-pipe client -------------------------------------------

class Cdp {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    child.stdio[4].setEncoding('utf8');
    child.stdio[4].on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\0')) >= 0) {
        const msg = JSON.parse(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        }
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }
  async eval(sessionId, expression) {
    const r = await this.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
}

function launchChrome(profileDir, withExtensionDebugging) {
  const args = [
    '--remote-debugging-pipe',
    '--headless',
    '--disable-gpu',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ];
  if (withExtensionDebugging) args.splice(1, 0, '--enable-unsafe-extension-debugging');
  return spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
}

// ---- harness inspection ------------------------------------------------------

const SNAPSHOT = `({
  styleInjected: !!document.getElementById('steady-style'),
  spinnerDur: getComputedStyle(document.querySelector('.spinner')).animationDuration,
  videoPaused: document.getElementById('video').paused,
  audioPaused: document.getElementById('audio').paused,
  gifSrc: document.getElementById('gif').src.slice(0, 60),
  parallaxAttach: getComputedStyle(document.querySelector('.parallax')).backgroundAttachment,
})`;

const REVEAL = `({
  scrollY: window.scrollY,
  reveal1: getComputedStyle(document.getElementById('reveal1')).opacity,
  reveal2: getComputedStyle(document.getElementById('reveal2')).opacity,
  classes: document.getElementById('reveal1').className + '|' + document.getElementById('reveal2').className,
})`;

const SPIN = `getComputedStyle(document.querySelector('.spinner')).transform`;
const CARO = `Number(document.getElementById('caro-count').textContent)`;

async function runScenario(loadExtension, port) {
  const profile = mkdtempSync(join(tmpdir(), 'steady-e2e-'));
  const chrome = launchChrome(profile, loadExtension);
  const cdp = new Cdp(chrome);
  let extId = null;
  try {
    if (loadExtension) {
      ({ id: extId } = await cdp.send('Extensions.loadUnpacked', { path: ROOT }));
      await sleep(500); // let the service worker register
    }
    const { targetId } = await cdp.send('Target.createTarget',
      { url: `http://127.0.0.1:${port}/harness.html` });
    const page = await cdp.attach(targetId);

    for (let i = 0; i < 50; i++) {
      if (await cdp.eval(page, 'document.readyState') === 'complete') break;
      await sleep(100);
    }
    await sleep(2000); // allow pauses, GIF freezing, media wiring to settle

    const top = await cdp.eval(page, SNAPSHOT);

    // Motion sampling: the spinner's computed transform changes between two
    // samples if and only if it is actually animating.
    const spinSample = async () => {
      const a = await cdp.eval(page, SPIN);
      await sleep(350);
      const b = await cdp.eval(page, SPIN);
      return { a, b, moving: a !== b };
    };
    const spin = await spinSample();

    // Carousel cadence: the harness carousel advances on transitionend every
    // ~1.5s. Shortened durations would make it cycle hundreds of times here.
    const caroStart = await cdp.eval(page, CARO);
    await sleep(4000);
    const caroDelta = (await cdp.eval(page, CARO)) - caroStart;

    // Scroll the reveal section into view (the page ends with a 90vh spacer,
    // so scrolling to the absolute bottom would overshoot past it). The page
    // must be frontmost first: headless Chrome throttles rendering of
    // unfocused targets and IntersectionObserver only fires during rendering,
    // and the extension run has an extra onboarding tab competing for focus.
    await cdp.send('Page.bringToFront', {}, page);
    await cdp.eval(page, "document.getElementById('reveal1').scrollIntoView({ block: 'center' })");
    await sleep(1500); // reveal-on-scroll (baseline has a 1.2s transition)
    const bottom = await cdp.eval(page, REVEAL);

    let toggle = null;
    if (loadExtension) {
      // Chrome ships internal component extensions with their own service
      // workers; match ours by the id Extensions.loadUnpacked returned.
      const { targetInfos } = await cdp.send('Target.getTargets');
      const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extId));
      if (sw) {
        const swSession = await cdp.attach(sw.targetId);
        await cdp.eval(swSession, 'new Promise(r => chrome.storage.local.set({ enabled: false }, r))');
        await sleep(1000);
        const off = await cdp.eval(page, SNAPSHOT);
        const offSpin = await spinSample();
        await cdp.eval(swSession, 'new Promise(r => chrome.storage.local.set({ enabled: true }, r))');
        await sleep(1500);
        const backOn = await cdp.eval(page, SNAPSHOT);
        const onSpin = await spinSample();
        toggle = { off, backOn, offSpin, onSpin };
      }
    }
    return { top, bottom, toggle, spin, caroDelta };
  } finally {
    chrome.kill('SIGKILL');
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ---- assertions ---------------------------------------------------------------

const { server, port } = await startServer();
const results = [];
const check = (name, ok, got) => {
  results.push({ name, ok, got: String(got) });
};

try {
  console.log('running baseline (no extension)...');
  const base = await runScenario(false, port);
  console.log('running with Steady loaded...');
  const ext = await runScenario(true, port);

  // Baseline sanity: motion actually exists without Steady.
  check('baseline: no steady style', !base.top.styleInjected, base.top.styleInjected);
  check('baseline: spinner actually moves', base.spin.moving, `${base.spin.a} -> ${base.spin.b}`);
  check('baseline: carousel paced ~1.5s (1-5 advances in 4s)', base.caroDelta >= 1 && base.caroDelta <= 5, base.caroDelta);
  check('baseline: video autoplays', !base.top.videoPaused, base.top.videoPaused);
  check('baseline: audio autoplays', !base.top.audioPaused, base.top.audioPaused);
  check('baseline: gif keeps animated source', base.top.gifSrc.includes('animated.gif'), base.top.gifSrc);
  check('baseline: parallax bg fixed', base.top.parallaxAttach === 'fixed', base.top.parallaxAttach);
  check('baseline: reveal-on-scroll works', base.bottom.reveal1 === '1' && base.bottom.reveal2 === '1',
    `${base.bottom.reveal1},${base.bottom.reveal2}`);

  // Steady behavior.
  check('steady: style injected', ext.top.styleInjected, ext.top.styleInjected);
  check('steady: spinner holds still', !ext.spin.moving, `${ext.spin.a} -> ${ext.spin.b}`);
  check('steady: animation duration preserved (1s, not shortened)', ext.top.spinnerDur === '1s', ext.top.spinnerDur);
  check('steady: carousel cadence NOT accelerated (1-5 advances in 4s)', ext.caroDelta >= 1 && ext.caroDelta <= 5, ext.caroDelta);
  check('steady: autoplay video paused', ext.top.videoPaused, ext.top.videoPaused);
  check('steady: autoplay audio paused', ext.top.audioPaused, ext.top.audioPaused);
  check('steady: gif frozen to png data url', ext.top.gifSrc.startsWith('data:image/png'), ext.top.gifSrc);
  check('steady: parallax bg pinned to scroll', ext.top.parallaxAttach === 'scroll', ext.top.parallaxAttach);
  check('steady: page still scrolls', ext.bottom.scrollY > 0, ext.bottom.scrollY);
  check('steady: reveal-on-scroll (transition) visible', ext.bottom.reveal1 === '1', ext.bottom.reveal1);
  check('steady: reveal-on-scroll (animation) visible', ext.bottom.reveal2 === '1', ext.bottom.reveal2);

  // Live toggle through the service worker.
  if (ext.toggle) {
    check('toggle off: style removed live', !ext.toggle.off.styleInjected, ext.toggle.off.styleInjected);
    check('toggle off: gif source restored', ext.toggle.off.gifSrc.includes('animated.gif'), ext.toggle.off.gifSrc);
    check('toggle off: spinner moves again', ext.toggle.offSpin.moving,
      `${ext.toggle.offSpin.a} -> ${ext.toggle.offSpin.b}`);
    check('toggle on: style re-injected live', ext.toggle.backOn.styleInjected, ext.toggle.backOn.styleInjected);
    check('toggle on: spinner still again', !ext.toggle.onSpin.moving,
      `${ext.toggle.onSpin.a} -> ${ext.toggle.onSpin.b}`);
    check('toggle on: gif re-frozen', ext.toggle.backOn.gifSrc.startsWith('data:image/png'), ext.toggle.backOn.gifSrc);
  } else {
    check('toggle: service worker reachable', false, 'service worker target not found');
  }
} finally {
  server.close();
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  (got: ${r.got})`}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
