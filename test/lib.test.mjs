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

test('CALM_CSS forces instant completion and NEVER uses animation/transition: none', () => {
  const css = lib.CALM_CSS;
  assert.match(css, /animation-duration:\s*0\.001ms\s*!important/);
  assert.match(css, /transition-duration:\s*0\.001ms\s*!important/);
  assert.match(css, /animation-iteration-count:\s*1\s*!important/);
  assert.match(css, /scroll-behavior:\s*auto\s*!important/);
  assert.doesNotMatch(css, /animation:\s*none/);
  assert.doesNotMatch(css, /transition:\s*none/);
  // best-effort parallax: neutralize fixed background attachment
  assert.match(css, /background-attachment:\s*scroll\s*!important/);
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
