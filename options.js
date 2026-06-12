// Steady options page. Loads src/lib.js first (extension pages can reuse the
// shared pure helpers), so DEFAULT_SETTINGS and featureOn are in scope.
// External file because extension-page CSP blocks inline scripts.

'use strict';

var els = {
  master: document.getElementById('master-toggle'),
  features: {
    animations: document.getElementById('feat-animations'),
    media: document.getElementById('feat-media'),
    images: document.getElementById('feat-images'),
    scroll: document.getElementById('feat-scroll')
  },
  list: document.getElementById('exceptions-list'),
  empty: document.getElementById('exceptions-empty'),
  removeAll: document.getElementById('remove-all'),
  shortcuts: document.getElementById('shortcuts-btn')
};

var settings = DEFAULT_SETTINGS;

function setSwitch(btn, on) {
  btn.setAttribute('aria-checked', on ? 'true' : 'false');
  var stateEl = btn.querySelector('.switch-state');
  if (stateEl) stateEl.textContent = on ? 'On' : 'Off';
}

function currentFeatures() {
  var f = settings.features || {};
  return {
    animations: f.animations !== false,
    media: f.media !== false,
    images: f.images !== false,
    scroll: f.scroll !== false
  };
}

function render() {
  setSwitch(els.master, settings.enabled !== false);
  Object.keys(els.features).forEach(function (name) {
    setSwitch(els.features[name], featureOn(settings, name));
  });

  var hosts = Object.keys(settings.allowed || {}).sort();
  els.list.textContent = '';
  els.empty.hidden = hosts.length > 0;
  els.removeAll.hidden = hosts.length < 2;
  hosts.forEach(function (host) {
    var li = document.createElement('li');
    var span = document.createElement('span');
    span.className = 'host';
    span.textContent = host;
    var btn = document.createElement('button');
    btn.className = 'btn';
    btn.type = 'button';
    btn.textContent = 'Remove';
    btn.setAttribute('aria-label', 'Remove exception for ' + host);
    btn.addEventListener('click', function () {
      var allowed = {};
      Object.keys(settings.allowed || {}).forEach(function (h) {
        if (h !== host) allowed[h] = true;
      });
      chrome.storage.local.set({ allowed: allowed });
    });
    li.appendChild(span);
    li.appendChild(btn);
    els.list.appendChild(li);
  });
}

function reload() {
  chrome.storage.local.get(DEFAULT_SETTINGS, function (stored) {
    settings = stored || DEFAULT_SETTINGS;
    render();
  });
}

els.master.addEventListener('click', function () {
  chrome.storage.local.set({ enabled: settings.enabled === false });
});

Object.keys(els.features).forEach(function (name) {
  els.features[name].addEventListener('click', function () {
    var f = currentFeatures();
    f[name] = !f[name];
    chrome.storage.local.set({ features: f });
  });
});

els.removeAll.addEventListener('click', function () {
  chrome.storage.local.set({ allowed: {} });
});

els.shortcuts.addEventListener('click', function () {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local') reload();
});

reload();
