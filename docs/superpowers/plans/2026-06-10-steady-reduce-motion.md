# Steady: Reduce Motion & Calm the Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Manifest V3 Chrome extension ("Steady") that forcibly reduces motion and sensory overload on every website while keeping pages fully interactive.

**Architecture:** Vanilla JS, no build step. A `document_start` content script synchronously injects a reduced-motion stylesheet (calm-by-default), then reads `chrome.storage.local` to remove it on per-site exceptions or when globally off. The same content script pauses autoplaying media, freezes animated GIF/WebP to their first frame, and conservatively neutralizes parallax, re-applying to late content via a MutationObserver. A service worker shows first-run onboarding and a per-tab badge. An accessible popup controls the global toggle and per-site exceptions.

**Tech Stack:** Chrome Extensions MV3, vanilla HTML/CSS/JS, `chrome.storage.local`, `chrome.action` API, Node 24 `node:test` for pure-logic unit tests, pure-Node zlib PNG generator for icons.

---

## File structure

| File | Responsibility |
|------|----------------|
| `manifest.json` | MV3 manifest, content script registration, permissions, action/popup, icons. |
| `src/lib.js` | Pure shared helpers + constants (`DEFAULT_SETTINGS`, `CALM_CSS`, `normalizeHost`, `isEffectivelyCalm`, `isAnimatedImageUrl`). Loaded as first content script (shared isolated-world scope) AND `require`-able in Node tests. |
| `src/content.js` | Orchestrator: inject/remove style, pause media, freeze images, neutralize parallax, MutationObserver, `storage.onChanged` reaction. |
| `src/background.js` | Service worker: onInstalled → onboarding tab; per-tab badge/title. |
| `src/calm.css` | Readable reference copy of the ruleset (kept identical to `CALM_CSS`); used by test harness. |
| `popup/popup.html`, `popup/popup.css`, `popup/popup.js` | Accessible controls. |
| `onboarding.html` | One-time first-run panel. |
| `icons/icon-{16,32,48,128}.png` | Generated calm icon. |
| `tools/gen-icons.mjs` | Pure-Node PNG generator. |
| `test/harness.html` | Local manual-test page (animations, autoplay video, GIF, scroll-reveal, fixed-bg parallax). |
| `test/lib.test.mjs` | Node unit tests for `src/lib.js`. |
| `README.md`, `LICENSE` | Docs + MIT. |

---

## Task 1: Manifest + LICENSE

**Files:** Create `manifest.json`, `LICENSE`.

- [ ] **Step 1:** Write `manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Steady: Reduce Motion & Calm the Web",
  "short_name": "Steady",
  "version": "1.0.0",
  "description": "Forcibly reduces motion and sensory overload on every website, while keeping pages fully interactive.",
  "permissions": ["storage", "activeTab"],
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "Steady",
    "default_icon": { "16": "icons/icon-16.png", "32": "icons/icon-32.png" }
  },
  "icons": { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" },
  "background": { "service_worker": "src/background.js" },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/lib.js", "src/content.js"],
      "run_at": "document_start",
      "all_frames": true
    }
  ],
  "web_accessible_resources": []
}
```

- [ ] **Step 2:** Write MIT `LICENSE` (year 2026, copyright holder "Steady contributors").
- [ ] **Step 3:** Commit.

## Task 2: Icon generator + icons

**Files:** Create `tools/gen-icons.mjs`, generate `icons/icon-{16,32,48,128}.png`.

Calm, minimal mark: a soft steady-blue/slate radial backdrop with a centered horizontal "level/calm" line (steady horizon), no red. Pure-Node PNG via zlib (no native deps).

- [ ] **Step 1:** Write `tools/gen-icons.mjs` that renders an RGBA pixel buffer per size and encodes a valid PNG (IHDR + IDAT via `zlib.deflateSync` with proper filter bytes + IEND, CRC32). Design: soft rounded-square background (calm slate `#3b4a5a`→`#52606e` vertical gradient), centered slightly-rounded horizontal bar in off-white `#eef2f5` (the "steady horizon"), gentle anti-aliasing on edges.
- [ ] **Step 2:** Run `node tools/gen-icons.mjs` → expect four PNG files written; print sizes.
- [ ] **Step 3:** Sanity-check each PNG begins with the PNG signature bytes and is non-empty.
- [ ] **Step 4:** Commit icons + generator.

