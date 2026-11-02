/* parser-canara-bank-dep.js -- Canara Bank account statement, format "Date | Particulars | Deposits | Withdrawals | Balance" (multi-page, long).
   Single file, standalone. Layout (verified on a 61-page Canara statement, 561 transactions, Apr-Jun 2025):
     - a transaction starts on a line beginning dd-mm-yyyy; on that line the amount is the money token (if the balance is on the same
       line, the last money token is the balance)
     - the narration wraps: text can sit ABOVE the dated line and the balance is often printed on a line BELOW it
     - there is NO Deposit/Withdrawal marker: the balance is matched to the running chain: the balance is the value
       that equals the previous balance plus or minus the amount; direction follows that movement
     - the statement prints Opening Balance and Closing Balance (used as checks). No totals are printed.
   Registers with the tool: bank id 5 (Canara Bank), or the statement text. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  var DATE = /^(\d{2})-(\d{2})-(\d{4})\s+(.*)$/;
  var MONEY_TOK = /^\d{1,3}(?:,\d{2,3})*\.\d{2}$|^\d+\.\d{2}$/;
  var FURNITURE = [
    /^Date Particulars Deposits/i, /^page \d+$/i, /^Statement for A\/c/i, /^Customer Id/i, /^Branch Code/i, /^Name\s/i,
    /^Branch Name/i, /^Phone\s/i, /^IFSC Code/i, /^A d d r e s s/i, /^Address\s/i, /^GUJARAT$/i, /^AHMEDABAD$/i,
    /^Way, Sabarmati,?\s*(AHMEDABAD)?\s*(GUJARAT)?$/i, /^Opening Balance/i, /^Closing Balance/i, /^COMPUTER OUTPUT/i, /^ARE YOU A MERCHANT/i,
    /^CHANNEL TO RECEIVE/i, /^Bangalore-560001/i, /^10\/3\/8 Nrupatunga/i, /^E-mail:/i, /^-+ ?END OF STATEMENT/i
  ];
  function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function isFurniture(l) { for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].test(l)) return true; return false; }
  function moneyTokens(l) { return l.split(' ').filter(function (t) { return MONEY_TOK.test(t); }); }

  function parse(text) {
    var raw = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l !== ''; });
    var opening = null, closing = null;
    raw.forEach(function (l) {
      var o = l.match(/^Opening Balance\s+([\d,]+\.\d{2})$/i); if (o && opening === null) opening = num(o[1]);
      var c = l.match(/^Closing Balance\s+([\d,]+\.\d{2})$/i); if (c && closing === null) closing = num(c[1]);
    });

    // group the text into blocks: one block per dated line, holding everything up to the next dated line
    var blocks = [], cur = null;
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      if (/END OF STATEMENT/i.test(line) || /^DISCLAIMER UNLESS|Details of Ombudsman/i.test(line)) break;   // bank notice after the last row
      var m = line.match(DATE);
      if (m) { cur = { date: m[3] + m[2] + m[1], first: m[4], lines: [] }; blocks.push(cur); continue; }
      if (!cur) continue;
      if (isFurniture(line)) continue;
      cur.lines.push(line);
    }

    var prev = opening, transactions = [], skipped = [], sumD = 0, sumC = 0, bad = 0;
    blocks.forEach(function (b, idx) {
      var onDate = moneyTokens(b.first);
      var amount = null, balance = null;
      if (onDate.length >= 2) { amount = num(onDate[onDate.length - 2]); balance = num(onDate[onDate.length - 1]); }
      else if (onDate.length === 1) amount = num(onDate[0]);
      if (amount === null) { skipped.push({ lines: [b.first], reason: 'no amount on the dated line' }); return; }

      var drCr = null, conf = 'high';
      if (balance === null && prev !== null) {
        // find the balance among the money values that follow: it must equal prev + amount (credit) or prev - amount (debit)
        var cand = [];
        b.lines.forEach(function (l) { moneyTokens(l).forEach(function (t) { cand.push(num(t)); }); });
        var up = cand.filter(function (v) { return Math.abs(v - (prev + amount)) < 0.005; });
        var dn = cand.filter(function (v) { return Math.abs(v - (prev - amount)) < 0.005; });
        if (up.length === 1 && dn.length === 0) { balance = up[0]; drCr = 'C'; }
        else if (dn.length === 1 && up.length === 0) { balance = dn[0]; drCr = 'D'; }
        else { skipped.push({ lines: [b.first], reason: 'balance could not be matched to the chain' }); prev = null; return; }
      } else if (balance !== null && prev !== null) {
        var mv = Math.round((balance - prev) * 100) / 100;
        if (Math.abs(Math.abs(mv) - amount) < 0.005) drCr = mv > 0 ? 'C' : 'D';
        else { conf = 'low'; bad++; drCr = mv > 0 ? 'C' : 'D'; }
      } else { conf = 'low'; drCr = 'D'; }

      var narr = b.first.replace(/\s+/g, ' ');
      var money = moneyTokens(narr);
      money.forEach(function (t) { narr = narr.replace(t, ' '); });
      var tail = b.lines.filter(function (l) { return moneyTokens(l).length === 0; }).join(' ');
      narr = narr.replace(/DISCLAIMER UNLESS[\s\S]*$/i, '').replace(/Details of Ombudsman[\s\S]*$/i, '');
      tail = tail.replace(/DISCLAIMER UNLESS[\s\S]*$/i, '').replace(/Details of Ombudsman[\s\S]*$/i, '');
      prev = balance;
      if (drCr === 'D') sumD += amount; else sumC += amount;
      transactions.push({ date: b.date, narration: (narr + ' ' + tail).replace(/\s+/g, ' ').trim() || '(narration not detected)',
        amount: Math.round(amount * 100) / 100, drCr: drCr, refNo: '', balance: balance, confidence: conf, reference_no: 'CANB-' + (idx + 1) });
    });
    sumD = Math.round(sumD * 100) / 100; sumC = Math.round(sumC * 100) / 100;

    var dates = transactions.map(function (t) { return t.date; }).sort();
    return {
      transactions: transactions, skipped: skipped, layout: 'canara_dep', directionFromMarker: false,
      statement: {
        opening_balance: opening, closing_balance: closing,
        period_start: dates[0] || null, period_end: dates[dates.length - 1] || null,
        opening_source: opening !== null ? 'statement' : 'none', closing_source: closing !== null ? 'statement' : 'none',
        printed_total_debit: null, printed_total_credit: null, totals_match: null
      },
      repair: { reconstructed: 0, noBalanceEffect: 0, amountFromBalance: 0, markerConflicts: 0, headGap: 0, tailGap: 0, firstDirection: 'balance', notes: bad ? [bad + ' row(s) did not match the balance movement.'] : [] }
    };
  }

  parse.wantsHints = false;
  parse.meta = {
    key: 'canara_dep', label: 'Canara Bank (Date / Deposits format)', bankIds: ['5'],
    detect: function (t) { return /Date\s+Particulars\s+Deposits\s+Withdrawals\s+Balance/i.test(t) && /Statement for A\/c/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
