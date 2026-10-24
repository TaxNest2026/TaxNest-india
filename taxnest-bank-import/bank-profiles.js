/* bank-profiles.js -- bank-specific parsers that are the balance-driven universal parser plus what we learned from that bank's REAL PDF:
   how its rows are laid out (centered?) and how to tidy its narration. Each one was verified against a real statement
   (row counts, opening/closing and, where printed, the statement's own totals). Add a bank by adding one entry here and one
   line to BANK_ID_TO_PARSER_KEY in bank-recon-extract.js. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;
  var U = (typeof module !== 'undefined' && module.exports) ? require('./universal-parser.js') : root.UniversalParser;
  function squash(n) { return n.replace(/\s+/g, ' ').trim(); }

  var PROFILES = {
    // ICICI "S.no | Transaction ID | date | cheque | description | withdrawal | deposit | balance": date's year wraps to the next line,
    // description wraps at ~9 characters, column headers only on page 1 (the column hints carry over).
    icici: { label: 'ICICI Bank', centered: false, narration: function (n) { return squash(n.replace(/^[A-Z]\d{4,}\s+/, '').replace(/^\d{4,8}\s+(?=[A-Za-z])/, '')); } },
    // Canara: the description cell is vertically centred, so lines above the date belong to the same row.
    canara: { label: 'Canara Bank', centered: true, narration: function (n) { return squash(n.replace(/\bChq:\s*\d+\b/g, '').replace(/\bNULL\b/g, '')); } },
    // Sarvodaya: empty Cheque/Debit/Credit cells leave stray "0 - ." tokens inside the narration.
    sarvodaya: { label: 'Sarvodaya Commercial Co-op Bank', centered: false, narration: function (n) { return squash(n.replace(/\s(?:-|\.)(?=\s|$)/g, ' ').replace(/\s0(?=\s|$)/g, ' ')); } }
  };

  Object.keys(PROFILES).forEach(function (key) {
    if (Core.hasSpecificParser && Core.hasSpecificParser(key)) return;   // a dedicated parser file for this bank wins
    var prof = PROFILES[key];
    var fn = function (text) { var r = U.extractUniversal(text, { profile: prof }); r.layout = key; return r; };
    fn.wantsHints = true; fn.centered = !!prof.centered;
    Core.registerParser(key, fn);
  });
  var BankProfiles = { PROFILES: PROFILES };
  if (typeof module !== 'undefined' && module.exports) module.exports = BankProfiles; else root.BankProfiles = BankProfiles;
})(typeof window !== 'undefined' ? window : this);
