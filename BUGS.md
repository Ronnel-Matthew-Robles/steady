# Bug reports

Quick log for issues found while dogfooding Steady. Add an entry below, then tell
Claude "check BUGS.md" in any session; entries marked OPEN get triaged and fixed.

Screenshots help but are optional. The three things that matter most:
1. The exact URL (or at least the site and which page).
2. What you saw (and roughly how often or how fast).
3. What you expected instead.

Template:

```
## [OPEN] short title
- Date:
- URL:
- What happened:
- What I expected:
- Notes/screenshot:
```

---

## [LIMITATION 2026-06-11] Dashboard charts animate their entrance (GoHighLevel)

- Date: 2026-06-11
- URL: app.gohighlevel.com dashboard
- What happened: donut, bar, and funnel charts run their entrance sweep on load.
- Why it cannot be fixed: these charting libraries (ApexCharts/Chart.js style) redraw
  a canvas or SVG frame by frame from JavaScript timers. That is ordinary drawing, not
  an animation Steady can retime, and blocking the page's timers would break the app.
  Documented in README known limitations.
- Related hardening shipped: the same report exposed that Web Animations API
  animations (element.animate) were not covered at all; a main-world shim now calms
  those with the same step-start strategy.

## [FIXED 2026-06-11] Upwork banner strobes through slides

- Date: 2026-06-11
- URL: upwork.com signed-in home (Find Work feed)
- What happened: the "Boosting your profile" promo banner, which normally rotates
  every few seconds, rotated every second or faster, infinitely. Hard on the eyes.
- What I expected: the banner either holds still or rotates at its normal pace
  without sliding motion.
- Root cause: the original calm CSS forced transition durations to 0.001ms, so the
  site's transitionend-paced carousel advanced as fast as events could fire.
- Fix: ruleset rewritten to step-start timing functions with original durations
  preserved. Regression-tested in test/harness.html section 7 and tools/e2e.mjs.
