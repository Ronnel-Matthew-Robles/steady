# Steady: Reduce Motion & Calm the Web

Steady is a Manifest V3 Chrome extension that forcibly reduces motion and sensory
overload on every website, while keeping pages fully interactive. It is built for people
with vestibular disorders, migraines, ADHD, autism, and general motion sensitivity.

It is fully offline: no backend, no network requests, no analytics, no ads. The only data
it stores is your toggle state and per-site exceptions, kept in `chrome.storage.local` on
your own machine.

## Why another motion reducer?

Existing tools tend to fail in one of two ways:

- Some overlay a screenshot to "freeze" the page. That breaks the moment you scroll and
  makes the page non-interactive.
- Others just toggle the OS `prefers-reduced-motion` flag, which does nothing on the
  large share of sites that never implement it.

Steady instead injects reduced-motion CSS into every page, so it works regardless of
whether the site cooperates, and it never takes the page out of your hands. You can still
scroll, click, and type the entire time.

## What it does

1. **Calms animations and transitions.** A stylesheet is injected at `document_start`
   (before the first paint, so there is no flash of animation). Crucially it does **not**
   use `animation: none` or `transition: none`, which would leave content that animates
   into view permanently invisible. Instead it forces animations and transitions to
   complete instantly and hold their end state, so reveal-on-scroll content still appears.
2. **Pauses autoplaying video and audio.** Media that autoplays, or starts playing before
   you have interacted with the page, is paused. Media you explicitly start is left alone.
   Late-loaded media is handled too.
3. **Freezes animated GIFs and WebP.** Each animated image is drawn to a canvas and
   replaced with its first frame, so it stops looping. Images added later (infinite scroll,
   lazy loading) are handled as they appear.
4. **Neutralizes parallax (best effort).** Fixed-background parallax and common
   scroll-driven parallax hooks are pinned so they stop drifting.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Steady is now on for every site. A one-time welcome tab explains the basics.

## Usage

Click the **Steady** toolbar icon to open the popup:

- **Steady (global on/off)**: calms motion on every site. On by default.
- **Allow motion on this site**: a per-site exception. Turn it on to let a specific site
  animate normally. The choice is remembered.

The toolbar tooltip shows the current page's status (calming, motion allowed here, or off),
and a small "off" badge appears on the icon whenever Steady is not calming the page.
Toggling takes effect immediately: calming CSS is added or removed, frozen GIFs are
restored, and media that Steady paused is resumed (best effort), all without a reload.

## How it works

- `manifest.json` registers a content script on `<all_urls>` at `document_start` in all
  frames, with only the `storage` and `activeTab` permissions.
- `src/lib.js` holds the pure logic and the reduced-motion ruleset (`CALM_CSS`).
- `src/content.js` injects the stylesheet, pauses media, freezes images, and watches for
  late content with a `MutationObserver`.
- `src/background.js` shows the first-run page and keeps the per-tab toolbar badge in sync.
- `popup/` is the accessible control panel.

## Known limitations

- **Cross-origin GIFs without CORS headers** cannot be read into a canvas (the browser
  taints it), so those specific images cannot be frozen. Steady attempts a CORS reload
  first and leaves the image untouched if that fails.
- **JavaScript transform-on-scroll parallax** is only partially handled. Steady
  deliberately does not reset every inline transform, because that would break sticky
  headers and legitimate transformed layouts.
- **Animated images are detected by URL.** GIFs are frozen on sight; `.webp` files are
  checked for the animation flag first so static ones are left untouched. Animated images
  served from extension-less URLs (some CDN image proxies) are not detected.
- **Per-site exceptions follow the top page.** Frames inside a page ask Steady for the top
  page's hostname and follow its setting; in rare early-load races a frame may briefly fall
  back to its own host.
- Pages on `chrome://`, the Web Store, and other restricted URLs cannot be modified by any
  extension.

## Privacy

Steady makes no network requests and includes no analytics or tracking. The only stored
data is your global toggle and the list of sites you have allowed motion on, in
`chrome.storage.local`.

## Development

- Run unit tests: `node --test`
- Regenerate icons: `node tools/gen-icons.mjs`
- Regenerate the test GIF: `node tools/gen-test-gif.mjs`
- Manual testing: open `test/harness.html` (it exercises animations, autoplay video and
  audio, an animated GIF, fixed-background parallax, and reveal-on-scroll content, with
  live status readouts). Also test on a heavy-parallax marketing site, an autoplay-video
  site, a GIF-heavy page, and a scroll-reveal site, confirming that reveal-on-scroll
  content still appears and that scroll, click, and type all keep working.

Note: to test on `file://` pages such as the harness, enable "Allow access to file URLs"
for Steady on `chrome://extensions`.

## License

MIT. See [LICENSE](LICENSE).
