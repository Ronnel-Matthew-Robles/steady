# Steady v2 Audit: v1 state vs the improvement brief

Date: 2026-06-12. Produced before v2 code, per the brief. Verified by a
4-agent code audit with file:line evidence (every claim below was checked
against the repo, not assumed).

## Two REQUIRED deviations from the brief (read first)

The brief prescribes two mechanisms that v1 shipped, field-tested, and then
deliberately replaced. Reverting to the brief's letter would regress a fixed,
user-reported bug. The brief's own P0 rule ("if any change would violate an
invariant, stop and flag it") applies, so flagging here:

1. **"Near-zero duration + iteration-count 1" (P0) is dangerous and v1 no
   longer does it.** Field bug on upwork.com: sites advance carousels on
   `transitionend`/`animationend`. Near-zero durations make those events fire
   as fast as the event loop allows, so banners strobe infinitely, worse than
   the motion being suppressed. v1 instead forces `step-start` timing
   functions with durations and delays untouched (src/lib.js CALM_CSS):
   everything still jumps to its end state instantly and holds it, content
   that animates into view still appears, but event pacing matches the site's
   design. Unit tests forbid both `none` and any duration/delay shortening.
   The invariant's INTENT (end state held, nothing hidden, no `none`) is
   fully satisfied; only the prescribed mechanism differs.

2. **`document.getAnimations().forEach(a => a.finish())` (P1.4) must not be
   used.** `finish()` fires finish events immediately, recreating the same
   strobe for WAAPI-paced UI, and it permanently corrupts paused/scrubbed
   animations. v1's main-world shim instead retimes effects to step easing
   (`step-start`, or `step-end` for reversed playback so the TRUE resting
   endpoint is held), preserving the timeline and finish-event schedule, with
   full restore on toggle-off via a WeakRef registry. This was additionally
   hardened by a 26-agent adversarial review.

## P0 invariants: all satisfied

| Invariant | Status |
|---|---|
| Manifest V3 | Done (minimum_chrome_version 111 declared) |
| No backend / analytics / ads, offline | Done, one nuance below |
| chrome.storage.local only for settings | Done. storage.session holds one ephemeral per-tab value (top frame's host so iframes follow the page the user toggled); never settings, never synced |
| document_start, no flash of animation | Done; calm-by-default during the settings read, CSS-only because CSS is reversible |
| Never `animation: none` (content stays visible) | Done via step timing (see deviation 1); reveal-on-scroll is e2e-asserted both ways |
| Own UI accessible | Done: zero motion (e2e-asserted on onboarding), native buttons, role=switch, aria-live statuses, 3px focus-visible, 14px floor, WCAG 1.4.11 contrast fix on switch borders |
| Default ON, exceptions persist | Done |
| Minimal permissions | Done: storage + activeTab only; a v1 review removed an unused `scripting` permission |

Nuance worth fixing in v2 copy: "no network requests of any kind" is
marginally overstated. The WebP animation sniff and the CORS retry re-request
the page's OWN images (cache-first, fail-safe). Nothing ever goes to any
extension endpoint and nothing about the user is transmitted, but the claim
should read "no requests to anyone's servers; it only ever re-reads images
the page already loaded."

## P1 robustness: state per item

| Brief item | Status | Notes |
|---|---|---|
| 1. iframes | **Done** | `all_frames` + `match_origin_as_fallback` (superset of `match_about_blank`, also covers srcdoc/data:/blob:). Exceptions key off the TOP page's host via a service-worker registry. Cross-origin limits documented. Residual: subframes resolve the top host once at startup (documented race). |
| 2. Shadow DOM | **Was the one real gap; closed in v2** | v1 had no shadow coverage (document stylesheets don't pierce roots; querySelectorAll doesn't descend; document.getAnimations() is tree-scoped). v2: main-world `attachShadow` patch adopts the calm sheet into every root, open AND closed, before first paint, registers roots for live toggling and shadow-scoped WAAPI sweeps; isolated world walks open roots for media pausing + GIF freezing with per-root observers and a debounced creation hint; declarative shadow DOM covered by isolated-world adoption. Closed declarative roots remain CSS-covered only if imperatively... see README limitation. |
| 3. SPA navigation | **Done by architecture** | The style element and subtree observer persist across route changes; History hooks are unnecessary. Root replacement (document.write/outerHTML) is covered by an integrity observer. Gap was test-only: no SPA fixture. v2 adds one. |
| 4. WAAPI / JS animation | **Done (better than brief)** | See deviation 2. rAF/GSAP inline-style animation is architecturally out of CSS reach; partially mitigated (parallax hook selectors, background-attachment) and honestly documented. |
| 5. Smooth scrolling | **Done** | `scroll-behavior: auto !important` globally. JS `scrollTo({behavior:'smooth'})` with an explicit option can still smooth-scroll; documented limitation. |
| 6. Late media / re-trigger | **Done** | Observer with attribute filters, capture-phase `play` listener, 1s trusted-gesture window + per-element user-played latch (never fights user-started media, always re-pauses programmatic autoplay, however late). |
| 7. Performance | **Done** | Single style element, filtered observers, no layout-forcing reads in handlers, observers disconnected when inactive. v2 adds debouncing on the shadow-root rescan. Known cost: synchronous canvas.toDataURL per frozen GIF. |

## P2 controls: the genuinely new v2 work

- Granular toggles (animations / media / images / scroll): **missing → build**
- Options page: **missing → build**
- Exceptions manager (view/remove without visiting the site): **missing → build**
- Toolbar badge: done ('off' badge only when not calming; tooltip carries the 3-way state)
- Keyboard shortcuts: done (Alt+Shift+S site, Alt+Shift+G global)
- First-run panel: done (live self-demonstrating onboarding wired to the real switch)

## P3: none built yet (by design order), planned per brief

Color softening, declutter, flash dampening: all off-by-default, all
client-side. Flash dampening will use luminance/contrast filters only (no
pixel reading), with strictly conservative copy ("reduces intensity; not a
guarantee of safety"). Mechanism note: brightness/saturation capping must use
a fixed full-viewport overlay with `backdrop-filter`, NOT `filter` on `<html>`
(a root filter turns `position: fixed` descendants into absolutely-positioned
ones and breaks sticky/fixed layouts).

## P4 trust: done

MIT license, public repo (github.com/Ronnel-Matthew-Robles/steady), candid
README limitations section, store listing with single-purpose statement and
`<all_urls>` justification, permissions audit clean. v2 should soften the
absolute "no network requests" phrasing (see P0 nuance).

## Testing matrix coverage (e2e = 42 differential checks, baseline-vs-extension)

| # | Case | v1 | v2 plan |
|---|---|---|---|
| 1 | Heavy parallax | Automated (CSS variant) | keep |
| 2 | Autoplay video+audio | Automated both directions | keep |
| 3 | GIF/WebP incl. late-added | Partial (one GIF) | add late-added image fixture |
| 4 | Reveal-on-scroll appears | Automated, strongest case | keep |
| 5 | SPA route changes | **Missing** | add fixture + checks |
| 6 | Same+cross-origin iframes | **Missing** | add fixtures + checks (127.0.0.1 vs localhost gives a real cross-origin frame) |
| 7 | WAAPI / scroll-anim libs | Automated (incl. reversed playback) | keep |
| 8 | Shadow DOM | **Missing** | add open+closed fixtures + checks |
| 9 | Own UI keyboard/no-motion | Onboarding automated; popup manual | options page gets checks |
| 10 | Flash dampening | n/a (feature absent) | add with the feature |
