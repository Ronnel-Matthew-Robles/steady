# Chrome Web Store listing copy

Everything needed for the developer dashboard, ready to paste.

## Title (45 char limit)

Steady: Reduce Motion & Calm the Web

## Summary (132 char limit)

Forcibly reduces motion on every website: animations settle, autoplay pauses, GIFs freeze. Pages stay fully interactive.

## Description

Steady is for people with vestibular disorders, migraines, ADHD, autism, and
motion sensitivity, and for anyone who finds the modern web exhausting.

Most "reduce motion" tools fail in one of two ways. Some freeze the page with a
screenshot overlay, which breaks the moment you scroll. Others just flip the
prefers-reduced-motion flag, which most websites ignore. Steady injects
reduced-motion rules into every page directly, so it works whether or not the
site cooperates, and the page stays fully usable the whole time.

What it does on every site, automatically:

- Animations and transitions settle instantly into their finished state. Content
  that animates into view still appears; banners and carousels keep their normal
  rhythm instead of strobing.
- Autoplaying video and audio are paused. Anything you press play on yourself is
  left alone.
- Animated GIFs freeze on their first frame, including ones loaded as you scroll.
- Fixed-background parallax stops drifting.
- Web Animations API effects (used by many modern sites) are stilled too.

You stay in control:

- One master switch, on by default.
- "Allow motion on this site" remembers per-site exceptions.
- Keyboard shortcuts: Alt+Shift+S for the current site, Alt+Shift+G for
  everything.
- A small badge appears on the toolbar icon only when Steady is NOT calming the
  page.

Quiet by design: no servers, no analytics, no account. Steady contacts no one;
the only network activity it can ever cause is re-reading an image the page
already loaded (to check whether it is animated). Your
settings never leave your device. Open source under the MIT license:
https://github.com/Ronnel-Matthew-Robles/steady

## Category

Accessibility

## Language

English

## Single purpose statement

Steady has one purpose: reducing motion and sensory overload on web pages. It
forces animations to settle, pauses autoplaying media, freezes animated images,
and neutralizes parallax, while keeping pages fully interactive.

## Permission justifications

- **Content scripts on all sites (`<all_urls>`)**: motion exists on every
  website, and the extension's sole function is suppressing it wherever it
  appears. The script must run at document_start in all frames so motion is
  stopped before the first paint. No data is read from pages or transmitted
  anywhere.
- **storage**: stores the user's on/off setting and per-site exceptions locally
  (chrome.storage.local). Nothing leaves the device.
- **activeTab**: lets the popup and keyboard shortcuts read the current tab's
  hostname so per-site exceptions can be shown and toggled. Used only on
  explicit user invocation.

## Data usage disclosures

- Does NOT collect any user data. All categories: none.
- No remote code. All code is packaged. Steady never contacts any server of its
  own or anyone else's; the only network activity it can cause is re-requesting
  an image the page itself already loaded (cache-first, to check whether the
  image is animated).

## Assets (in docs/store/)

- screenshot-1-onboarding.png (1280x800): the live-proof welcome page
- screenshot-2-harness.png (1280x800): the calmed test page with status readouts
- screenshot-3-popup.png (1280x800): the popup controls in context
- tile-small.png (440x280): promo tile
- tile-marquee.png (1400x560): marquee promo tile
- icon-128.png: already in icons/

## Build

`node tools/package.mjs` produces `dist/steady-<version>.zip` for upload.
