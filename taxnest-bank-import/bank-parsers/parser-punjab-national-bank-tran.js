/* parser-punjab-national-bank-tran.js -- Punjab National Bank statement, format "Tran Date | Withdrawal | Deposit | Balance | Alpha CHQ.NO | Narration".
   Single file, standalone. Layout (verified on a 3-page PNB statement, 72 transactions, oldest first):
     - a transaction starts on a line beginning dd-mm-yyyy; the line carries: amount, balance followed by "Cr." or "Dr.",
       and the first part of the narration. The amount has no column marker in the text: direction comes from the running balance.
     - narration continues on the lines below, until the next dated line
     - each page prints "Page Total" and the statement ends with "Grand  <withdrawals>  <deposits>": used as the checks
     - the opening balance is derived: opening = closing - grand deposits + grand withdrawals.
   Registers with the tool: bank id 14 (Punjab National Bank), or the statement text. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  var ROW = /^(\d{2})-(\d{2})-(\d{4})\s+(.*)$/;
  var MONEY = /^\d{1,3}(?:,\d{2,3})*\.\d{1,2}$|^\d+\.\d{1,2}$/;
  var FURNITURE = [
    /^Tran Date\s+Withdrawal/i, /^Page\s+\d+ of \d+/i, /^Page Total/i, /^Disclaimer:/i, /^Statement of Account No/i,
    /^Printed By/i, /^DATE:/i, /^Customer Name:/i, /^CKYC No/i, /^Customer Address:/i, /^Branch Address:/i,
    /^Branch Contact No/i, /^Customer Care No/i, /^IFSC Code:/i, /^Acct Currency/i, /^Statement for Period/i,
    /^Statement of Account/i, /^Alpha CHQ/i, /^This is a computer/i, /^Electronically Generated/i
  ];
  function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function isFurniture(l) { for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].test(l)) return true; return false; }

  function parse(text) {
    var raw = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l !== ''; });
    var gTotal = null;
    raw.forEach(function (l) {
      var g = l.match(/^Grand\s+([\d,]+\.\d{1,2})\s+([\d,]+\.\d{1,2})$/i);
      if (g && gTotal === null) gTotal = { debit: num(g[1]), credit: num(g[2]) };
    });

    var rows = [], cur = null, skipped = [];
    function close() { if (cur) { rows.push(cur); cur = null; } }
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      if (/^Grand\s/i.test(line)) { close(); break; }
      var m = line.match(ROW);
      if (m) {
        close();
        var toks = m[4].split(' ').filter(function (t) { return t !== ''; });
        // the balance is followed by its Cr./Dr. marker; the narration follows the marker (it is not at the end of the line)
        var j = -1;
        for (var q = 1; q < toks.length; q++) if (/^(Cr|Dr)\.?$/i.test(toks[q]) && MONEY.test(toks[q - 1])) { j = q; break; }
        if (j < 2 || !MONEY.test(toks[j - 2])) { skipped.push({ lines: [line], reason: 'amount, balance or Cr/Dr not on the dated line' }); continue; }
        var amt = toks[j - 2], bal = toks[j - 1], crdr = toks[j];
        var balance = num(bal) * (/^Dr/i.test(crdr) ? -1 : 1);
        var before = toks.slice(0, j - 2), after = toks.slice(j + 1);
        cur = { date: m[3] + m[2] + m[1], narration: before.concat(after).join(' '), amount: num(amt), balance: balance };
        continue;
      }
      if (!cur) continue;
      if (isFurniture(line)) continue;
      cur.narration += ' ' + line;
    }
    close();

    // oldest first in this format; the closing is the last balance; opening from the printed grand totals
    var closing = rows.length ? rows[rows.length - 1].balance : null;
    var opening = (gTotal && closing !== null) ? Math.round((closing - gTotal.credit + gTotal.debit) * 100) / 100 : null;

    var prev = opening, bad = 0, sumD = 0, sumC = 0;
    var transactions = rows.map(function (r, idx) {
      var conf = 'high', drCr = 'D';
      if (prev !== null) {
        var mv = Math.round((r.balance - prev) * 100) / 100;
        if (Math.abs(Math.abs(mv) - r.amount) < 0.005) drCr = mv > 0 ? 'C' : 'D';
        else { conf = 'low'; bad++; drCr = mv > 0 ? 'C' : 'D'; }
      } else conf = 'low';
      prev = r.balance;
      if (drCr === 'D') sumD += r.amount; else sumC += r.amount;
      return { date: r.date, narration: r.narration.replace(/\s+/g, ' ').trim() || '(narration not detected)',
        amount: Math.round(r.amount * 100) / 100, drCr: drCr, refNo: '', balance: r.balance, confidence: conf, reference_no: 'PNB1-' + (idx + 1) };
    });
    sumD = Math.round(sumD * 100) / 100; sumC = Math.round(sumC * 100) / 100;

    var dates = transactions.map(function (t) { return t.date; }).sort();
    return {
      transactions: transactions, skipped: skipped, layout: 'pnb_tran', directionFromMarker: false,
      statement: {
        opening_balance: opening, closing_balance: closing,
        period_start: dates[0] || null, period_end: dates[dates.length - 1] || null,
        opening_source: opening !== null ? 'derived' : 'none', closing_source: 'statement',
        printed_total_debit: gTotal ? gTotal.debit : null, printed_total_credit: gTotal ? gTotal.credit : null,
        totals_match: gTotal ? (Math.abs(sumD - gTotal.debit) < 0.05 && Math.abs(sumC - gTotal.credit) < 0.05) : null
      },
      repair: { reconstructed: 0, noBalanceEffect: 0, amountFromBalance: 0, markerConflicts: 0, headGap: 0, tailGap: 0, firstDirection: 'balance', notes: bad ? [bad + ' row(s) did not match the balance movement.'] : [] }
    };
  }

  parse.wantsHints = false;
  parse.meta = {
    key: 'pnb_tran', label: 'Punjab National Bank (Tran Date format)', bankIds: ['14'],
    detect: function (t) { return /Tran Date\s+Withdrawal\s+Deposit\s+Balance/i.test(t) && /Statement for Period/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
