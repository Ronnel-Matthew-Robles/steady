// Steady service worker.
//
// Responsibilities:
//   - On first install: seed default settings and open the one-time onboarding page.
//   - Maintain the toolbar badge/title per tab, driven by status messages from the
//     top-frame content script (so we never need the broad "tabs" permission to
//     read URLs).
//   - Keep a per-tab registry of the TOP page's hostname (in chrome.storage.session,
//     which survives service worker restarts) so subframes can key the per-site
//     exception off the page the user actually toggled, not their own embed host.

var DEFAULT_SETTINGS = { enabled: true, allowed: {} };

function normalizeHost(host) {
  if (!host) return '';
  return String(host).toLowerCase().replace(/^www\./, '');
}

var TOP_HOST_PREFIX = 'topHost:';

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
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
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
    // Badge appears only when Steady is NOT calming the page; a clean icon is
    // the everyday "working" state.
    var title, badge;
    if (state === 'off') {
      title = 'Steady: off everywhere';
      badge = 'off';
    } else if (state === 'allowed') {
      title = 'Steady: motion allowed on this site';
      badge = 'off';
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

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !sender.tab || typeof sender.tab.id !== 'number') return;
  var tabId = sender.tab.id;

  if (msg.type === 'steady-status' && sender.frameId === 0) {
    // Top frame reporting its host: remember it for subframes and paint the badge.
    if (chrome.storage.session) {
      var entry = {};
      entry[TOP_HOST_PREFIX + tabId] = msg.host || '';
      chrome.storage.session.set(entry);
    }
    paintTab(tabId, msg.host);
    return;
  }

  if (msg.type === 'steady-get-top-host') {
    if (!chrome.storage.session) {
      sendResponse({ host: null });
      return;
    }
    chrome.storage.session.get(TOP_HOST_PREFIX + tabId, function (res) {
      sendResponse({ host: (res && res[TOP_HOST_PREFIX + tabId]) || null });
    });
    return true; // sendResponse is async
  }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  if (chrome.storage.session) {
    chrome.storage.session.remove(TOP_HOST_PREFIX + tabId);
  }
});
