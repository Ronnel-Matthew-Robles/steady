// Steady popup controller.
//
// Reads/writes chrome.storage.local. The content script reacts to storage
// changes live (via storage.onChanged), so toggles take effect without reload
// for CSS effects; media/GIF changes apply on the next page load.

'use strict';

var DEFAULT_SETTINGS = { enabled: true, allowed: {} };

function normalizeHost(host) {
  if (!host) return '';
  return String(host).toLowerCase().replace(/^www\./, '');
}

var els = {
  status: document.getElementById('status'),
  global: document.getElementById('global-toggle'),
  site: document.getElementById('site-toggle'),
  siteHost: document.getElementById('site-host'),
  siteRow: document.getElementById('site-row'),
  note: document.getElementById('note')
};

var state = {
  settings: DEFAULT_SETTINGS,
  host: '',          // normalized hostname of the active tab
  supported: false   // false for chrome://, extension pages, etc.
};

function getActiveTab() {
  return new Promise(function (resolve) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      resolve(tabs && tabs[0]);
    });
  });
}

function getSettings() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(DEFAULT_SETTINGS, function (s) {
      resolve(s || DEFAULT_SETTINGS);
    });
  });
}

function hostFromUrl(url) {
  try {
    var u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname;
  } catch (e) {
    return null;
  }
}

function setSwitch(btn, on) {
  btn.setAttribute('aria-checked', on ? 'true' : 'false');
  var label = btn.querySelector('.switch-state');
  if (label) label.textContent = on ? 'On' : 'Off';
}

function setSwitchDisabled(btn, disabled) {
  if (disabled) {
    btn.setAttribute('aria-disabled', 'true');
    btn.setAttribute('tabindex', '-1');
  } else {
    btn.removeAttribute('aria-disabled');
    btn.removeAttribute('tabindex');
  }
}

function render() {
  var enabled = state.settings.enabled !== false;
  var allowed = (state.settings.allowed || {})[state.host] === true;

  setSwitch(els.global, enabled);

  if (!state.supported) {
    els.status.textContent = 'Steady cannot adjust this page.';
    els.siteRow.hidden = true;
    return;
  }

  els.siteRow.hidden = false;
  els.siteHost.textContent = state.host;
  setSwitch(els.site, allowed);

  // Per-site control is meaningful only when Steady is globally on.
  setSwitchDisabled(els.site, !enabled);

  if (!enabled) {
    els.status.textContent = 'Steady is off everywhere.';
    els.note.hidden = false;
    els.note.textContent = 'Turn Steady on to calm motion, then you can allow specific sites.';
  } else if (allowed) {
    els.status.textContent = 'Motion is allowed on ' + state.host + '.';
    els.note.hidden = true;
  } else {
    els.status.textContent = 'Calming motion on ' + state.host + '.';
    els.note.hidden = true;
  }
}

function save() {
  return new Promise(function (resolve) {
    chrome.storage.local.set(
      { enabled: state.settings.enabled, allowed: state.settings.allowed },
      resolve
    );
  });
}

function toggleGlobal() {
  state.settings.enabled = !(state.settings.enabled !== false);
  render();
  save();
}

function toggleSite() {
  if (state.settings.enabled === false || !state.supported) return; // disabled
  var allowed = state.settings.allowed || {};
  if (allowed[state.host]) {
    delete allowed[state.host];
  } else {
    allowed[state.host] = true;
  }
  state.settings.allowed = allowed;
  render();
  save();
}

els.global.addEventListener('click', toggleGlobal);
els.site.addEventListener('click', toggleSite);

async function init() {
  var tab = await getActiveTab();
  var rawHost = tab && tab.url ? hostFromUrl(tab.url) : null;
  state.supported = !!rawHost;
  state.host = normalizeHost(rawHost || '');
  state.settings = await getSettings();
  render();
}

init();
