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
  note: document.getElementById('note'),
  report: document.getElementById('report-link')
};

var optionsLink = document.getElementById('options-link');
if (optionsLink) {
  optionsLink.addEventListener('click', function (e) {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

function updateReportLink() {
  if (!els.report) return;
  // Steady's own report page: builds the report locally and offers copy,
  // email, or GitHub, so users without a GitHub account are never stranded.
  els.report.href = chrome.runtime.getURL('report.html') +
    (state.host ? '?host=' + encodeURIComponent(state.host) : '');
}

var state = {
  settings: DEFAULT_SETTINGS,
  host: '',           // normalized hostname of the active tab (http/https only)
  kind: 'unsupported' // 'site' (http/https), 'file' (calmed, no per-site key), 'unsupported'
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

function pageInfoFromUrl(url) {
  try {
    var u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return { kind: 'site', host: u.hostname };
    }
    // The content script also runs on file:// pages (when the user has enabled
    // file access), but exceptions are keyed by hostname, which files lack.
    if (u.protocol === 'file:') return { kind: 'file', host: '' };
    return { kind: 'unsupported', host: '' };
  } catch (e) {
    return { kind: 'unsupported', host: '' };
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

  if (state.kind === 'unsupported') {
    els.status.textContent = 'Steady cannot adjust this page.';
    els.siteRow.hidden = true;
    els.note.hidden = true;
    return;
  }

  if (state.kind === 'file') {
    els.status.textContent = enabled
      ? 'Calming motion on this local file.'
      : 'Steady is off everywhere.';
    els.siteRow.hidden = true; // exceptions are per-hostname; files have none
    els.note.hidden = true;
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
    els.site.setAttribute('aria-describedby', 'note');
  } else {
    els.site.removeAttribute('aria-describedby');
    els.note.hidden = true;
    els.status.textContent = allowed
      ? 'Motion is allowed on ' + state.host + '.'
      : 'Calming motion on ' + state.host + '.';
  }
}

function toggleGlobal() {
  state.settings.enabled = !(state.settings.enabled !== false);
  render();
  // write ONLY this key: a wholesale snapshot write would clobber concurrent
  // changes from the options page or keyboard commands
  chrome.storage.local.set({ enabled: state.settings.enabled });
}

function toggleSite() {
  if (state.settings.enabled === false || state.kind !== 'site') return; // disabled
  // fresh read-modify-write: the options page or Alt+Shift+S may have changed
  // the exceptions map since this popup opened
  chrome.storage.local.get({ allowed: {} }, function (stored) {
    var allowed = stored.allowed || {};
    if (allowed[state.host]) {
      delete allowed[state.host];
    } else {
      allowed[state.host] = true;
    }
    state.settings.allowed = allowed;
    render();
    chrome.storage.local.set({ allowed: allowed });
  });
}

els.global.addEventListener('click', toggleGlobal);
els.site.addEventListener('click', toggleSite);

async function init() {
  var tab = await getActiveTab();
  var info = tab && tab.url ? pageInfoFromUrl(tab.url) : { kind: 'unsupported', host: '' };
  state.kind = info.kind;
  state.host = normalizeHost(info.host);
  state.settings = await getSettings();
  updateReportLink();
  render();
}

init();
