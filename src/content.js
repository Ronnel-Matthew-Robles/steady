// Steady content script. Runs at document_start in every frame.
//
// Loaded AFTER src/lib.js, so CALM_CSS, DEFAULT_SETTINGS, normalizeHost,
// isEffectivelyCalm and animatedImageKind are available in this shared scope.
//
// State machine:
//   'pending'  - calm CSS is injected (cheap, fully reversible) but settings
//                have not resolved yet, so no media is paused and no image is
//                rewritten. This prevents irreversible changes on sites the
//                user has excepted.
//   'calm'     - CSS active, media paused, images frozen, observer running.
//   'inactive' - site excepted or Steady off: CSS removed, and any media/image
//                changes made while calm are restored.
//
// Per-site exceptions are keyed by the TOP page's hostname. Subframes ask the
// service worker for their tab's top host (the top frame reports it) so that
// "Allow motion on this site" also frees embedded players on that site.

(function () {
  'use strict';

  var STYLE_ID = 'steady-style';
  // A 'play' that begins within this window after a trusted user gesture is
  // treated as user-initiated. Sites call .play() inside their click handlers,
  // so the gap is normally a few milliseconds.
  var GESTURE_WINDOW_MS = 1000;

  var state = 'pending'; // 'pending' | 'calm' | 'inactive'
  var lastGesture = 0;   // timestamp of the most recent trusted user gesture
  var topHost = null;    // top page's hostname (subframes only; null until known)
  var observer = null;
  var observedRoots = null; // WeakSet of shadow roots the observer already watches
  var styleEl = null;
  var feat = DEFAULT_SETTINGS.features; // granular feature flags, refreshed in applyState
  var lastSettings = DEFAULT_SETTINGS;   // for re-applying comfort layers after root swaps

  function mediaOn() { return feat.media !== false; }
  function imagesOn() { return feat.images !== false; }

  // WeakRef registries: restore must never depend on connected-tree queries,
  // because SPAs detach-and-cache subtrees (React keep-alive, HTMX swaps).
  // Anything we mutate is registered so toggle-off can reach it even while
  // its subtree is detached. The main world uses the same pattern.
  var canWeakRef = typeof WeakRef === 'function';
  var knownRoots = canWeakRef ? new Set() : null; // every open shadow root ever seen
  var rootSeen = typeof WeakSet === 'function' ? new WeakSet() : null;
  var frozenReg = canWeakRef ? new Set() : null;  // imgs whose src we rewrote
  var sourceReg = canWeakRef ? new Set() : null;  // <source> elements we blanked
  var pausedReg = canWeakRef ? new Set() : null;  // media we paused

  function regAdd(reg, obj) {
    if (reg) reg.add(new WeakRef(obj));
  }

  function regEach(reg, fn) {
    if (!reg) return;
    reg.forEach(function (ref) {
      var obj = ref.deref();
      if (!obj) { reg.delete(ref); return; }
      fn(obj);
    });
  }

  // ---- Calm stylesheet (synchronous, pre-paint) ----------------------------

  function buildStyle() {
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.setAttribute('data-steady', '');
    el.textContent = CALM_CSS;
    return el;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) {
      styleEl = document.getElementById(STYLE_ID);
      return;
    }
    if (!styleEl) styleEl = buildStyle();
    var parent = document.head || document.documentElement;
    if (parent) {
      parent.insertBefore(styleEl, parent.firstChild);
    } else {
      // documentElement not ready yet (extremely early). Retry shortly.
      document.addEventListener('readystatechange', injectStyle, { once: true });
    }
  }

  function removeStyle() {
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    var existing = document.getElementById(STYLE_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  // Dampen rules ride in the SAME stylesheet as the calm rules so they reach
  // shadow roots for free (isolated sheet + main-world sheet). @media screen
  // keeps printouts unfiltered. Dampen is a comfort layer: it applies even on
  // excepted sites, so composeCss includes it in the 'inactive' state too.
  var DAMPEN_CSS = [
    '@media screen {',
    '  video, canvas,',
    '  img[src*=".gif"], img[srcset*=".gif"], img[src^="data:image/gif"],',
    '  img[data-steady-frozen] {',
    '    filter: brightness(0.8) contrast(0.75) !important;',
    '  }',
    '}'
  ].join('\n');

  function composeCss() {
    var css = state === 'inactive' ? '' : buildCalmCss(feat);
    if (lastSettings.enabled !== false && lastSettings.dampen === true) {
      css += (css ? '\n' : '') + DAMPEN_CSS;
    }
    return css;
  }

  // Recompose the stylesheet for the enabled CSS features. The shadow-root
  // sheet shares the same text; replaceSync updates every adopted root live,
  // and the main-world shim re-reads the style element on the next flag flip.
  function refreshStyleText() {
    var css = composeCss();
    if (styleEl && styleEl.textContent !== css) styleEl.textContent = css;
    if (shadowSheet) {
      try { shadowSheet.replaceSync(css); } catch (e) { /* ignore */ }
    }
  }

  // The main-world shim (src/main-world.js) reads this flag to decide whether
  // to calm Web Animations API animations, and watches it for live toggles.
  // The value is a feature signature: changing it (not just adding/removing
  // the attribute) wakes the shim so it re-reads the injected stylesheet for
  // its shadow-root sheet.
  function flagValue(calm) {
    var v = '';
    if (calm && feat.animations !== false) v += 'a'; // WAAPI retiming gate
    if (calm && feat.scroll !== false) v += 's';
    if (lastSettings.enabled !== false && lastSettings.dampen === true) v += 'd';
    return v;
  }

  function setCalmFlag(calm) {
    var de = document.documentElement;
    if (!de) return;
    var v = flagValue(calm);
    if (v) de.setAttribute('data-steady-calm', v);
    else de.removeAttribute('data-steady-calm');
  }

  // Inject immediately. Calm-by-default is the safe, reversible failure mode.
  // The calm flag is NOT set here: retimed Web Animations on a site the user
  // has excepted may finish before settings resolve and would then be
  // unrestorable, so WAAPI calming waits for applyState (CSS is fully
  // reversible, so it stays eager).
  injectStyle();

  // ---- Settings + frame coordination ----------------------------------------

  function chromeOk() {
    try {
      return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
    } catch (e) {
      return false; // context invalidated
    }
  }

  function readSettings(cb) {
    if (!chromeOk() || !chrome.storage || !chrome.storage.local) {
      cb(DEFAULT_SETTINGS);
      return;
    }
    try {
      chrome.storage.local.get(DEFAULT_SETTINGS, function (stored) {
        if (chrome.runtime && chrome.runtime.lastError) {
          cb(DEFAULT_SETTINGS);
          return;
        }
        var settings = stored || DEFAULT_SETTINGS;
        // Panic lives in storage.session so it clears on browser restart
        // (nobody should come back hours later to a mysteriously dim web).
        // Content-script access requires the background's setAccessLevel.
        if (chrome.storage.session) {
          try {
            chrome.storage.session.get({ panic: false }, function (sess) {
              if (!(chrome.runtime && chrome.runtime.lastError) && sess) {
                settings.panic = sess.panic === true;
              }
              cb(settings);
            });
            return;
          } catch (e) { /* fall through */ }
        }
        settings.panic = false;
        cb(settings);
      });
    } catch (e) {
      cb(DEFAULT_SETTINGS);
    }
  }

  // Subframes resolve the top page's host via the service worker (the top
  // frame reports it on every applyState). Falls back to the frame's own host.
  function fetchTopHost(cb) {
    if (window.top === window) { cb(null); return; }
    if (!chromeOk() || !chrome.runtime || !chrome.runtime.sendMessage) { cb(null); return; }
    try {
      chrome.runtime.sendMessage({ type: 'steady-get-top-host' }, function (resp) {
        if (chrome.runtime && chrome.runtime.lastError) { cb(null); return; }
        cb(resp && resp.host ? resp.host : null);
      });
    } catch (e) {
      cb(null);
    }
  }

  function reportStatus() {
    // Only the top frame drives the per-tab badge and top-host registry.
    if (window.top !== window) return;
    if (!chromeOk() || !chrome.runtime || !chrome.runtime.sendMessage) return;
    try {
      chrome.runtime.sendMessage(
        { type: 'steady-status', host: location.hostname },
        function () { void (chrome.runtime && chrome.runtime.lastError); }
      );
    } catch (e) { /* context invalidated */ }
  }

  // ---- Comfort layers (all strictly opt-in, OFF by default) -----------------
  //
  // soften: a gentle full-viewport brightness/saturation cap (top frame only;
  //   backdrop-filter on a fixed overlay dims what is behind it WITHOUT making
  //   the overlay a containing block for the page, so position:fixed layouts
  //   keep working; a filter on <html> would break them).
  // dampen: lowers brightness and contrast of video/canvas/GIF content to
  //   blunt rapid light/dark swings. Harm reduction only; never marketed as
  //   any kind of safety guarantee.
  // panic: Alt+Shift+D, a stronger immediate dim. Deliberately independent of
  //   the master switch: the keypress itself is the consent, and someone
  //   reaching for it should never find it disabled.

  // Overlays use the Popover API to enter the TOP LAYER: a plain max-z-index
  // div is invisible over fullscreen video and above-everything <dialog>s,
  // and loses to site UI pinned at int-max z-index. popover='manual' beats
  // all of that; the inline styles below zero out the popover UA defaults.
  // Falls back to a plain fixed overlay where showPopover is unavailable.
  function ensureOverlay(id, extraCss) {
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.setAttribute('data-steady', '');
      if ('popover' in el) el.popover = 'manual';
      if (document.documentElement) document.documentElement.appendChild(el);
    }
    el.style.cssText =
      'position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;' +
      'border:0;overflow:hidden;pointer-events:none;z-index:2147483647;' + extraCss;
    if (typeof el.showPopover === 'function') {
      // hide+show jumps to the top of the top-layer stack, above any dialog
      // or fullscreen element that appeared since
      try { el.hidePopover(); } catch (e) { /* was not showing */ }
      try { el.showPopover(); } catch (e) { /* not connected yet */ }
    }
    return el;
  }

  function dropComfortNode(id) {
    var el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function applyComfort(settings) {
    var on = settings.enabled !== false;
    var isTop = window.top === window;
    if (!isTop) return; // dampen rides the main stylesheet; overlays are top-only

    // Panic intentionally ignores the master switch: the keypress is the
    // consent, and someone reaching for it must never find it disabled.
    var panicOn = settings.panic === true;
    if (panicOn) {
      ensureOverlay('steady-panic',
        'background:rgba(10,14,18,0.45);backdrop-filter:brightness(0.6);');
    } else {
      dropComfortNode('steady-panic');
    }

    // Panic supersedes soften: never stack two full-viewport backdrop-filters.
    var soften = settings.soften || {};
    if (on && soften.enabled === true && !panicOn) {
      var level = Math.max(0, Math.min(100, Number(soften.level) || 0));
      var bright = (1 - 0.20 * level / 100).toFixed(3);
      var sat = (1 - 0.35 * level / 100).toFixed(3);
      ensureOverlay('steady-soften',
        'background:transparent;backdrop-filter:brightness(' + bright + ') saturate(' + sat + ');');
    } else {
      dropComfortNode('steady-soften');
    }

    // migration: v1.1.0 briefly shipped dampen as its own style element
    dropComfortNode('steady-dampen-style');
  }

  // A site entering fullscreen lands above our overlays in the top layer;
  // re-asserting bumps them back to the top of the stack.
  document.addEventListener('fullscreenchange', function () {
    applyComfort(lastSettings);
  });

  function applyState(settings) {
    var host = window.top === window ? location.hostname : (topHost || location.hostname);
    var calm = isEffectivelyCalm(settings, host);
    feat = (settings && settings.features) || DEFAULT_SETTINGS.features;
    lastSettings = settings || DEFAULT_SETTINGS;
    applyComfort(lastSettings);
    reportStatus();
    var prev = state;
    state = calm ? 'calm' : 'inactive';
    // Flag value encodes which calming the main world should do ('a' = WAAPI,
    // 's' = scroll rules, 'd' = dampen); any value change wakes its observer.
    setCalmFlag(calm);
    if (calm) {
      injectStyle();
      refreshStyleText();
      startObserver();
      // A feature switched off while the site stays calm must release its
      // effects; the sweeps below respect the gates and re-apply the rest.
      if (!featureOn(settings, 'media')) releasePausedMedia();
      if (!featureOn(settings, 'images')) releaseFrozenImages();
      sweepAll();
    } else {
      // Dampen is a comfort layer and survives per-site exceptions, so the
      // style element may still be needed with dampen-only content.
      if (composeCss()) {
        injectStyle();
        refreshStyleText();
      } else {
        removeStyle();
      }
      stopObserver();
      if (prev === 'calm') restoreAll();
    }
  }

  function refresh() {
    readSettings(applyState);
  }

  fetchTopHost(function (host) {
    topHost = host;
    refresh();
  });

  if (chromeOk() && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'session') {
        if (changes.panic) refresh();
        return;
      }
      if (area !== 'local') return;
      if (!changes.enabled && !changes.allowed && !changes.features &&
          !changes.soften && !changes.dampen) return;
      refresh();
    });
  }

  // ---- Media pausing ---------------------------------------------------------

  ['pointerdown', 'keydown', 'touchstart'].forEach(function (evt) {
    window.addEventListener(evt, function (e) {
      if (e.isTrusted) lastGesture = Date.now();
    }, { capture: true, passive: true });
  });

  function recentGesture() {
    return lastGesture && Date.now() - lastGesture <= GESTURE_WINDOW_MS;
  }

  function pauseOne(media) {
    if (state !== 'calm' || !mediaOn()) return;
    if (media.dataset && media.dataset.steadyUserPlayed) return;
    var isAutoplay = media.autoplay || media.hasAttribute('autoplay');
    if (isAutoplay || !media.paused) {
      try {
        media.autoplay = false;
        media.pause();
        media.setAttribute('data-steady-paused', '1');
        regAdd(pausedReg, media);
      } catch (e) { /* ignore */ }
    }
  }

  function pauseMedia(root) {
    if (state !== 'calm') return;
    if (root && (root.tagName === 'VIDEO' || root.tagName === 'AUDIO')) pauseOne(root);
    if (root && root.querySelectorAll) {
      var list = root.querySelectorAll('video, audio');
      for (var i = 0; i < list.length; i++) pauseOne(list[i]);
    }
  }

  // Catch playback as it starts. 'play' does not bubble, so listen in capture.
  // Playback beginning right after a trusted gesture is the user pressing play:
  // mark that element user-played and never touch it again. Anything else
  // (declarative autoplay, programmatic .play() with no gesture) gets paused,
  // no matter how late in the page's life it starts.
  function onPlayCapture(e) {
    if (state !== 'calm' || !mediaOn()) return;
    var t = e.target;
    if (!t || typeof t.pause !== 'function') return;
    if (t.dataset && t.dataset.steadyUserPlayed) return;
    if (recentGesture()) {
      try {
        t.dataset.steadyUserPlayed = '1';
        t.removeAttribute('data-steady-paused');
      } catch (err) { /* ignore */ }
      return;
    }
    try {
      t.pause();
      t.setAttribute('data-steady-paused', '1');
      regAdd(pausedReg, t);
    } catch (err) { /* ignore */ }
  }
  // 'play' never crosses shadow boundaries (it is a non-composed event), so
  // this document listener covers the light DOM only; registerRoot attaches
  // the same handler to every discovered open shadow root.
  document.addEventListener('play', onPlayCapture, true);

  // ---- Animated image freezing ----------------------------------------------

  function disablePictureSources(img) {
    var parent = img.parentNode;
    if (parent && parent.tagName === 'PICTURE') {
      var sources = parent.querySelectorAll('source');
      for (var i = 0; i < sources.length; i++) {
        sources[i].dataset.steadySrcset = sources[i].getAttribute('srcset') || '';
        sources[i].setAttribute('srcset', '');
        regAdd(sourceReg, sources[i]);
      }
    }
  }

  function writeFrozenFrame(img, source) {
    // `source` is a fully-loaded, same-origin-or-CORS image element to read from.
    var canvas = document.createElement('canvas');
    canvas.width = source.naturalWidth;
    canvas.height = source.naturalHeight;
    if (!canvas.width || !canvas.height) return false;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0);
    var dataUrl = canvas.toDataURL('image/png'); // throws if the canvas is tainted
    // Stash originals so a per-site exception / global off can restore them.
    img.dataset.steadyOrigSrc = img.getAttribute('src') || '';
    if (img.hasAttribute('srcset')) img.dataset.steadyOrigSrcset = img.getAttribute('srcset');
    img.dataset.steadyFrozen = '1';
    regAdd(frozenReg, img);
    disablePictureSources(img);
    img.removeAttribute('srcset');
    img.src = dataUrl;
    return true;
  }

  function corsRetry(img, url) {
    if (img.dataset.steadyCors === 'tried') {
      img.dataset.steadyFrozen = 'tainted';
      return;
    }
    img.dataset.steadyCors = 'tried';
    // Probe with an off-DOM CORS request so we never break the visible image.
    var probe = new Image();
    probe.crossOrigin = 'anonymous';
    probe.onload = function () {
      // async: the images feature may have been toggled off since the probe began
      if (state !== 'calm' || !imagesOn()) return;
      try {
        writeFrozenFrame(img, probe);
      } catch (e) {
        img.dataset.steadyFrozen = 'tainted'; // server sent no CORS headers
      }
    };
    probe.onerror = function () { img.dataset.steadyFrozen = 'tainted'; };
    probe.src = url;
  }

  function doFreeze(img) {
    // re-check the gate: webp sniffs and load listeners land here asynchronously
    if (state !== 'calm' || !imagesOn() || img.dataset.steadyFrozen) return;
    try {
      writeFrozenFrame(img, img);
    } catch (e) {
      // Most likely a tainted canvas (cross-origin without CORS headers).
      corsRetry(img, img.currentSrc || img.src);
    }
  }

  // Most .webp on the web is static; rasterizing those would waste memory and
  // strip srcset for nothing. Sniff the VP8X animation flag (byte 20, bit 0x02)
  // from the (normally cached) file. If the bytes are unreadable (cross-origin
  // without CORS), err on the side of freezing: motion-safety wins.
  function sniffWebpAnimated(url, cb) {
    try {
      fetch(url, { cache: 'force-cache' })
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (buf) {
          var b = new Uint8Array(buf);
          var isVp8x = b.length > 20 &&
            b[12] === 0x56 && b[13] === 0x50 && b[14] === 0x38 && b[15] === 0x58; // "VP8X"
          cb(isVp8x && (b[20] & 0x02) ? true : false);
        })
        .catch(function () { cb(null); }); // unknown
    } catch (e) {
      cb(null);
    }
  }

  function freezeImage(img) {
    if (state !== 'calm' || !imagesOn()) return;
    if (!img || img.dataset.steadyFrozen || img.dataset.steadyPending) return;
    var url = img.currentSrc || img.src;
    var kind = animatedImageKind(url);
    if (!kind) return;

    if (!img.complete || !img.naturalWidth) {
      if (img.complete) return; // loaded but zero-size: broken image, skip
      img.dataset.steadyPending = '1';
      img.addEventListener('load', function () {
        delete img.dataset.steadyPending;
        freezeImage(img);
      }, { once: true });
      img.addEventListener('error', function () {
        delete img.dataset.steadyPending;
      }, { once: true });
      return;
    }

    if (kind === 'webp') {
      if (!img.dataset.steadyWebpChecked) {
        img.dataset.steadyWebpChecked = '1';
        sniffWebpAnimated(url, function (animated) {
          if (animated === false) return; // confirmed static: leave it alone
          doFreeze(img); // animated, or unknown (freeze to be safe)
        });
      }
      return;
    }
    doFreeze(img);
  }

  function freezeImagesIn(root) {
    if (state !== 'calm') return;
    if (root && root.tagName === 'IMG') freezeImage(root);
    if (root && root.querySelectorAll) {
      var imgs = root.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) freezeImage(imgs[i]);
    }
  }

  // ---- Shadow DOM traversal ----------------------------------------------------
  //
  // querySelectorAll never pierces shadow roots, so media pausing, image
  // freezing, and restore must walk OPEN roots explicitly. The calm CSS for
  // shadow roots (including CLOSED ones, which this world can never see) is
  // handled by the main-world attachShadow patch in src/main-world.js, which
  // also dispatches a 'steady-shadow' hint event consumed below.

  // Calm sheet for OPEN shadow roots. The main-world attachShadow patch
  // covers imperative roots (open and closed) at creation; this covers
  // declarative shadow DOM (<template shadowrootmode>), which never calls
  // attachShadow. A duplicate adoption from both worlds is harmless: the
  // rules are identical.
  var shadowSheet = null;
  function getShadowSheet() {
    if (shadowSheet) return shadowSheet;
    if (typeof CSSStyleSheet !== 'function') return null;
    try {
      shadowSheet = new CSSStyleSheet();
      // seed with the feature-composed text, never the full ruleset: a user
      // who persisted animations=false must not get step-timed shadow DOM
      shadowSheet.replaceSync(composeCss());
    } catch (e) {
      shadowSheet = null;
    }
    return shadowSheet;
  }

  function adoptCalmSheet(root) {
    try {
      var sheet = getShadowSheet();
      if (!sheet) return;
      var current = root.adoptedStyleSheets;
      for (var i = 0; i < current.length; i++) if (current[i] === sheet) return;
      root.adoptedStyleSheets = Array.prototype.slice.call(current).concat(sheet);
    } catch (e) { /* ignore */ }
  }

  function unadoptCalmSheet(root) {
    try {
      if (!shadowSheet) return;
      root.adoptedStyleSheets = Array.prototype.filter.call(
        root.adoptedStyleSheets,
        function (s) { return s !== shadowSheet; }
      );
    } catch (e) { /* ignore */ }
  }

  function collectOpenRoots(scope, acc) {
    if (!scope || !scope.querySelectorAll) return acc;
    if (scope.shadowRoot) {
      acc.push(scope.shadowRoot);
      collectOpenRoots(scope.shadowRoot, acc);
    }
    var els = scope.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var sr = els[i].shadowRoot;
      if (sr) {
        acc.push(sr);
        collectOpenRoots(sr, acc);
      }
    }
    return acc;
  }

  function registerRoot(root) {
    var isNew = !rootSeen || !rootSeen.has(root);
    if (rootSeen && isNew) {
      rootSeen.add(root);
      regAdd(knownRoots, root);
      // 'play' is non-composed and never crosses shadow boundaries; each root
      // needs its own capture listener for media inside it.
      try { root.addEventListener('play', onPlayCapture, true); } catch (e) { /* ignore */ }
    }
    if (observer && observedRoots && !observedRoots.has(root)) {
      observedRoots.add(root);
      try { observer.observe(root, OBSERVER_OPTS); } catch (e) { /* ignore */ }
    }
    return isNew;
  }

  // Observe + sweep open shadow roots under scope (and scope itself, when the
  // scope IS a shadow root). force=true re-sweeps known roots (activation and
  // feature changes); force=false touches only roots never seen before, so
  // the hot hint path never does repeated work.
  function processShadowRoots(scope, force) {
    var roots = [];
    if (scope && scope.host && scope.querySelectorAll) roots.push(scope);
    collectOpenRoots(scope, roots);
    for (var i = 0; i < roots.length; i++) {
      var root = roots[i];
      var isNew = registerRoot(root);
      if (!force && !isNew) continue;
      adoptCalmSheet(root);
      pauseMedia(root);
      freezeImagesIn(root);
    }
  }

  // ---- Restore (per-site exception / global off) -----------------------------

  function restoreMediaEl(media) {
    if (!media.hasAttribute || !media.hasAttribute('data-steady-paused')) return;
    media.removeAttribute('data-steady-paused');
    try {
      var p = media.play();
      if (p && p.catch) p.catch(function () { /* autoplay policy may block */ });
    } catch (e) { /* ignore */ }
  }

  function restoreSourceEl(source) {
    if (!source.dataset || typeof source.dataset.steadySrcset === 'undefined') return;
    source.setAttribute('srcset', source.dataset.steadySrcset);
    delete source.dataset.steadySrcset;
  }

  function restoreImgEl(img) {
    if (!img.dataset || !img.dataset.steadyFrozen) return;
    if (img.dataset.steadyFrozen === '1') {
      if (typeof img.dataset.steadyOrigSrcset !== 'undefined') {
        img.setAttribute('srcset', img.dataset.steadyOrigSrcset);
      }
      if (typeof img.dataset.steadyOrigSrc !== 'undefined') {
        img.src = img.dataset.steadyOrigSrc;
      }
    }
    delete img.dataset.steadyFrozen;
    delete img.dataset.steadyOrigSrc;
    delete img.dataset.steadyOrigSrcset;
    delete img.dataset.steadyCors;
    delete img.dataset.steadyWebpChecked;
  }

  function resumePausedMedia(scope) {
    var media = scope.querySelectorAll('video[data-steady-paused], audio[data-steady-paused]');
    for (var i = 0; i < media.length; i++) restoreMediaEl(media[i]);
  }

  function unfreezeImages(scope) {
    var i;
    var sources = scope.querySelectorAll('source[data-steady-srcset]');
    for (i = 0; i < sources.length; i++) restoreSourceEl(sources[i]);
    var imgs = scope.querySelectorAll('img[data-steady-frozen]');
    for (i = 0; i < imgs.length; i++) restoreImgEl(imgs[i]);
  }

  // Run fn for every open shadow root: the connected tree plus every root in
  // the registry (whose hosts may be detached right now).
  function forAllRoots(fn) {
    var seen = typeof WeakSet === 'function' ? new WeakSet() : null;
    var roots = collectOpenRoots(document, []);
    for (var i = 0; i < roots.length; i++) {
      if (seen) seen.add(roots[i]);
      fn(roots[i]);
    }
    regEach(knownRoots, function (root) {
      if (seen && seen.has(root)) return;
      fn(root);
    });
  }

  function forAllScopes(fn) {
    fn(document);
    forAllRoots(fn);
  }

  // Feature-level release: scope queries catch the connected tree, the
  // registries catch everything we mutated that is detached right now.
  function releasePausedMedia() {
    forAllScopes(resumePausedMedia);
    regEach(pausedReg, restoreMediaEl);
  }

  function releaseFrozenImages() {
    forAllScopes(unfreezeImages);
    regEach(sourceReg, restoreSourceEl);
    regEach(frozenReg, restoreImgEl);
  }

  function restoreAll() {
    releasePausedMedia();
    releaseFrozenImages();
    // Dampen may keep the sheet alive on excepted sites; only unadopt when
    // the composed text is genuinely empty.
    var keepSheet = composeCss() !== '';
    forAllRoots(function (root) {
      if (!keepSheet) unadoptCalmSheet(root);
    });
  }

  // ---- Sweep + MutationObserver ----------------------------------------------

  function sweepAll() {
    if (state !== 'calm') return;
    pauseMedia(document);
    freezeImagesIn(document);
    processShadowRoots(document, true);
  }

  function handleMutations(mutations) {
    if (state !== 'calm') return;
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === 'childList') {
        // pages that rewrite documentElement.innerHTML (or prune <head>) can
        // silently take our style/overlays with them; heal on removal
        for (var k = 0; k < m.removedNodes.length; k++) {
          var rn = m.removedNodes[k];
          if (rn.nodeType !== 1 || !rn.id) continue;
          if (rn.id === STYLE_ID) injectStyle();
          else if (rn.id === 'steady-soften' || rn.id === 'steady-panic') applyComfort(lastSettings);
        }
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (node.nodeType !== 1) continue; // elements only
          pauseMedia(node);
          freezeImagesIn(node);
          processShadowRoots(node, true);
        }
      } else if (m.type === 'attributes') {
        var t = m.target;
        if (!t || t.nodeType !== 1) continue;
        if (m.attributeName === 'src' || m.attributeName === 'srcset') {
          if (t.tagName === 'IMG') {
            if (t.dataset.steadyFrozen) continue; // a change we made ourselves
            delete t.dataset.steadyWebpChecked;   // new source: re-evaluate
            freezeImage(t);
          } else if (t.tagName === 'SOURCE' && t.parentNode && t.parentNode.tagName === 'PICTURE') {
            var img = t.parentNode.querySelector('img');
            if (img && !img.dataset.steadyFrozen) freezeImage(img);
          }
        } else if (m.attributeName === 'autoplay' && (t.tagName === 'VIDEO' || t.tagName === 'AUDIO')) {
          pauseOne(t);
        }
      }
    }
  }

  var OBSERVER_OPTS = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'autoplay']
  };

  function startObserver() {
    if (observer) return;
    if (!document.documentElement) return;
    observer = new MutationObserver(handleMutations);
    observer.observe(document.documentElement, OBSERVER_OPTS);
    // a fresh observer instance watches nothing yet; rediscover shadow roots
    observedRoots = typeof WeakSet === 'function' ? new WeakSet() : null;
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  // The observer starts when settings resolve to 'calm' (applyState). These
  // sweeps are no-ops in any other state, and sweepAll() on activation covers
  // anything parsed while settings were still pending.
  document.addEventListener('DOMContentLoaded', sweepAll);
  window.addEventListener('load', sweepAll);

  // The main-world attachShadow patch dispatches this hint FROM THE HOST for
  // connected hosts (detached hosts are covered by the childList observer the
  // moment they are inserted), so the flush below is scoped to the new roots
  // instead of rescanning the whole document. Debounced: component-heavy
  // pages attach hundreds of roots during boot.
  var pendingShadowHosts = [];
  var shadowHintTimer = null;
  document.addEventListener('steady-shadow', function (e) {
    if (state !== 'calm') return;
    if (e.target && e.target.nodeType === 1) pendingShadowHosts.push(e.target);
    if (shadowHintTimer) return;
    shadowHintTimer = setTimeout(function () {
      shadowHintTimer = null;
      var hosts = pendingShadowHosts.splice(0);
      if (state !== 'calm') return;
      for (var i = 0; i < hosts.length; i++) {
        var sr = hosts[i].shadowRoot; // null for closed roots: main world owns those
        if (sr) processShadowRoots(sr, true);
      }
    }, 120);
  });

  // bfcache restores: storage.onChanged events are not delivered to frozen
  // documents and are not replayed, so re-read settings on every restore.
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) refresh();
  });

  // Pages can overwrite or replace <html> (document.write, outerHTML,
  // DOM-morphing libraries), taking the calm flag, the injected style, and the
  // per-root observer with it. Observing the Document node itself survives
  // root replacement; the per-root attribute observer is re-attached on each
  // new root. The flag is only re-asserted on divergence, so this never loops.
  var integrityObserver = null;

  function observeIntegrityRoot() {
    var de = document.documentElement;
    if (de && integrityObserver) {
      try {
        integrityObserver.observe(de, { attributes: true, attributeFilter: ['data-steady-calm'] });
      } catch (e) { /* ignore */ }
    }
  }

  function onIntegrityMutations(mutations) {
    var rootReplaced = false;
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].type === 'childList') { rootReplaced = true; break; }
    }
    var de = document.documentElement;
    if (!de) return;
    var wantCalm = state === 'calm' && feat.animations !== false;
    if (de.hasAttribute('data-steady-calm') !== wantCalm) setCalmFlag(wantCalm);
    if (rootReplaced) {
      observeIntegrityRoot();
      applyComfort(lastSettings);
      if (state !== 'inactive' && !document.getElementById(STYLE_ID)) injectStyle();
      if (state === 'calm') {
        stopObserver(); // the old observer is bound to the detached root
        startObserver();
        sweepAll();
      }
    }
  }

  if (typeof MutationObserver === 'function') {
    integrityObserver = new MutationObserver(onIntegrityMutations);
    try { integrityObserver.observe(document, { childList: true }); } catch (e) { /* ignore */ }
    observeIntegrityRoot();
  }
})();
