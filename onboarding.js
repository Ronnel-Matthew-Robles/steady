// Steady onboarding live proof.
//
// Content scripts cannot run on chrome-extension:// pages, so this page
// demonstrates with the same technique Steady uses on real sites: a GIF
// parked on its first frame (Steady replaces GIF sources with a first-frame
// PNG; here the still frame ships as an asset, so the proof can never race
// image decoding). The switch is the REAL master switch in
// chrome.storage.local: flipping it affects every tab, and changes made from
// the popup show up here live.
//
// Extension-page CSP forbids inline scripts, hence this external file.

'use strict';

var LIVE_SRC = 'assets/onboarding.gif';
var STILL_SRC = 'assets/onboarding-still.png';

var els = {
  gif: document.getElementById('demo-gif'),
  status: document.getElementById('proof-status'),
  toggle: document.getElementById('global-toggle'),
  toggleState: document.querySelector('#global-toggle .switch-state')
};

var enabled = true;

function render() {
  els.toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
  if (els.toggleState) els.toggleState.textContent = enabled ? 'On' : 'Off';
  els.gif.src = enabled ? STILL_SRC : LIVE_SRC;
  els.gif.hidden = false;
  els.status.textContent = enabled
    ? 'Steady is on. The animation above is frozen on its first frame.'
    : 'Steady is off everywhere. Motion is loose again; flip the switch to calm it.';
}

// Calm is the safe optimistic default (it matches the extension's defaults),
// so the still frame shows immediately; storage confirms right after.
render();

chrome.storage.local.get({ enabled: true }, function (settings) {
  enabled = settings.enabled !== false;
  render();
});

// Stay in sync with the popup (and any other surface) live.
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes.enabled) return;
  enabled = changes.enabled.newValue !== false;
  render();
});

els.toggle.addEventListener('click', function () {
  enabled = !enabled;
  chrome.storage.local.set({ enabled: enabled });
  render();
});
