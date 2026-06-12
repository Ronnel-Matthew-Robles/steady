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
  shortcuts: document.getElementById('shortcuts-btn'),
  soften: document.getElementById('soften-toggle'),
  softenRow: document.getElementById('soften-level-row'),
  softenLevel: document.getElementById('soften-level'),
  softenValue: document.getElementById('soften-level-value'),
  dampen: document.getElementById('dampen-toggle'),
  panic: document.getElementById('panic-toggle')
};

var settings = DEFAULT_SETTINGS;

// Every writer re-reads storage first: composing a write from the cached
// `settings` snapshot loses updates when two switches are clicked quickly or
// another surface (popup, keyboard command) writes concurrently.
function withFreshSettings(fn) {
  chrome.storage.local.get(DEFAULT_SETTINGS, function (stored) {
    fn(stored || DEFAULT_SETTINGS);
  });
}
// After removing an exception via keyboard, the list rebuild would otherwise
// drop focus on <body>; remember where focus should land after re-render.
var focusListIndexAfterRender = -1;

function setSwitch(btn, on) {
  btn.setAttribute('aria-checked', on ? 'true' : 'false');
  var stateEl = btn.querySelector('.switch-state');
  if (stateEl) stateEl.textContent = on ? 'On' : 'Off';
}

function featuresOf(s) {
  var f = (s && s.features) || {};
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

  var soften = settings.soften || DEFAULT_SETTINGS.soften;
  setSwitch(els.soften, soften.enabled === true);
  els.softenRow.hidden = soften.enabled !== true;
  // never clobber the slider mid-drag: unrelated storage writes re-render too
  if (document.activeElement !== els.softenLevel) {
    els.softenLevel.value = String(soften.level || 30);
    updateSliderText(soften.level || 30);
  }
  setSwitch(els.dampen, settings.dampen === true);
  setSwitch(els.panic, settings.panic === true);

  var hosts = Object.keys(settings.allowed || {}).sort();
  els.list.textContent = '';
  els.empty.hidden = hosts.length > 0;
  els.removeAll.hidden = hosts.length < 2;
  hosts.forEach(function (host, index) {
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
      focusListIndexAfterRender = index;
      withFreshSettings(function (s) {
        var allowed = {};
        Object.keys(s.allowed || {}).forEach(function (h) {
          if (h !== host) allowed[h] = true;
        });
        chrome.storage.local.set({ allowed: allowed });
      });
    });
    li.appendChild(span);
    li.appendChild(btn);
    els.list.appendChild(li);
  });

  if (focusListIndexAfterRender >= 0) {
    var buttons = els.list.querySelectorAll('button');
    var target = buttons[Math.min(focusListIndexAfterRender, buttons.length - 1)];
    if (target) {
      target.focus();
    } else {
      // list emptied: land focus on the explanatory empty state
      els.empty.setAttribute('tabindex', '-1');
      els.empty.focus();
    }
    focusListIndexAfterRender = -1;
  }
}

function updateSliderText(level) {
  els.softenValue.textContent = level + '%';
  els.softenLevel.setAttribute('aria-valuetext', level + '%');
}

function reload() {
  chrome.storage.local.get(DEFAULT_SETTINGS, function (stored) {
    settings = stored || DEFAULT_SETTINGS;
    // panic is session-scoped (clears on browser restart)
    if (chrome.storage.session) {
      chrome.storage.session.get({ panic: false }, function (sess) {
        settings.panic = !!(sess && sess.panic === true);
        render();
      });
      return;
    }
    settings.panic = false;
    render();
  });
}

els.master.addEventListener('click', function () {
  withFreshSettings(function (s) {
    chrome.storage.local.set({ enabled: s.enabled === false });
  });
});

Object.keys(els.features).forEach(function (name) {
  els.features[name].addEventListener('click', function () {
    withFreshSettings(function (s) {
      var f = featuresOf(s);
      f[name] = !f[name];
      chrome.storage.local.set({ features: f });
    });
  });
});

els.removeAll.addEventListener('click', function () {
  focusListIndexAfterRender = 0; // the button hides itself; land on the empty state
  chrome.storage.local.set({ allowed: {} });
});

els.soften.addEventListener('click', function () {
  withFreshSettings(function (s) {
    var current = s.soften || DEFAULT_SETTINGS.soften;
    chrome.storage.local.set({
      soften: { enabled: current.enabled !== true, level: current.level || 30 }
    });
  });
});

// live feedback while dragging; persistence happens on release ('change')
els.softenLevel.addEventListener('input', function () {
  updateSliderText(Number(els.softenLevel.value) || 30);
});

els.softenLevel.addEventListener('change', function () {
  withFreshSettings(function (s) {
    var current = s.soften || DEFAULT_SETTINGS.soften;
    chrome.storage.local.set({
      soften: { enabled: current.enabled === true, level: Number(els.softenLevel.value) || 30 }
    });
  });
});

els.dampen.addEventListener('click', function () {
  withFreshSettings(function (s) {
    chrome.storage.local.set({ dampen: s.dampen !== true });
  });
});

els.panic.addEventListener('click', function () {
  if (!chrome.storage.session) return;
  chrome.storage.session.get({ panic: false }, function (sess) {
    chrome.storage.session.set({ panic: !(sess && sess.panic === true) });
  });
});

els.shortcuts.addEventListener('click', function () {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' || area === 'session') reload();
});

reload();
