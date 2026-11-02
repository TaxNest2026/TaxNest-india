/* parser-icici-detailed-statement.js -- ICICI Bank "DETAILED STATEMENT" (Sr No | Value Date | Transaction Date | Cheque Number |
   Transaction Remarks | Debit Amount | Credit Amount | Balance(INR)).
   Single file, standalone. Layout (verified on a 5-page ICICI detailed statement, Mar 2023):
     - a transaction starts on a line: Sr No, then the value date dd-Mon-yyyy, then the transaction date (day and month only;
       its year wraps onto the next line in the PDF, so the value date's year is used)
     - on that line the last three columns are: debit amount (or NA), credit amount (or NA), balance. NA marks the empty column:
       DIRECTION IS EXPLICIT (debit if the debit cell has an amount, credit if the credit cell does)
     - remarks continue on the lines below; a wrapped year line ("2023  315278499") carries the cheque number
     - no totals or opening balance are printed; the opening balance is derived from the first row, and the balance chain is checked.
   Registers with the tool: bank id for ICICI Bank Ltd (8), or the statement text. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  var MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  var ROW = /^(\d+)\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(.*)$/;
  var MONEY = /^-?\d{1,3}(?:,\d{2,3})*\.\d{2}$|^-?\d+\.\d{2}$/;   // balances may be negative (overdraft)
  var FURNITURE = [
    /^DETAILED STATEMENT$/i, /^Account Number:/i, /^Account Name:/i, /^Transaction Date (From|To):/i, /^Amount Range/i,
    /^Cheque number/i, /^Transaction Type:/i, /^Sr No\s/i, /^n Date\s/i, /^n Remarks/i, /^R\)$/i, /^Page\s+\d+/i,
    /^This is a computer/i, /^ICICI Bank/i, /^Total/i
  ];
  function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function ymd(d, mon, y) { return y + (MON[mon.toLowerCase()] || '00') + ('0' + d).slice(-2); }
  function isFurniture(l) { for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].test(l)) return true; return false; }

  function parse(text) {
    var raw = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l !== ''; });
    var rows = [], cur = null, skipped = [];
    function close() { if (cur) { rows.push(cur); cur = null; } }
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      var m = line.match(ROW);
      if (m) {
        close();
        var toks = m[5].split(' ').filter(function (t) { return t !== ''; });
        var bal = toks[toks.length - 1], cr = toks[toks.length - 2], dr = toks[toks.length - 3];
        var okCell = function (t) { return t === 'NA' || MONEY.test(t); };
        if (!MONEY.test(bal) || !okCell(cr) || !okCell(dr)) { skipped.push({ lines: [line], reason: 'debit/credit/balance not on the dated line' }); continue; }
        // the transaction date (day and month) sits first in the rest of the line; drop it
        var rest = toks.slice(0, toks.length - 3);
        if (rest.length && /^\d{1,2}-[A-Za-z]{3}-?$/.test(rest[0])) rest.shift();
        var cheque = '';
        if (rest.length && /^\d{3,9}$/.test(rest[0])) cheque = rest.shift();
        cur = { date: ymd(m[2], m[3], m[4]), narration: rest.join(' '), refNo: cheque,
          debit: dr === 'NA' ? 0 : num(dr), credit: cr === 'NA' ? 0 : num(cr), balance: num(bal), srNo: m[1] };
        continue;
      }
      if (!cur) continue;
      if (isFurniture(line)) continue;
      var y = line.match(/^(\d{4})\s+(\d{6,})\s*(.*)$/);      // wrapped year line: "2023   315278499 ..."
      if (y) { if (!cur.refNo) cur.refNo = y[2]; if (y[3]) cur.narration += ' ' + y[3]; continue; }
      if (/^\d{4}$/.test(line)) continue;                       // a bare wrapped year
      var yr = line.match(/^(20\d{2})\s+(.*)$/);                // wrapped year followed by remarks text
      if (yr) { if (yr[2]) cur.narration += ' ' + yr[2]; continue; }
      cur.narration += ' ' + line;
    }
    close();

    // the first row fixes the opening balance (its direction is explicit)
    var first = rows[0], opening = null;
    if (first) opening = Math.round((first.debit > 0 ? first.balance + first.debit : first.balance - first.credit) * 100) / 100;

    var prev = opening, transactions = [], sumD = 0, sumC = 0, bad = 0;
    rows.forEach(function (r, idx) {
      var amount = r.debit > 0 ? r.debit : r.credit, drCr = r.debit > 0 ? 'D' : 'C', conf = 'high';
      if (r.debit > 0 && r.credit > 0) conf = 'low';
      if (prev !== null) {
        var mv = Math.round((r.balance - prev) * 100) / 100;
        if (!((drCr === 'C' && mv > 0 && Math.abs(mv - amount) < 0.005) || (drCr === 'D' && mv < 0 && Math.abs(-mv - amount) < 0.005))) { conf = 'low'; bad++; }
      }
      prev = r.balance;
      if (drCr === 'D') sumD += amount; else sumC += amount;
      transactions.push({ date: r.date, narration: r.narration.replace(/\s+/g, ' ').trim() || '(narration not detected)',
        amount: Math.round(amount * 100) / 100, drCr: drCr, refNo: r.refNo, balance: r.balance, confidence: conf, reference_no: 'ICICI-' + r.srNo });
    });
    sumD = Math.round(sumD * 100) / 100; sumC = Math.round(sumC * 100) / 100;

    var closing = transactions.length ? transactions[transactions.length - 1].balance : null;
    var dates = transactions.map(function (t) { return t.date; }).sort();
    return {
      transactions: transactions, skipped: skipped, layout: 'icici_detailed', directionFromMarker: true,
      statement: {
        opening_balance: opening, closing_balance: closing,
        period_start: dates[0] || null, period_end: dates[dates.length - 1] || null,
        opening_source: opening !== null ? 'derived' : 'none', closing_source: 'derived',
        printed_total_debit: null, printed_total_credit: null, totals_match: null
      },
      repair: { reconstructed: 0, noBalanceEffect: 0, amountFromBalance: 0, markerConflicts: 0, headGap: 0, tailGap: 0, firstDirection: 'columns', notes: bad ? [bad + ' row(s) did not match the balance movement.'] : [] }
    };
  }

  parse.wantsHints = false;
  parse.meta = {
    key: 'icici_detailed', label: 'ICICI Bank (Detailed Statement)', bankIds: ['8'],
    detect: function (t) { return /DETAILED STATEMENT/i.test(t) && /Transaction Remarks/i.test(t) && /Debit Amount/i.test(t) && /Credit Amount/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
