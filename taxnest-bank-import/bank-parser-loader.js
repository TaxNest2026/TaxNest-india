/* bank-parser-loader.js -- loads every parser listed in bank-parsers/manifest.json, in order, before a statement is read.
   Include it in bank-recon-landing.html AFTER bank-parser-core.js and universal-parser.js.
   The extractor waits for window.BankParserLoader.ready before choosing a parser.
   If the manifest is missing or a file fails, the tool still runs and uses the universal parser (it says so in the console). */
(function (root) {
  'use strict';
  var BASE = 'bank-parsers/';

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  var ready = fetch(BASE + 'manifest.json', { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error('manifest.json not found (' + r.status + ')'); return r.json(); })
    .then(function (m) {
      // one after another, so a parser never loads before the one it depends on
      return (m.parsers || []).reduce(function (p, file) {
        return p.then(function () { return loadScript(BASE + file); });
      }, Promise.resolve());
    })
    .then(function () { console.info('TaxNest: bank parsers loaded from ' + BASE); })
    .catch(function (e) { console.warn('TaxNest: bank parsers not loaded (' + e.message + '). Universal parser will be used.'); });

  root.BankParserLoader = { ready: ready };
})(typeof window !== 'undefined' ? window : this);
