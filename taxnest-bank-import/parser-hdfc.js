/* parser-hdfc.js -- HDFC Bank statement parser (one file, drop into the project).
   Auto-registers itself. The tool picks it when the selected bank is HDFC (bank id 7)
   or when the statement text looks like an HDFC statement. Verified on a real HDFC April 2025 statement:
   56 rows (25 Dr / 31 Cr) match the bank's printed totals; opening and closing match. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;
  var Universal = (typeof module !== 'undefined' && module.exports) ? require('./universal-parser.js') : root.UniversalParser;

  function squash(s) { return s.replace(/\s+/g, ' ').trim(); }
  function narration(n) {
    // drop the trailing cheque / UTR reference and dates; keep the description readable
    var s = squash(n.replace(/\b\d{2}\/\d{2}\/\d{2,4}\b/g, ' '));
    for (var k = 0; k < 2; k++) s = s.replace(/\s+(?=[A-Z0-9]*\d)[A-Z0-9]{10,}$/, '');
    return squash(s.replace(/^[-\s]+|[-\s]+$/g, ''));
  }

  function parse(text) {
    var r = Universal.extractUniversal(text, { profile: { narration: narration } });
    r.layout = 'hdfc';
    return r;
  }
  parse.wantsHints = true;                       // use the column-hinted text (Withdrawal / Deposit columns)
  parse.meta = {
    key: 'hdfc',
    label: 'HDFC Bank',
    bankIds: ['7'],                               // from bank-list.js
    detect: function (t) { return /HDFC\s*BANK/i.test(t) && /Statement\s*of\s*account/i.test(t) && /RTGS\/NEFT\s*IFSC|HDFC0\d{6}/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
