// Steady main-world shim. Registered with "world": "MAIN" so it can reach the
// page's own JavaScript objects (regular content scripts live in an isolated
// world). Covers the Web Animations API (element.animate()), which injected
// CSS cannot touch and which libraries like Framer Motion use for load-time
// entrance animations.
//
// Mirrors the CSS strategy exactly: never cancel or finish() animations (sites
// pace logic on finish events, and finishing early would recreate the carousel
// strobe), just force a step easing so the animation renders its resting end
// state for its whole original duration.
//
// Coordination: the isolated-world content script keeps a data-steady-calm
// attribute on <html> in sync with the effective state. This script checks the
// attribute at call time and watches it for live toggles.

(function () {
  'use strict';
  if (window.__steadyMainWorld) return;
  window.__steadyMainWorld = true;

  var nativeAnimate = Element.prototype.animate;
  if (typeof nativeAnimate !== 'function' || typeof WeakMap !== 'function') return;

  // Primordials captured at document_start, before any page script can patch
  // them. calmActive() runs inside the animate() wrapper, so it must never
  // call page-overridable APIs unguarded or throw into page code.
  var nativeHasAttribute = Element.prototype.hasAttribute;
  var docElGetter = null;
  try {
    var docElDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'documentElement');
    docElGetter = docElDesc && docElDesc.get;
  } catch (e) { /* fall back to direct access */ }

  function root() {
    return docElGetter ? docElGetter.call(document) : document.documentElement;
  }

  function calmActive() {
    try {
      var de = root();
      return !!(de && nativeHasAttribute.call(de, 'data-steady-calm'));
    } catch (e) {
      return false; // degrade to "not calming"; never break the page's animate()
    }
  }

  // Original easing is keyed by the EFFECT (timing lives there, and pages can
  // swap anim.effect). The WeakRef registry exists because restore must not
  // depend on document.getAnimations(): that list omits finished animations
  // without fill, detached targets, and shadow-root animations, and leaving
  // step easing behind after the user turns Steady off would be lasting page
  // corruption.
  var saved = new WeakMap();
  var calmed = typeof WeakRef === 'function' ? new Set() : null;

  // Only pure WAAPI animations: CSS-driven ones are already handled by the
  // injected stylesheet, and retiming them here would fight the live toggle.
  function isWaapi(anim) {
    try {
      if (typeof CSSAnimation === 'function' && anim instanceof CSSAnimation) return false;
      if (typeof CSSTransition === 'function' && anim instanceof CSSTransition) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  // Scroll- and view-timeline animations have no time-based duration; pinning
  // them would freeze scroll-position UI (progress bars) at 100%. Leave them.
  function onDocumentTimeline(anim) {
    try {
      if (!anim.timeline) return true; // inert timeline: calming is harmless
      if (typeof DocumentTimeline === 'function' && !(anim.timeline instanceof DocumentTimeline)) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  // Which step easing holds the animation's true resting endpoint? Effect
  // easing maps DIRECTED progress, so during reversed playback step-start
  // would hold the 100% keyframe, which is the visual STARTING state of a
  // reversed animation. Playback that finishes on a reversed iteration (or
  // runs at a negative rate) must hold the 0% keyframe instead: step-end.
  function holdingEasing(anim) {
    try {
      var t = anim.effect.getTiming();
      if (t.iterations === Infinity) return 'step-start';
      var last = Math.max(0, Math.ceil((t.iterationStart || 0) + t.iterations) - 1);
      var endsReversed =
        t.direction === 'reverse' ? true :
        t.direction === 'alternate' ? last % 2 === 1 :
        t.direction === 'alternate-reverse' ? last % 2 === 0 :
        false;
      var rate = typeof anim.playbackRate === 'number' ? anim.playbackRate : 1;
      return (endsReversed !== (rate < 0)) ? 'step-end' : 'step-start';
    } catch (e) {
      return 'step-start';
    }
  }

  function restoreOne(anim) {
    try {
      var eff = anim && anim.effect;
      if (!eff || !saved.has(eff)) return;
      eff.updateTiming({ easing: saved.get(eff) });
      saved.delete(eff);
    } catch (e) { /* ignore */ }
  }

  function calmOne(anim) {
    try {
      if (!anim || !anim.effect || !onDocumentTimeline(anim)) return;
      var eff = anim.effect;
      if (saved.has(eff)) {
        // Already calmed: re-derive the held endpoint, since play()/reverse()
        // may have flipped the playback direction.
        eff.updateTiming({ easing: holdingEasing(anim) });
        return;
      }
      saved.set(eff, eff.getTiming().easing);
      if (calmed) calmed.add(new WeakRef(anim));
      eff.updateTiming({ easing: holdingEasing(anim) });
      // Some libraries attach a scroll/view timeline right after creation;
      // undo if this animation turns out to be scroll-driven.
      if (typeof queueMicrotask === 'function') {
        queueMicrotask(function () {
          if (!onDocumentTimeline(anim)) restoreOne(anim);
        });
      }
    } catch (e) { /* leave it untouched */ }
  }

  function calmAll() {
    try {
      document.getAnimations().forEach(function (anim) {
        if (isWaapi(anim)) calmOne(anim);
      });
    } catch (e) { /* getAnimations unsupported */ }
  }

  function restoreAll() {
    if (calmed) {
      calmed.forEach(function (ref) {
        var anim = ref.deref();
        if (anim) restoreOne(anim);
      });
      calmed.clear();
    }
    try {
      document.getAnimations().forEach(restoreOne); // fallback sweep
    } catch (e) { /* ignore */ }
  }

  Element.prototype.animate = function animate() {
    var anim = nativeAnimate.apply(this, arguments);
    if (calmActive() && isWaapi(anim)) calmOne(anim);
    return anim;
  };

  // play()/reverse() cover animations built with new Animation(...), replays
  // of previously restored or finished ones, and reverse() flipping the
  // direction of an already-calmed animation.
  if (typeof Animation === 'function' && Animation.prototype) {
    ['play', 'reverse'].forEach(function (name) {
      var native = Animation.prototype[name];
      if (typeof native !== 'function') return;
      Animation.prototype[name] = function () {
        var result = native.apply(this, arguments);
        if (calmActive() && isWaapi(this)) calmOne(this);
        return result;
      };
    });
  }

  // Track the calm flag. Observing the Document node itself (childList)
  // survives <html> replacement via document.open()/write or outerHTML; the
  // per-root attribute observer is re-attached whenever the root changes.
  if (typeof MutationObserver === 'function') {
    var rootObserver = new MutationObserver(sync);
    var observeRoot = function () {
      try {
        var de = root();
        if (de) rootObserver.observe(de, { attributes: true, attributeFilter: ['data-steady-calm'] });
      } catch (e) { /* ignore */ }
    };
    function sync() {
      observeRoot();
      if (calmActive()) calmAll(); else restoreAll();
    }
    try { rootObserver.observe(document, { childList: true }); } catch (e) { /* ignore */ }
    observeRoot();
  }

  if (calmActive()) calmAll();
})();
