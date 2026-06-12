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

var DEFAULT_SETTINGS = {
  enabled: true,
  allowed: {},
  // Granular feature switches, all defaulting to the calm state. Users can
  // e.g. keep GIFs frozen but let autoplay through.
  features: { animations: true, media: true, images: true, scroll: true },
  // Comfort layers, all OFF by default (they alter how pages look, so they
  // are strictly opt-in). soften caps brightness/saturation gently; dampen
  // reduces the intensity of video/canvas/GIF content (harm reduction, never
  // a safety guarantee); panic is the Alt+Shift+D full-viewport dim.
  soften: { enabled: false, level: 30 },
  dampen: false,
  panic: false
};

// Reduced-motion ruleset. Two rules are CRITICAL here:
//
// 1. Never use `animation: none` or `transition: none` -- content that
//    animates into view would stay invisible.
// 2. Never shorten durations or delays -- sites pace carousels and banners on
//    transitionend/animationend, and near-zero durations make those events
//    fire immediately, so the carousel cycles as fast as the event loop
//    allows (an infinite strobe; seen live on upwork.com's promo banner).
//
// Instead, step-start timing functions make every animation and transition
// JUMP straight to its end state visually while still running for its
// original duration, so end states apply (reveal-on-scroll content appears)
// and the site's event schedule is untouched.
var CALM_CSS_MOTION = [
  '*, *::before, *::after {',
  '  animation-timing-function: step-start !important;',
  '  transition-timing-function: step-start !important;',
  '  animation-iteration-count: 1 !important;',
  '}',
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

var CALM_CSS_SCROLL = [
  'html, body { scroll-behavior: auto !important; }',
  '* { scroll-behavior: auto !important; }'
].join('\n');

// Full ruleset (kept in sync with src/calm.css by a unit test).
var CALM_CSS = CALM_CSS_MOTION + '\n' + CALM_CSS_SCROLL;

// Feature flags default to ON when missing, so settings written by older
// versions (which had no `features` key) keep calming everything.
function featureOn(settings, name) {
  if (!settings || !settings.features) return true;
  return settings.features[name] !== false;
}

// Compose the stylesheet for the enabled CSS-level features.
function buildCalmCss(features) {
  var parts = [];
  if (!features || features.animations !== false) parts.push(CALM_CSS_MOTION);
  if (!features || features.scroll !== false) parts.push(CALM_CSS_SCROLL);
  return parts.join('\n');
}

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
// Returns 'gif', 'webp', or null. GIFs are nearly always animated, so they are
// frozen on sight; .webp is usually static, so content.js sniffs the file's
// VP8X animation flag before rasterizing. Extension-less animated images (CDN
// proxies and the like) are not detected; documented limitation.
function animatedImageKind(url) {
  if (!url) return null;
  var u = String(url).toLowerCase();
  if (u.indexOf('data:image/gif') === 0) return 'gif';
  if (u.indexOf('data:image/webp') === 0) return 'webp';
  var path = u.split('?')[0].split('#')[0];
  if (path.endsWith('.gif')) return 'gif';
  if (path.endsWith('.webp')) return 'webp';
  return null;
}

function isAnimatedImageUrl(url) {
  return animatedImageKind(url) !== null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    CALM_CSS: CALM_CSS,
    CALM_CSS_MOTION: CALM_CSS_MOTION,
    CALM_CSS_SCROLL: CALM_CSS_SCROLL,
    featureOn: featureOn,
    buildCalmCss: buildCalmCss,
    normalizeHost: normalizeHost,
    isEffectivelyCalm: isEffectivelyCalm,
    animatedImageKind: animatedImageKind,
    isAnimatedImageUrl: isAnimatedImageUrl
  };
}
