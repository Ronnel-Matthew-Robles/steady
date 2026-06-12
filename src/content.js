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

  // The main-world shim (src/main-world.js) reads this flag to decide whether
  // to calm Web Animations API animations, and watches it for live toggles.
  function setCalmFlag(on) {
    var de = document.documentElement;
    if (!de) return;
    if (on) de.setAttribute('data-steady-calm', '');
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
        cb(stored || DEFAULT_SETTINGS);
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

  function applyState(settings) {
    var host = window.top === window ? location.hostname : (topHost || location.hostname);
    var calm = isEffectivelyCalm(settings, host);
    reportStatus();
    var prev = state;
    state = calm ? 'calm' : 'inactive';
    setCalmFlag(calm);
    if (calm) {
      injectStyle();
      startObserver();
      sweepAll();
    } else {
      removeStyle();
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
      if (area !== 'local') return;
      if (!changes.enabled && !changes.allowed) return;
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
    if (state !== 'calm') return;
    if (media.dataset && media.dataset.steadyUserPlayed) return;
    var isAutoplay = media.autoplay || media.hasAttribute('autoplay');
    if (isAutoplay || !media.paused) {
      try {
        media.autoplay = false;
        media.pause();
        media.setAttribute('data-steady-paused', '1');
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
  document.addEventListener('play', function (e) {
    if (state !== 'calm') return;
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
    } catch (err) { /* ignore */ }
  }, true);

  // ---- Animated image freezing ----------------------------------------------

  function disablePictureSources(img) {
    var parent = img.parentNode;
    if (parent && parent.tagName === 'PICTURE') {
      var sources = parent.querySelectorAll('source');
      for (var i = 0; i < sources.length; i++) {
        sources[i].dataset.steadySrcset = sources[i].getAttribute('srcset') || '';
        sources[i].setAttribute('srcset', '');
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
      if (state !== 'calm') return;
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
    if (state !== 'calm' || img.dataset.steadyFrozen) return;
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
    if (state !== 'calm' || !img || img.dataset.steadyFrozen || img.dataset.steadyPending) return;
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
      shadowSheet.replaceSync(CALM_CSS);
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

  // Observe + sweep every open shadow root under scope (and scope itself).
  function processShadowRoots(scope) {
    var roots = collectOpenRoots(scope, []);
    for (var i = 0; i < roots.length; i++) {
      var root = roots[i];
      if (observer && observedRoots && !observedRoots.has(root)) {
        observedRoots.add(root);
        try { observer.observe(root, OBSERVER_OPTS); } catch (e) { /* ignore */ }
      }
      adoptCalmSheet(root);
      pauseMedia(root);
      freezeImagesIn(root);
    }
  }

  // ---- Restore (per-site exception / global off) -----------------------------

  function restoreScope(scope) {
    var i;
    var media = scope.querySelectorAll('video[data-steady-paused], audio[data-steady-paused]');
    for (i = 0; i < media.length; i++) {
      media[i].removeAttribute('data-steady-paused');
      try {
        var p = media[i].play();
        if (p && p.catch) p.catch(function () { /* autoplay policy may block */ });
      } catch (e) { /* ignore */ }
    }

    var sources = scope.querySelectorAll('source[data-steady-srcset]');
    for (i = 0; i < sources.length; i++) {
      sources[i].setAttribute('srcset', sources[i].dataset.steadySrcset);
      delete sources[i].dataset.steadySrcset;
    }

    var imgs = scope.querySelectorAll('img[data-steady-frozen]');
    for (i = 0; i < imgs.length; i++) {
      var img = imgs[i];
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
  }

  function restoreAll() {
    restoreScope(document);
    var roots = collectOpenRoots(document, []);
    for (var i = 0; i < roots.length; i++) {
      unadoptCalmSheet(roots[i]);
      restoreScope(roots[i]);
    }
  }

  // ---- Sweep + MutationObserver ----------------------------------------------

  function sweepAll() {
    if (state !== 'calm') return;
    pauseMedia(document);
    freezeImagesIn(document);
    processShadowRoots(document);
  }

  function handleMutations(mutations) {
    if (state !== 'calm') return;
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === 'childList') {
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (node.nodeType !== 1) continue; // elements only
          pauseMedia(node);
          freezeImagesIn(node);
          processShadowRoots(node);
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

  // The main-world attachShadow patch fires this hint whenever any shadow root
  // is created (it handles the CSS itself, including closed roots; this world
  // sweeps open roots for media and images). Debounced: component-heavy pages
  // attach hundreds of roots during boot.
  var shadowHintTimer = null;
  document.addEventListener('steady-shadow', function () {
    if (state !== 'calm' || shadowHintTimer) return;
    shadowHintTimer = setTimeout(function () {
      shadowHintTimer = null;
      if (state === 'calm') processShadowRoots(document);
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
    var wantCalm = state === 'calm';
    if (de.hasAttribute('data-steady-calm') !== wantCalm) setCalmFlag(wantCalm);
    if (rootReplaced) {
      observeIntegrityRoot();
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
