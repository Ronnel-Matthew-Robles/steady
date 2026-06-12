// Stage the popup as it appears on a normal website (the staging page itself
// is an extension page, which the popup would refuse to adjust). Re-applied on
// an interval so the last write wins over the popup's own async renders.
// External file because extension-page CSP blocks inline scripts.
'use strict';
setInterval(function () {
  try {
    var d = document.getElementById('pf').contentDocument;
    var status = d && d.getElementById('status');
    if (status) {
      status.textContent = 'Calming motion on example.com.';
      d.getElementById('site-row').hidden = false;
      d.getElementById('site-host').textContent = 'example.com';
    }
  } catch (e) { /* keep trying */ }
}, 150);
