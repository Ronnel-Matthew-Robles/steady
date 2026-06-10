// Steady shared pure helpers + constants.
//
// This file runs in two worlds:
//   (a) Chrome content-script isolated world. It is listed BEFORE src/content.js
//       in the manifest, and content scripts from the same extension share one
//       isolated-world global scope, so these top-level declarations are visible
//       to src/content.js.
//   (b) Node, via require(), for unit tests in test/lib.test.mjs.
//
// Keep it dependency-free and side-effect-free (no chrome.* calls, no DOM).

var DEFAULT_SETTINGS = { enabled: true, allowed: {} };

// Reduced-motion ruleset. CRITICAL: never use `animation: none` or
// `transition: none` -- content that animates into view would stay invisible.
// Instead we force animations/transitions to complete instantly and hold their
// end state, so reveal-on-scroll content still appears.
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
  '/* Best-effort parallax: a fixed background is a very common pure-CSS',
  '   parallax effect. Pin it to the page so it stops drifting on scroll. */',
  '*, *::before, *::after { background-attachment: scroll !important; }',
  '/* Common JS-parallax hooks: neutralize transforms only on these opt-in',
  '   markers, never globally (that would break sticky headers and legit',
  '   transformed layouts). */',
  '[data-parallax], .parallax, [data-rellax], [data-paroller-factor],',
  '[data-parallax-speed], [data-stellar-ratio] {',
  '  transform: none !important;',
  '  translate: none !important;',
  '}'
].join('\n');

// Lowercase and strip a single leading "www." so example.com and www.example.com
// share one exception entry.
function normalizeHost(host) {
  if (!host) return '';
  return String(host).toLowerCase().replace(/^www\./, '');
}

// Effective state for a hostname. Fail safe = calm: if settings are missing or
// malformed we still calm the page (the safe direction for our users).
function isEffectivelyCalm(settings, host) {
  if (!settings || settings.enabled === false) return false;
  var allowed = settings.allowed || {};
  return !allowed[normalizeHost(host)];
}

// Heuristic: does this URL look like an animated raster image we should freeze?
// GIF and animated WebP are the common cases. Extension-based check keeps this
// pure (no decoding); content.js verifies on the live element before acting.
function isAnimatedImageUrl(url) {
  if (!url) return false;
  var u = String(url).toLowerCase();
  if (u.indexOf('data:image/gif') === 0 || u.indexOf('data:image/webp') === 0) return true;
  var path = u.split('?')[0].split('#')[0];
  return path.endsWith('.gif') || path.endsWith('.webp');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    CALM_CSS: CALM_CSS,
    normalizeHost: normalizeHost,
    isEffectivelyCalm: isEffectivelyCalm,
    isAnimatedImageUrl: isAnimatedImageUrl
  };
}