## Task 3: Pure shared library (`src/lib.js`), TDD

**Files:** Create `src/lib.js`, `test/lib.test.mjs`, `src/calm.css`.

This holds the highest-risk logic (the CSS rule that must NOT use `none`, and effective-state). Test-first.

- [ ] **Step 1: Write failing tests** `test/lib.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const lib = require('../src/lib.js');

test('DEFAULT_SETTINGS: enabled true, empty allowed', () => {
  assert.equal(lib.DEFAULT_SETTINGS.enabled, true);
  assert.deepEqual(lib.DEFAULT_SETTINGS.allowed, {});
});

test('normalizeHost lowercases and strips leading www.', () => {
  assert.equal(lib.normalizeHost('WWW.Example.COM'), 'example.com');
  assert.equal(lib.normalizeHost('sub.example.com'), 'sub.example.com');
  assert.equal(lib.normalizeHost(''), '');
});

test('isEffectivelyCalm: on by default, off when disabled, off when site allowed', () => {
  const s = { enabled: true, allowed: {} };
  assert.equal(lib.isEffectivelyCalm(s, 'example.com'), true);
  assert.equal(lib.isEffectivelyCalm({ enabled: false, allowed: {} }, 'example.com'), false);
  assert.equal(lib.isEffectivelyCalm({ enabled: true, allowed: { 'example.com': true } }, 'example.com'), false);
  // www-normalization: allow entry without www should match www host
  assert.equal(lib.isEffectivelyCalm({ enabled: true, allowed: { 'example.com': true } }, 'www.example.com'), false);
});

test('CALM_CSS forces instant completion and NEVER uses animation/transition: none', () => {
  const css = lib.CALM_CSS;
  assert.match(css, /animation-duration:\s*0\.001ms\s*!important/);
  assert.match(css, /transition-duration:\s*0\.001ms\s*!important/);
  assert.match(css, /animation-iteration-count:\s*1\s*!important/);
  assert.match(css, /scroll-behavior:\s*auto\s*!important/);
  assert.doesNotMatch(css, /animation:\s*none/);
  assert.doesNotMatch(css, /transition:\s*none/);
  // parallax: neutralize fixed background attachment
  assert.match(css, /background-attachment:\s*scroll\s*!important/);
});

test('isAnimatedImageUrl matches gif/webp regardless of query/case', () => {
  assert.equal(lib.isAnimatedImageUrl('https://x/y/a.GIF'), true);
  assert.equal(lib.isAnimatedImageUrl('https://x/y/a.webp?123'), true);
  assert.equal(lib.isAnimatedImageUrl('https://x/y/a.png'), false);
  assert.equal(lib.isAnimatedImageUrl('data:image/gif;base64,AAAA'), true);
  assert.equal(lib.isAnimatedImageUrl(''), false);
});
```

- [ ] **Step 2: Run** `node --test test/` → expect FAIL (cannot find module `../src/lib.js`).

- [ ] **Step 3: Implement** `src/lib.js`:

```js
// Steady shared pure helpers + constants.
// Works in two worlds: (a) Chrome content-script isolated world (top-level
// declarations are visible to src/content.js, which is loaded after this file),
// (b) Node (require) for unit tests.

var DEFAULT_SETTINGS = { enabled: true, allowed: {} };

var CALM_CSS = [
  '*, *::before, *::after {',
  '  animation-duration: 0.001ms !important;',
  '  animation-delay: 0ms !important;',
  '  animation-iteration-count: 1 !important;',
  '  transition-duration: 0.001ms !important;',
  '  transition-delay: 0ms !important;',
  '}',
  'html, body { scroll-behavior: auto !important; }',
  '* { scroll-behavior: auto !important; }',
  // Best-effort parallax: a very common pure-CSS parallax is a fixed bg.
  '*, *::before, *::after { background-attachment: scroll !important; }',
  // Common JS-parallax hooks: neutralize transforms only on opt-in markers,
  // never globally (would break sticky headers / legit layouts).
  '[data-parallax], .parallax, [data-rellax], [data-paroller-factor] {',
  '  transform: none !important;',
  '  translate: none !important;',
  '}'
].join('\n');

function normalizeHost(host) {
  if (!host) return '';
  host = String(host).toLowerCase();
  return host.replace(/^www\./, '');
}

function isEffectivelyCalm(settings, host) {
  if (!settings || settings.enabled === false) return false;
  var allowed = settings.allowed || {};
  return !allowed[normalizeHost(host)];
}

function isAnimatedImageUrl(url) {
  if (!url) return false;
  var u = String(url).toLowerCase();
  if (u.startsWith('data:image/gif') || u.startsWith('data:image/webp')) return true;
  var path = u.split('?')[0].split('#')[0];
  return path.endsWith('.gif') || path.endsWith('.webp');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULT_SETTINGS, CALM_CSS, normalizeHost, isEffectivelyCalm, isAnimatedImageUrl };
}
```

