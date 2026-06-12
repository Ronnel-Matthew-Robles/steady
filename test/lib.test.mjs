import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('../src/lib.js');

test('DEFAULT_SETTINGS: enabled true, empty allowed', () => {
  assert.equal(lib.DEFAULT_SETTINGS.enabled, true);
  assert.deepEqual(lib.DEFAULT_SETTINGS.allowed, {});
});

test('normalizeHost lowercases and strips a single leading www.', () => {
  assert.equal(lib.normalizeHost('WWW.Example.COM'), 'example.com');
  assert.equal(lib.normalizeHost('sub.example.com'), 'sub.example.com');
  assert.equal(lib.normalizeHost('www.www.example.com'), 'www.example.com');
  assert.equal(lib.normalizeHost(''), '');
  assert.equal(lib.normalizeHost(null), '');
});

test('isEffectivelyCalm: on by default, off when disabled, off when site allowed', () => {
  assert.equal(lib.isEffectivelyCalm({ enabled: true, allowed: {} }, 'example.com'), true);
  assert.equal(lib.isEffectivelyCalm({ enabled: false, allowed: {} }, 'example.com'), false);
  assert.equal(lib.isEffectivelyCalm({ enabled: true, allowed: { 'example.com': true } }, 'example.com'), false);
  // allow entry stored without www should still match a www host (and vice versa)
  assert.equal(lib.isEffectivelyCalm({ enabled: true, allowed: { 'example.com': true } }, 'www.example.com'), false);
});

test('isEffectivelyCalm tolerates missing/partial settings (fail safe = calm)', () => {
  assert.equal(lib.isEffectivelyCalm({ enabled: true }, 'example.com'), true);
  assert.equal(lib.isEffectivelyCalm(undefined, 'example.com'), false);
});

test('CALM_CSS stills motion with step timing and NEVER uses none', () => {
  const css = lib.CALM_CSS;
  assert.match(css, /animation-timing-function:\s*step-start\s*!important/);
  assert.match(css, /transition-timing-function:\s*step-start\s*!important/);
  assert.match(css, /animation-iteration-count:\s*1\s*!important/);
  assert.match(css, /scroll-behavior:\s*auto\s*!important/);
  assert.doesNotMatch(css, /animation:\s*none/);
  assert.doesNotMatch(css, /transition:\s*none/);
  // best-effort parallax: neutralize fixed background attachment
  assert.match(css, /background-attachment:\s*scroll\s*!important/);
});

test('CALM_CSS preserves durations/delays so event-paced carousels keep their cadence', () => {
  // Regression guard for the Upwork banner strobe: sites advance carousels on
  // transitionend/animationend. Shortening durations makes those events fire
  // near-instantly and the carousel cycles as fast as the event loop allows.
  // Steady must remove motion via step timing, never by shortening time.
  const css = lib.CALM_CSS;
  assert.doesNotMatch(css, /animation-duration/);
  assert.doesNotMatch(css, /transition-duration/);
  assert.doesNotMatch(css, /animation-delay/);
  assert.doesNotMatch(css, /transition-delay/);
});

test('DEFAULT_SETTINGS includes all-calm feature defaults', () => {
  assert.deepEqual(lib.DEFAULT_SETTINGS.features,
    { animations: true, media: true, images: true, scroll: true });
});

test('featureOn defaults to true for missing settings/features', () => {
  assert.equal(lib.featureOn({}, 'animations'), true);
  assert.equal(lib.featureOn({ features: {} }, 'media'), true);
  assert.equal(lib.featureOn({ features: { media: false } }, 'media'), false);
  assert.equal(lib.featureOn(null, 'images'), true);
});

test('buildCalmCss composes blocks by feature', () => {
  const full = lib.buildCalmCss({ animations: true, scroll: true });
  assert.equal(full, lib.CALM_CSS);
  const motionOnly = lib.buildCalmCss({ animations: true, scroll: false });
  assert.match(motionOnly, /step-start/);
  assert.doesNotMatch(motionOnly, /scroll-behavior/);
  const scrollOnly = lib.buildCalmCss({ animations: false, scroll: true });
  assert.match(scrollOnly, /scroll-behavior:\s*auto\s*!important/);
  assert.doesNotMatch(scrollOnly, /step-start/);
  assert.equal(lib.buildCalmCss({ animations: false, scroll: false }), '');
});

test('animatedImageKind distinguishes gif from webp', () => {
  assert.equal(lib.animatedImageKind('https://x/a.gif'), 'gif');
  assert.equal(lib.animatedImageKind('https://x/a.GIF?v=2'), 'gif');
  assert.equal(lib.animatedImageKind('https://x/a.webp'), 'webp');
  assert.equal(lib.animatedImageKind('data:image/gif;base64,AAAA'), 'gif');
  assert.equal(lib.animatedImageKind('data:image/webp;base64,AAAA'), 'webp');
  assert.equal(lib.animatedImageKind('https://x/a.png'), null);
  assert.equal(lib.animatedImageKind(''), null);
});

test('src/calm.css stays in sync with CALM_CSS (rules identical ignoring comments/whitespace)', async () => {
  const { readFileSync } = await import('node:fs');
  const cssFile = readFileSync(new URL('../src/calm.css', import.meta.url), 'utf8');
  const normalize = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
  assert.equal(normalize(cssFile), normalize(lib.CALM_CSS));
});

test('isAnimatedImageUrl matches gif/webp regardless of query/case', () => {
  assert.equal(lib.isAnimatedImageUrl('https://x/y/a.GIF'), true);
  assert.equal(lib.isAnimatedImageUrl('https://x/y/a.webp?123'), true);
  assert.equal(lib.isAnimatedImageUrl('https://x/y/a.png'), false);
  assert.equal(lib.isAnimatedImageUrl('https://x/y/photo.jpg#frag'), false);
  assert.equal(lib.isAnimatedImageUrl('data:image/gif;base64,AAAA'), true);
  assert.equal(lib.isAnimatedImageUrl('data:image/webp;base64,AAAA'), true);
  assert.equal(lib.isAnimatedImageUrl(''), false);
  assert.equal(lib.isAnimatedImageUrl(null), false);
});
