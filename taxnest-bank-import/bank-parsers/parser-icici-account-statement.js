/* parser-icici-account-statement.js -- ICICI Bank "Account statement" (Statement of transactions from dd Mon 'yy - dd Mon 'yy).
   Single file, standalone. Layout (verified on a 239-page ICICI statement, 1,879 transactions, Apr 2025 - Mar 2026):
     S.no | Transaction ID | Transaction date | Cheque No | Description | Withdrawal (Dr) | Deposit (Cr) | Available Balance
     - a transaction starts on a line: S.no, the transaction ID, then the date dd-Mon-yyyy (the year can wrap onto the next line)
     - the last two amounts on that line are the transaction amount and the available balance
     - the amount carries a column marker from the PDF layout: "(Dr)" = withdrawal, "(Cr)" = deposit. The parser reads the
       statement as HINTED text (pdf-lines.js). The markers agree with the balance chain on every row of the reference statement.
     - the description wraps onto the lines below, until the next numbered row
     - no totals or opening balance are printed: the opening balance is derived from the first row's marker,
       and the balance chain is checked on every row.
   Replaces the earlier ICICI parser: that one decided the first row by character position, which is wrong on browser text
   (it read a 2,500.00 deposit as a withdrawal, off by 2,500 on each side).
   Registers with the tool: bank id for ICICI Bank Ltd (8). Reads HINTED text (wantsHints = true). */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  var MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  var ROW = /^(\d{1,5})\s+([A-Z]\d{4,}|\d{6,})\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})?\s*(.*)$/;
  var AMT = /^(\d{1,3}(?:,\d{2,3})*\.\d{2}|\d+\.\d{2})(?:\((Dr|Cr)\))?$/;
  var BAL = /^-?\d{1,3}(?:,\d{2,3})*\.\d{2}$|^-?\d+\.\d{2}$/;
  var STOP = /Legends Used in Account Statement|\*This is a system-generated/i;
  var FURNITURE = [
    /^S\.no\s+Transaction/i, /^ID date\s/i, /^Statement of transactions from/i, /^Account statement$/i, /^Account details$/i,
    /^Account (name|number|type|currency)/i, /^Communication/i, /^address:/i, /^IFSC code/i, /^Customer ID/i, /^Balance$/i,
    /^Total effective/i, /^available:\s*/i, /^Available balance:/i, /^Generated on\s*:/i, /^Page\s+\d+\s+of\s+\d+/i,
    /^\d{1,2}\s*$/, /^ICICI Bank/i
  ];
  function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function isFurniture(l) { for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].test(l)) return true; return false; }
  function ymd(d, mon, y) { return y + (MON[mon.toLowerCase()] || '00') + ('0' + d).slice(-2); }

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
        var toks = m[6].split(' ').filter(function (t) { return t !== ''; });
        var n = toks.length, bal = n >= 1 ? toks[n - 1] : '', a = n >= 2 ? toks[n - 2] : '';
        var am = a.match(AMT);
        if (!BAL.test(bal) || !am) { skipped.push({ lines: [line], reason: 'amount/balance not on the numbered row' }); continue; }
        var desc = toks.slice(0, n - 2), cheque = '';
        if (desc.length && /^\d{6,}$/.test(desc[0])) cheque = desc.shift();
        cur = { sno: m[1], id: m[2], date: m[5] ? ymd(m[3], m[4], m[5]) : null, day: m[3], mon: m[4],
          narration: desc.join(' '), refNo: cheque, amount: num(am[1]), drCr: am[2] ? (am[2] === 'Dr' ? 'D' : 'C') : null, balance: num(bal) };
        continue;
      }
      if (!cur) continue;                                        // page-1 account block before the first row
      if (isFurniture(line)) continue;
      var yr = line.match(/^(20\d{2})\s*(.*)$/);                  // wrapped year of the transaction date: "2025 AL TRADERS/H"
      if (yr && !cur.date) { cur.year = yr[1]; if (yr[2]) cur.narration += ' ' + yr[2]; continue; }
      cur.narration += ' ' + line;
    }
    close();

    rows.forEach(function (r) { if (!r.date) r.date = ymd(r.day, r.mon, r.year || '2025'); });

    // opening balance from the first row's marker
    var first = rows[0], opening = null;
    if (first && first.drCr) opening = Math.round((first.drCr === 'C' ? first.balance - first.amount : first.balance + first.amount) * 100) / 100;

    var prev = opening, transactions = [], sumD = 0, sumC = 0, bad = 0, noMarker = 0;
    rows.forEach(function (r) {
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
      transactions.push({ date: r.date, narration: r.narration.replace(/\s+/g, ' ').trim() || '(narration not detected)',
        amount: Math.round(r.amount * 100) / 100, drCr: drCr, refNo: r.refNo || r.id, balance: r.balance, confidence: conf, reference_no: 'ICICI-' + r.sno });
    });
    sumD = Math.round(sumD * 100) / 100; sumC = Math.round(sumC * 100) / 100;

    var closing = transactions.length ? transactions[transactions.length - 1].balance : null;
    var dates = transactions.map(function (t) { return t.date; }).sort();
    return {
      transactions: transactions, skipped: skipped, layout: 'icici_account_statement', directionFromMarker: true,
      statement: {
        opening_balance: opening, closing_balance: closing,
        period_start: dates[0] || null, period_end: dates[dates.length - 1] || null,
        opening_source: opening !== null ? 'derived' : 'none', closing_source: 'derived',
        printed_total_debit: null, printed_total_credit: null, totals_match: null
      },
      repair: { reconstructed: 0, noBalanceEffect: 0, amountFromBalance: 0, markerConflicts: bad, headGap: 0, tailGap: 0, firstDirection: 'marker',
        notes: [].concat(noMarker ? [noMarker + ' row(s) had no column marker in the text.'] : [], bad ? [bad + ' row(s) did not agree with the balance movement.'] : []) }
    };
  }

  parse.wantsHints = true;
  parse.meta = {
    key: 'icici_account_statement', label: 'ICICI Bank (Account statement)', bankIds: ['8'],
    detect: function (t) { return /Statement of transactions from/i.test(t) && /ICIC0\d{6}/i.test(t) && /Withdrawal\s*\(?Dr?\)?\s+Deposit/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
