/* parser-axis-bank.js -- Axis Bank savings / salary account statement ("Statement of Account No ... for the period").
   Single file, standalone. Layout (verified on a 47-page Axis statement):
     Tran Date | Chq No | Particulars | Debit | Credit | Balance | Init. Br
     - the narration can wrap ABOVE the date line: the text lines before a date line belong to that row
     - the date line carries: date, the last part of the narration, the amount, the balance, the branch code
     - there is NO Dr/Cr marker: direction comes from the running balance (the printed opening starts the chain)
     - printed OPENING BALANCE, TRANSACTION TOTAL (debit, credit) and CLOSING BALANCE are used as checks.
   Registers with the tool: bank id for Axis Bank, or the statement text. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  var DATE_LINE = /^(\d{2})-(\d{2})-(\d{4})\s+(.*)$/;
  var MONEY = /^\d{1,3}(?:,\d{3})*\.\d{2}$|^\d+\.\d{2}$/;
  var FURNITURE = [
    /^Tran Date\s+Chq No/i, /^Br$/i, /^Init\.?\s*Br/i, /^Page\s+\d+\s+of\s+\d+/i, /^Statement of Account No/i,
    /Customer ID\s*:/i, /IFSC Code\s*:/i, /MICR Code\s*:/i, /Nominee Registered/i, /Registered (Mobile|Email)/i,
    /^Scheme\s*:/i, /PAN\s*:/i, /^AXIS BANK/i, /^Axis Bank/i, /registered office/i, /computer generated/i,
    /^The closing balance/i, /^excludes the amount/i, /^from you sharing/i, /^\*\*/i
  ];
  function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function isFurniture(l) { for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].test(l)) return true; return false; }

  function parse(text) {
    var raw = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l !== ''; });
    var opening = null, tDebit = null, tCredit = null, closing = null;
    raw.forEach(function (l) {
      var o = l.match(/^OPENING BALANCE\s+([\d,]+\.\d{2})$/i); if (o && opening === null) opening = num(o[1]);
      var c = l.match(/^CLOSING BALANCE\s+([\d,]+\.\d{2})$/i); if (c && closing === null) closing = num(c[1]);
      var t = l.match(/^TRANSACTION TOTAL\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/i); if (t && tDebit === null) { tDebit = num(t[1]); tCredit = num(t[2]); }
    });

    var rows = [], pending = [], skipped = [];
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      if (/^TRANSACTION TOTAL/i.test(line) || /^CLOSING BALANCE/i.test(line)) break;
      if (/^OPENING BALANCE/i.test(line)) { pending = []; continue; }
      if (isFurniture(line)) continue;
      var m = line.match(DATE_LINE);
      if (!m) { pending.push(line); continue; }

      var toks = m[4].split(' ').filter(function (t) { return t !== ''; });
      if (toks.length && /^\d{3}$/.test(toks[toks.length - 1])) toks.pop();          // branch code
      var bal = toks[toks.length - 1], amt = toks[toks.length - 2];
      if (!MONEY.test(bal) || !MONEY.test(amt)) { skipped.push({ lines: pending.concat([line]), reason: 'amount/balance not on the date line' }); pending = []; continue; }
      var tail = toks.slice(0, toks.length - 2).join(' ');
      var head = pending.join(' ');
      var narr = (head + ' ' + tail).replace(/\s+/g, ' ').trim();
      rows.push({ date: m[3] + m[2] + m[1], narration: narr, amount: num(amt), balance: num(bal) });
      pending = [];
    }

    // direction from the running balance
    var prev = opening, transactions = [], sumD = 0, sumC = 0, bad = 0;
    rows.forEach(function (r, idx) {
      var conf = 'high', drCr = 'D';
      if (prev !== null) {
        var d = Math.round((r.balance - prev) * 100) / 100;
        if (Math.abs(Math.abs(d) - r.amount) < 0.005) drCr = d > 0 ? 'C' : 'D';
        else { conf = 'low'; bad++; drCr = d > 0 ? 'C' : 'D'; }
      } else conf = 'low';
      prev = r.balance;
      transactions.push({ date: r.date, narration: r.narration || '(narration not detected)', amount: Math.round(r.amount * 100) / 100,
        drCr: drCr, refNo: '', balance: r.balance, confidence: conf, reference_no: 'AXIS-' + (idx + 1) });
      if (drCr === 'D') sumD += r.amount; else sumC += r.amount;
    });
    sumD = Math.round(sumD * 100) / 100; sumC = Math.round(sumC * 100) / 100;

    var dates = transactions.map(function (t) { return t.date; }).sort();
    return {
      transactions: transactions, skipped: skipped, layout: 'axis', directionFromMarker: false,
      statement: {
        opening_balance: opening, closing_balance: closing,
        period_start: dates[0] || null, period_end: dates[dates.length - 1] || null,
        opening_source: opening !== null ? 'statement' : 'none', closing_source: closing !== null ? 'statement' : 'none',
        printed_total_debit: tDebit, printed_total_credit: tCredit,
        totals_match: tDebit !== null ? (Math.abs(sumD - tDebit) < 0.05 && Math.abs(sumC - tCredit) < 0.05) : null
      },
      repair: { reconstructed: 0, noBalanceEffect: 0, amountFromBalance: 0, markerConflicts: 0, headGap: 0, tailGap: 0, firstDirection: 'balance', notes: bad ? [bad + ' row(s) did not match the balance movement.'] : [] }
    };
  }

  parse.wantsHints = false;
  parse.meta = {
    key: 'axis_bank', label: 'Axis Bank', bankIds: ['2'],
    detect: function (t) { return /Statement of Account No\s*:?\s*\d+\s+for the period/i.test(t) && /Init\.?\s*Br/i.test(t) && /AXIS BANK|UTIB0\d{6}/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
