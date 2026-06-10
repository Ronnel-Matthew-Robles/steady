// Steady content script. Runs at document_start in every frame.
//
// Loaded AFTER src/lib.js, so CALM_CSS, DEFAULT_SETTINGS, normalizeHost,
// isEffectivelyCalm and isAnimatedImageUrl are available in this shared scope.
//
// Order of operations:
//   1. Synchronously inject the calm stylesheet (calm-by-default, pre-paint).
//   2. Asynchronously read settings; if this site is excepted or Steady is off,
//      remove the stylesheet and stand down.
//   3. While active: pause autoplaying media, freeze animated images, and watch
//      for late-loaded content via a MutationObserver.
//   4. React live to storage changes (no page reload needed for CSS effects).

(function () {
  'use strict';

  var STYLE_ID = 'steady-style';
  var active = true;          // calm-by-default until storage says otherwise
  var userInteracted = false; // becomes true on the first real user gesture
  var observer = null;
  var styleEl = null;

  // ---- 1. Synchronous stylesheet injection ---------------------------------

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
      // Insert as early as possible so it wins the cascade before first paint.
      parent.insertBefore(styleEl, parent.firstChild);
    } else {
      // documentElement not ready yet (extremely early). Retry on next tick.
      document.addEventListener('readystatechange', injectStyle, { once: true });
    }
  }

  function removeStyle() {
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    var existing = document.getElementById(STYLE_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  // Inject immediately. Calm-by-default is the safe failure mode.
  injectStyle();

  // ---- 2. Settings ---------------------------------------------------------

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

  function reportStatus() {
    // Only the top frame drives the toolbar badge for the tab.
    if (window.top !== window) return;
    if (!chromeOk() || !chrome.runtime || !chrome.runtime.sendMessage) return;
    try {
      chrome.runtime.sendMessage(
        { type: 'steady-status', host: location.hostname },
        function () { void chrome.runtime.lastError; } // swallow "no receiver"
      );
    } catch (e) { /* context invalidated */ }
  }

  function applyState(settings) {
    var nextActive = isEffectivelyCalm(settings, location.hostname);
    reportStatus();
    if (nextActive === active && styleEl && styleEl.parentNode) {
      // No change and style already present.
      return;
    }
    active = nextActive;
    if (active) {
      injectStyle();
      startObserver();
      sweepAll();
    } else {
      removeStyle();
      stopObserver();
      // Note: we do not un-freeze images or resume media here. CSS effects
      // revert instantly; media/image effects fully clear on next page load.
    }
  }

  readSettings(applyState);

  if (chromeOk() && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (!changes.enabled && !changes.allowed) return;
      readSettings(applyState);
    });
  }

  // ---- 3a. Media pausing ---------------------------------------------------

  function markInteracted() { userInteracted = true; }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (evt) {
    window.addEventListener(evt, markInteracted, { capture: true, once: true, passive: true });
  });

  function pauseOne(media) {
    if (!active || userInteracted) return;
    // Pause media that autoplays or is already playing without a user gesture.
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
    if (!active) return;
    if (root && (root.tagName === 'VIDEO' || root.tagName === 'AUDIO')) pauseOne(root);
    if (root && root.querySelectorAll) {
      var list = root.querySelectorAll('video, audio');
      for (var i = 0; i < list.length; i++) pauseOne(list[i]);
    }
  }

  // Catch JS-triggered playback. `play` does not bubble, so listen in capture.
  document.addEventListener('play', function (e) {
    if (active && !userInteracted) {
      var t = e.target;
      if (t && typeof t.pause === 'function') {
        try { t.pause(); t.setAttribute('data-steady-paused', '1'); } catch (err) { /* ignore */ }
      }
    }
  }, true);

  // ---- 3b. Animated image freezing ----------------------------------------

  function disablePictureSources(img) {
    var parent = img.parentNode;
    if (parent && parent.tagName === 'PICTURE') {
      var sources = parent.querySelectorAll('source');
      for (var i = 0; i < sources.length; i++) {
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
      try {
        writeFrozenFrame(img, probe);
      } catch (e) {
        img.dataset.steadyFrozen = 'tainted'; // server sent no CORS headers
      }
    };
    probe.onerror = function () { img.dataset.steadyFrozen = 'tainted'; };
    probe.src = url;
  }

  function freezeImage(img) {
    if (!active || !img || img.dataset.steadyFrozen) return;
    var url = img.currentSrc || img.src;
    if (!isAnimatedImageUrl(url)) return;

    if (!img.complete || !img.naturalWidth) {
      img.addEventListener('load', function () { freezeImage(img); }, { once: true });
      return;
    }
    try {
      writeFrozenFrame(img, img);
    } catch (e) {
      // Most likely a tainted canvas (cross-origin without CORS headers).
      corsRetry(img, url);
    }
  }

  function freezeImagesIn(root) {
    if (!active) return;
    if (root && root.tagName === 'IMG') freezeImage(root);
    if (root && root.querySelectorAll) {
      var imgs = root.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) freezeImage(imgs[i]);
    }
  }

  // ---- 3c. Full sweep + MutationObserver -----------------------------------

  function sweepAll() {
    if (!active) return;
    pauseMedia(document);
    freezeImagesIn(document);
  }

  function handleMutations(mutations) {
    if (!active) return;
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === 'childList') {
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (node.nodeType !== 1) continue; // elements only
          pauseMedia(node);
          freezeImagesIn(node);
        }
      } else if (m.type === 'attributes') {
        var t = m.target;
        if (!t || t.nodeType !== 1) continue;
        if (m.attributeName === 'src' && t.tagName === 'IMG') {
          // Lazy-loaded swap to a real (possibly animated) source: re-evaluate.
          if (t.dataset.steadyFrozen) continue; // we set this src ourselves
          freezeImage(t);
        } else if (m.attributeName === 'autoplay' && (t.tagName === 'VIDEO' || t.tagName === 'AUDIO')) {
          pauseOne(t);
        }
      }
    }
  }

  function startObserver() {
    if (observer) return;
    if (!document.documentElement) return;
    observer = new MutationObserver(handleMutations);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'autoplay']
    });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  // Observe immediately to catch nodes added during initial parsing, then sweep
  // again at the usual lifecycle milestones for anything that loads later.
  startObserver();
  document.addEventListener('DOMContentLoaded', sweepAll);
  window.addEventListener('load', sweepAll);
})();
