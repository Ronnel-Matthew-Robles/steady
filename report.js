// Steady problem-report builder.
//
// Assembles the report locally and lets the user choose the channel: copy to
// clipboard, a mailto draft (no account needed), or a pre-filled GitHub issue
// (the public tracker). Nothing is collected or transmitted by the extension
// itself. External file because extension-page CSP blocks inline scripts.

'use strict';

var MAIL_TO = 'matthewnrobles@gmail.com';
var GITHUB_NEW_ISSUE = 'https://github.com/Ronnel-Matthew-Robles/steady/issues/new';

var els = {
  site: document.getElementById('ctx-site'),
  version: document.getElementById('ctx-version'),
  browser: document.getElementById('ctx-browser'),
  what: document.getElementById('f-what'),
  expected: document.getElementById('f-expected'),
  preview: document.getElementById('preview'),
  copy: document.getElementById('copy-btn'),
  mail: document.getElementById('mail-link'),
  github: document.getElementById('gh-link'),
  status: document.getElementById('copy-status')
};

// Host arrives via query string from the popup; keep only hostname characters.
var host = (new URLSearchParams(location.search).get('host') || '')
  .replace(/[^\w.-]/g, '').slice(0, 253);

var version = chrome.runtime.getManifest().version;

function browserLine() {
  var ua = navigator.userAgent;
  var chromeVer = (ua.match(/Chrome\/(\d+)/) || [])[1] || '?';
  var os = /Mac/.test(ua) ? 'macOS' : /Win/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'unknown OS';
  return 'Chrome ' + chromeVer + ' on ' + os;
}

function buildReport() {
  return [
    'Steady problem report',
    '',
    'Site: ' + (host || '(general feedback)'),
    'Steady version: ' + version,
    'Browser: ' + browserLine(),
    '',
    'What happened:',
    els.what.value.trim() || '(not filled in)',
    '',
    'What I expected:',
    els.expected.value.trim() || '(not filled in)'
  ].join('\n');
}

function update() {
  var report = buildReport();
  var title = host ? 'Problem on ' + host : 'Problem report';
  els.preview.textContent = report;
  els.mail.href = 'mailto:' + MAIL_TO +
    '?subject=' + encodeURIComponent('Steady: ' + title) +
    '&body=' + encodeURIComponent(report);
  els.github.href = GITHUB_NEW_ISSUE +
    '?title=' + encodeURIComponent(title) +
    '&body=' + encodeURIComponent(report);
}

els.site.textContent = host || '(general feedback)';
els.version.textContent = version;
els.browser.textContent = browserLine();
els.what.addEventListener('input', update);
els.expected.addEventListener('input', update);
update();

els.copy.addEventListener('click', function () {
  var report = buildReport();
  var done = function () { els.status.textContent = 'Copied. Paste it anywhere you like.'; };
  var fail = function () { els.status.textContent = 'Copy failed. You can select the preview text above instead.'; };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(report).then(done, fail);
    } else {
      fail();
    }
  } catch (e) {
    fail();
  }
});
