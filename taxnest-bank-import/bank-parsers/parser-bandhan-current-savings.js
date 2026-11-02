/* parser-bandhan-current-savings.js -- Bandhan Bank "Current and Savings Account Statement" (Statement period From dd Mon yyyy to dd Mon yyyy).
   Single file, standalone. Layout (verified on a 17-page Bandhan statement, Apr 2025 - Mar 2026, 122 transactions):
     Transaction Date | Value Date | Description | Amount | Dr / Cr | Balance
     - a transaction starts on a line: transaction date and value date printed as "March31, 2026" (no space before the day),
       then the description; the line ends with: amount (INR-prefixed), Dr or Cr, balance (INR-prefixed)
     - Dr / Cr is explicit: Dr = withdrawal, Cr = deposit
     - the description wraps onto the lines below, until the next dated line
     - the statement prints Opening Balance, Total Credits, Total Debits and Closing Balance: used as checks.
   Registers with the tool: bank id 36 (Bandhan Bank), or the statement text. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  var MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  var ROW = /^([A-Za-z]{3,9})\s?(\d{1,2}),\s?(\d{4})\s+([A-Za-z]{3,9})\s?(\d{1,2}),\s?(\d{4})\s+(.*)$/;
  var MONEY = /^INR-?[\d,]+\.\d{2}$/;
  var FURNITURE = [
    /^Account Statement as on/i, /^Customer Account Details/i, /^Account Number/i, /^Account Type/i, /^Branch Details/i,
    /^Customer ID/i, /^IFSC/i, /^MICR Code/i, /^Nomination Registered/i, /^Joint Holder/i, /^Statement period/i,
    /^Statement Details/i, /^Transaction Date\s+Value Date/i, /^Page\s+\d+/i, /^Statement generated on/i,
    /^This is a computer/i, /^Bandhan Bank/i
  ];
  function num(s) { return parseFloat(String(s).replace(/INR/g, '').replace(/,/g, '')); }
  function ymd(d, mon, y) { return y + (MON[mon.toLowerCase().slice(0, 3)] || '00') + ('0' + d).slice(-2); }
  function isFurniture(l) { for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].test(l)) return true; return false; }

  function parse(text) {
    var raw = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l !== ''; });
    var opening = null, tCr = null, tDr = null, closing = null;
    for (var s = 0; s < raw.length; s++) {
      if (/^Opening Balance\s+Total Credits/i.test(raw[s]) && s + 1 < raw.length) {
        var v = raw[s + 1].match(/^INR([\d,]+\.\d{2})\s+INR([\d,]+\.\d{2})\s+INR([\d,]+\.\d{2})\s+INR([\d,]+\.\d{2})$/);
        if (v) { opening = num(v[1]); tCr = num(v[2]); tDr = num(v[3]); closing = num(v[4]); }
        break;
      }
    }

    var rows = [], cur = null, skipped = [];
    function close() { if (cur) { rows.push(cur); cur = null; } }
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      if (/^Statement Summary/i.test(line)) { close(); break; }
      var m = line.match(ROW);
      if (m) {
        close();
        var toks = m[7].split(' ').filter(function (t) { return t !== ''; });
        var n = toks.length, bal = n >= 1 ? toks[n - 1] : '', drcr = n >= 2 ? toks[n - 2] : '', amt = n >= 3 ? toks[n - 3] : '';
        if (!MONEY.test(bal) || !MONEY.test(amt) || !/^(Dr|Cr)$/i.test(drcr)) { skipped.push({ lines: [line], reason: 'amount, Dr/Cr or balance not on the dated line' }); continue; }
        cur = { date: ymd(m[2], m[1], m[3]), narration: toks.slice(0, n - 3).join(' '), amount: Math.abs(num(amt)),
          drCr: drcr.toUpperCase() === 'DR' ? 'D' : 'C', balance: num(bal) };
        continue;
      }
      if (!cur) continue;
      if (isFurniture(line)) continue;
      cur.narration += ' ' + line;
    }
    close();

    // the statement lists the newest row first: walk the balance chain oldest -> newest, then restore the statement's order
    var chron = rows.slice().reverse();
    var prev = opening, transactions = [], sumD = 0, sumC = 0, bad = 0;
    chron.forEach(function (r, idx) {
      var conf = 'high';
      if (prev !== null) {
        var mv = Math.round((r.balance - prev) * 100) / 100;
        var ok = (r.drCr === 'C' && mv > 0 || r.drCr === 'D' && mv < 0) && Math.abs(Math.abs(mv) - r.amount) < 0.005;
        if (!ok) { conf = 'low'; bad++; }
      }
      prev = r.balance;
      if (r.drCr === 'D') sumD += r.amount; else sumC += r.amount;
      transactions.push({ date: r.date, narration: r.narration.replace(/\s+/g, ' ').trim() || '(narration not detected)',
        amount: Math.round(r.amount * 100) / 100, drCr: r.drCr, refNo: '', balance: r.balance, confidence: conf, reference_no: 'BAND-' + (idx + 1) });
    });
    transactions.reverse();
    sumD = Math.round(sumD * 100) / 100; sumC = Math.round(sumC * 100) / 100;

    var dates = transactions.map(function (t) { return t.date; }).sort();
    return {
      transactions: transactions, skipped: skipped, layout: 'bandhan_cs', directionFromMarker: true,
      statement: {
        opening_balance: opening, closing_balance: closing,
        period_start: dates[0] || null, period_end: dates[dates.length - 1] || null,
        opening_source: opening !== null ? 'statement' : 'none', closing_source: closing !== null ? 'statement' : 'none',
        printed_total_debit: tDr, printed_total_credit: tCr,
        totals_match: tDr !== null ? (Math.abs(sumD - tDr) < 0.05 && Math.abs(sumC - tCr) < 0.05) : null
      },
      repair: { reconstructed: 0, noBalanceEffect: 0, amountFromBalance: 0, markerConflicts: bad, headGap: 0, tailGap: 0, firstDirection: 'marker',
        notes: bad ? [bad + ' row(s) did not agree with the balance movement.'] : [] }
    };
  }

  parse.wantsHints = false;
  parse.meta = {
    key: 'bandhan_cs', label: 'Bandhan Bank (Current and Savings Account Statement)', bankIds: ['36'],
    detect: function (t) { return /Current and Savings Account Statement/i.test(t) && /Dr \/ Cr/i.test(t) && /BDBL0\d{6}|Bandhan/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
