/* parser-icici-statement-of-transactions.js -- ICICI Bank savings account statement "Statement of Transactions in Saving Account no. ... for the period ...".
   Single file, standalone. Layout (verified on an 18-page ICICI statement, Apr 2025 - Apr 2026, 288 transactions):
     S No. | Date (dd.mm.yyyy) | Cheque number / Transaction remarks | Withdrawal Amount | Deposit Amount | Balance
     - a transaction starts on a line: S No., then the date dd.mm.yyyy; the last two amounts are the transaction amount and the balance
     - the amount carries a column marker from the PDF layout: "(Dr)" = withdrawal, "(Cr)" = deposit. The parser REQUIRES these
       markers (it reads the statement as hinted text, see pdf-lines.js). Without them the row is flagged low confidence.
     - remarks continue on the lines below (e.g. "Clearance of cheque", "CLG/..."), until the next numbered row
     - no totals are printed; the opening balance is derived from the first row, and the balance chain is checked on every row.
   Registers with the tool: bank id for ICICI Bank Ltd (8). Reads HINTED text (wantsHints = true). */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  var ROW = /^(\d+)\s+(\d{2})\.(\d{2})\.(\d{4})\s+(.*)$/;
  var AMT = /^(\d{1,3}(?:,\d{2,3})*\.\d{2}|\d+\.\d{2})(?:\((Dr|Cr)\))?$/;
  var BAL = /^-?\d{1,3}(?:,\d{2,3})*\.\d{2}$|^-?\d+\.\d{2}$/;
  var FURNITURE = [
    /^Statement of Transactions in Saving Account/i, /^Your Base Branch/i, /^Transaction Withdrawal Deposit Balance/i,
    /^S No\.\s+Cheque Number/i, /^Date\s+Amount \(INR\)/i, /^Page\s+\d+/i, /^\d+\s*$/, /^Account Summary/i,
    /^Opening Balance/i, /^Total/i, /^Summary of/i, /^ICICI Bank/i, /^Dial your Bank/i, /^www\.icici/i
  ];
  var STOP = /^(Abbreviations|Below are the abbreviations|INFT - Internal Fund Transfer|Team ICICI Bank)/i;   // the legend after the last row
  // footer phrases that can be printed inside a remark line, not only on their own line
  var FOOTER_PHRASES = /www\.icici\.bank\.in|Dial your Bank 1800-1080|Please call from your registered mobile number for faster access|Never share your OTP, CVV or passwords with anyone, even if the person claims to be a Bank employee\./gi;
  function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function isFurniture(l) { for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].test(l)) return true; return false; }

  function parse(text) {
    var raw = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l !== ''; });
    var rows = [], cur = null, skipped = [];
    function close() { if (cur) { rows.push(cur); cur = null; } }
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      if (STOP.test(line)) { close(); break; }
      var m = line.match(ROW);
      if (m) {
        close();
        var toks = m[5].split(' ').filter(function (t) { return t !== ''; });
        var n = toks.length, bal = n >= 1 ? toks[n - 1] : '', a = n >= 2 ? toks[n - 2] : '';
        var am = a.match(AMT);
        if (!BAL.test(bal) || !am) { skipped.push({ lines: [line], reason: 'amount/balance not on the numbered row' }); continue; }
        var drCr = am[2] ? (am[2] === 'Dr' ? 'D' : 'C') : null;
        cur = { date: m[4] + m[3] + m[2], srNo: m[1], narration: toks.slice(0, n - 2).join(' '), amount: num(am[1]), drCr: drCr, balance: num(bal) };
        continue;
      }
      if (!cur) continue;
      if (isFurniture(line)) continue;
      cur.narration += ' ' + line;
    }
    close();

    // direction: the column marker decides the first row; every later row must also agree with the balance chain
    var first = rows[0], opening = null;
    if (first && first.drCr) opening = Math.round((first.drCr === 'C' ? first.balance - first.amount : first.balance + first.amount) * 100) / 100;

    var prev = opening, transactions = [], sumD = 0, sumC = 0, bad = 0, noMarker = 0;
    rows.forEach(function (r, idx) {
      var conf = 'high', drCr = r.drCr;
      if (!drCr) { noMarker++; conf = 'low'; }
      if (prev !== null) {
        var mv = Math.round((r.balance - prev) * 100) / 100;
        var chainDr = mv < 0 ? 'D' : 'C';
        if (Math.abs(Math.abs(mv) - r.amount) >= 0.005) { conf = 'low'; bad++; }
        else if (drCr && drCr !== chainDr) { conf = 'low'; bad++; }
        if (!drCr) drCr = chainDr;
      }
      if (!drCr) drCr = 'C';
      prev = r.balance;
      if (drCr === 'D') sumD += r.amount; else sumC += r.amount;
      var clean = r.narration.replace(FOOTER_PHRASES, ' ').replace(/\s+/g, ' ').trim();
      transactions.push({ date: r.date, narration: clean || '(narration not detected)',
        amount: Math.round(r.amount * 100) / 100, drCr: drCr, refNo: '', balance: r.balance, confidence: conf, reference_no: 'ICICI-' + r.srNo });
    });
    sumD = Math.round(sumD * 100) / 100; sumC = Math.round(sumC * 100) / 100;

    var closing = transactions.length ? transactions[transactions.length - 1].balance : null;
    var dates = transactions.map(function (t) { return t.date; }).sort();
    return {
      transactions: transactions, skipped: skipped, layout: 'icici_sot', directionFromMarker: true,
      statement: {
        opening_balance: opening, closing_balance: closing,
        period_start: dates[0] || null, period_end: dates[dates.length - 1] || null,
        opening_source: opening !== null ? 'derived' : 'none', closing_source: 'derived',
        printed_total_debit: null, printed_total_credit: null, totals_match: null
      },
      repair: { reconstructed: 0, noBalanceEffect: 0, amountFromBalance: 0, markerConflicts: bad, headGap: 0, tailGap: 0, firstDirection: 'marker', notes: [].concat(noMarker ? [noMarker + ' row(s) had no column marker in the text.'] : [], bad ? [bad + ' row(s) did not agree with the balance movement (usually a credit shown with no movement and reversed by the next row, "Clearance of cheque").'] : []) }
    };
  }

  parse.wantsHints = true;
  parse.meta = {
    key: 'icici_sot', label: 'ICICI Bank (Statement of Transactions)', bankIds: ['8'],
    detect: function (t) { return /Statement of Transactions in Saving Account/i.test(t) && /ICIC0\d{6}|ICICI BANK/i.test(t) && /Withdrawal\s+Deposit\s+Balance/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
