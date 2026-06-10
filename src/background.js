// Steady service worker.
//
// Responsibilities:
//   - On first install: seed default settings and open the one-time onboarding page.
//   - Maintain the toolbar badge/title per tab, driven by status messages from the
//     content script (so we never need the broad "tabs" permission to read URLs).

var DEFAULT_SETTINGS = { enabled: true, allowed: {} };

function normalizeHost(host) {
  if (!host) return '';
  return String(host).toLowerCase().replace(/^www\./, '');
}

// Calm slate, never an alarming red.
var BADGE_COLOR = '#52606e';

chrome.runtime.onInstalled.addListener(function (details) {
  // Seed defaults without clobbering anything already stored.
  chrome.storage.local.get(DEFAULT_SETTINGS, function (current) {
    var seed = {};
    if (typeof current.enabled === 'undefined') seed.enabled = DEFAULT_SETTINGS.enabled;
    if (typeof current.allowed === 'undefined') seed.allowed = DEFAULT_SETTINGS.allowed;
    if (Object.keys(seed).length) chrome.storage.local.set(seed);
  });

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});

try {
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
} catch (e) { /* not fatal */ }

// Decide the state label for a host given current settings.
function stateFor(settings, host) {
  if (!settings || settings.enabled === false) return 'off';
  var allowed = settings.allowed || {};
  if (allowed[normalizeHost(host)]) return 'allowed';
  return 'calm';
}

function paintTab(tabId, host) {
  if (typeof tabId !== 'number') return;
  chrome.storage.local.get(DEFAULT_SETTINGS, function (settings) {
    var state = stateFor(settings, host);
    var title, badge;
    if (state === 'off') {
      title = 'Steady: off everywhere';
      badge = 'off';
    } else if (state === 'allowed') {
      title = 'Steady: motion allowed on this site';
      badge = 'on';
    } else {
      title = 'Steady: calming motion on this page';
      badge = '';
    }
    try {
      chrome.action.setTitle({ tabId: tabId, title: title });
      chrome.action.setBadgeText({ tabId: tabId, text: badge });
    } catch (e) { /* tab may have closed */ }
  });
}

// Content scripts (top frame) report their host here.
chrome.runtime.onMessage.addListener(function (msg, sender) {
  if (msg && msg.type === 'steady-status' && sender.tab && typeof sender.tab.id === 'number') {
    paintTab(sender.tab.id, msg.host);
  }
});