- [ ] **Step 4: Run** `node --test test/` → expect PASS (all 5 tests).
- [ ] **Step 5:** Create `src/calm.css` = exact copy of the `CALM_CSS` rule text (for the harness / readability).
- [ ] **Step 6:** Commit lib + tests + calm.css.

## Task 4: Content script (`src/content.js`)

**Files:** Create `src/content.js`.

Responsibilities, in order:

1. **Synchronous inject** at top of script: create `<style id="steady-style">` with `CALM_CSS`, insert as first child of `document.documentElement` (calm-by-default, pre-paint). Guard against double-inject.
2. **Async settings read:** `chrome.storage.local.get(DEFAULT_SETTINGS)` → if `!isEffectivelyCalm(settings, location.hostname)`, disable (set `styleEl.disabled = true` and remove from DOM). Keep a module `active` flag.
3. **storage.onChanged listener:** recompute effective state; re-insert or remove style; when turning active, run media/image/parallax sweeps; (CSS-only effects revert naturally on removal).
4. **Media pause:** `userInteracted` flag set on first `pointerdown`/`keydown`/`touchstart` (capture, once). `pauseMedia(root)`: for each `<video>`/`<audio>`, if element has `autoplay` attribute OR (`!el.paused && !userInteracted`), call `el.pause()` and set `el.autoplay=false`. Add a capturing `play` listener on document that, while `active && !userInteracted`, pauses the target. Never touch media after user interaction.
5. **Freeze images:** `freezeImage(img)`: only if `active` and `isAnimatedImageUrl(img.currentSrc||img.src)` and not already processed (`data-steady-frozen`). Ensure loaded (`decode()`/`complete`); draw `naturalWidth×naturalHeight` to canvas; `try { img.src = canvas.toDataURL('image/png'); img.srcset=''; }` catch (tainted) → attempt one reload with `crossOrigin='anonymous'` then retry; on persistent taint, mark `data-steady-frozen="tainted"` and leave. Mark processed to avoid loops (setting src triggers load again).
6. **Parallax:** handled by CSS (Task 3). Content.js does nothing aggressive beyond ensuring the style is applied. (Documented limitation.)
7. **MutationObserver:** observe `document` subtree (childList) and on added nodes run `pauseMedia`/`freezeImage` for added media/images. Also observe `img` `src` attribute changes for late swaps. Debounce via microtask batching.
8. **Initial sweep** once DOM is interactive (also run immediately for already-present nodes).

- [ ] **Step 1:** Implement `src/content.js` per the above. Key guards: do nothing destructive when `!active`; idempotent sweeps; wrap chrome API calls so the script doesn't throw if context invalidated.
- [ ] **Step 2:** Lint by eye for: no `animation:none`, no use of `chrome` before feature-detect, no infinite mutation loops (frozen-marker check, and ignore mutations we cause).
- [ ] **Step 3:** Commit.

## Task 5: Service worker (`src/background.js`)

**Files:** Create `src/background.js`.

- [ ] **Step 1:** Implement:
  - `chrome.runtime.onInstalled` (reason `install`) → `chrome.tabs.create({ url: 'onboarding.html' })`; also seed `DEFAULT_SETTINGS` if unset.
  - Badge/title per tab: a function `refreshAction(tabId, url)` computing effective state from storage + hostname → `chrome.action.setTitle` ("Calm" / "Motion allowed here" / "Off"); optional subtle badge text (empty when calm, "off" dot otherwise) using a calm slate color (no red).
  - Listen to `tabs.onUpdated`, `tabs.onActivated`, and `storage.onChanged` to refresh.
- [ ] **Step 2:** Commit.

## Task 6: Popup (accessible)

**Files:** Create `popup/popup.html`, `popup/popup.css`, `popup/popup.js`.

- [ ] **Step 1:** `popup.html`: semantic structure, `lang="en"`, links `popup.css`, defers `popup.js`. Contains: heading "Steady"; current-site row (hostname + status text); a global on/off control; a per-site "Allow motion on this site" control. Both controls are real `<button role="switch" aria-checked>` (keyboard-native) with visible text labels. Min 14px text. No inline styles that animate.
- [ ] **Step 2:** `popup.css`: high-contrast calm palette (slate/off-white, no red); `*{transition:none;animation:none}` inside the popup ONLY (popup is our own UI; instant is fine here and required by spec); strong `:focus-visible` outlines (≥2px); ≥14px base font; switch styling that reflects `aria-checked`.
- [ ] **Step 3:** `popup.js`: query active tab → hostname; load settings; render switch states + status; wire clicks/Enter/Space to toggle `enabled` and per-site `allowed[host]`; persist via `chrome.storage.local.set`; update status text live. Disable per-site switch (and explain) when global is off. Reuse `normalizeHost` logic (small inline copy, since popup is a separate world from content scripts).
- [ ] **Step 4:** Commit.

## Task 7: Onboarding

**Files:** Create `onboarding.html`.

- [ ] **Step 1:** Self-contained calm page (inline CSS, no animation). ~2 sentences: Steady is ON and calms motion on every site automatically; to allow motion on a specific site, open the Steady popup there and turn on "Allow motion on this site." Accessible (contrast, focusable, 14px+).
- [ ] **Step 2:** Commit.

## Task 8: Test harness

**Files:** Create `test/harness.html`.

- [ ] **Step 1:** One offline page exercising: a CSS keyframe spinner + long transition; an IntersectionObserver reveal-on-scroll block (must remain visible under Steady); an autoplay muted `<video>` (data/sample or `<video autoplay loop>` with a tiny inline source) and an `<audio autoplay>`; an animated GIF `<img>` (reference a known data-URI tiny animated gif inline so it's fully offline); a `background-attachment: fixed` parallax section; interactive controls (button, text input) to confirm interactivity. Include notes on expected behavior.
- [ ] **Step 2:** Commit.

## Task 9: README

**Files:** Create `README.md`.

- [ ] **Step 1:** Sections: what/why (the two failure modes it fixes), install (load unpacked), usage (global toggle, per-site allow), how it works (the 4 mechanics), known limitations (cross-origin GIF taint, partial JS parallax, iframes/Shadow DOM caveats), privacy (no network/analytics/storage beyond local), development (`node --test`, `node tools/gen-icons.mjs`), license (MIT). No em/en dashes.
- [ ] **Step 2:** Commit.

## Task 10: Verification + multi-agent review

- [ ] **Step 1:** Run `node --test test/` → all pass.
- [ ] **Step 2:** Validate `manifest.json` parses (`node -e "JSON.parse(...)"`); confirm all referenced files exist (icons, popup, background, content scripts, onboarding).
- [ ] **Step 3:** Manual matrix (document results): heavy-parallax site, autoplay-video site, GIF page, scroll-reveal site; confirm scroll/click/type work; confirm reveal-on-scroll content appears. (Harness covers offline; note any live-site checks the user should run.)
- [ ] **Step 4:** Dispatch the approved multi-agent adversarial review (MV3 correctness, spec-compliance, accessibility, GIF/media/parallax edge cases). Triage findings; fix confirmed issues; commit.

---

## Self-Review (completed by author)

- **Spec coverage:** CSS calming (Task 3), media pause (Task 4.4), GIF/WebP freeze (Task 4.5), parallax (Task 3 CSS + documented limits), popup controls + per-site exception (Task 6), default-ON (DEFAULT_SETTINGS), document_start no-flash (Task 4.1), MutationObserver (Task 4.7), first-run (Task 5/7), accessible popup (Task 6), calm icon (Task 2), MIT + README (Tasks 1, 9). All covered.
- **Placeholder scan:** none; tricky code shown inline.
- **Type consistency:** `DEFAULT_SETTINGS`/`CALM_CSS`/`normalizeHost`/`isEffectivelyCalm`/`isAnimatedImageUrl` names consistent across lib, tests, content, popup. Style element id `steady-style` and processed marker `data-steady-frozen` consistent.
