/* parser-indusind-bank.js -- IndusInd Bank Ltd account statement ("Account Statement", Transaction History).
   Single file, standalone. Layout (verified on a 9-page IndusInd statement, 117 transactions, newest first):
     Date | Particulars | Chq No/Ref No | Withdrawal | Deposit | Balance
     - a transaction starts on a line beginning "dd Mon yyyy"; on that line the last three amounts are
       withdrawal, deposit and balance (one of the first two is 0.00 = explicit direction)
     - the cheque / reference (letter + digits, e.g. S99860351) sits just before the withdrawal amount
     - the particulars continue on the lines below, until the next dated line
     - no totals are printed; the opening balance is taken from the oldest row (its balance less its deposit plus its withdrawal),
       and the balance chain is checked on every row.
   Registers with the tool: bank id 10 (IndusInd Bank Ltd), or the statement text. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  var MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  var ROW = /^(\d{2}) ([A-Za-z]{3}) (\d{4})\s+(.*)$/;
  var MONEY = /^\d{1,3}(?:,\d{2,3})*\.\d{2}$|^\d+\.\d{2}$/;
  var REF = /^[A-Z]{0,2}\d{5,}$/;
  var FURNITURE = [
    /^Account Statement$/i, /^Date:\s/i, /^Period:\s/i, /^Customer Details/i, /^Name\s+Holding/i, /^Account Summary/i,
    /^Account No\.\s+Account Type/i, /^Transaction History/i, /^Statement Period:/i, /^Nomination Registered/i,
    /^Date\s+Particulars\s+Chq No/i, /^This is a computer generated/i, /^Phones Banking/i, /^\*Service Tax/i,
    /^seven days/i, /^\*This is a computer/i, /^Registered office/i, /^\(CIN\)/i, /^Acronyms:/i, /^:Real Time/i,
    /^This statement is downloaded/i, /^Grievance Officer/i, /^https?:\/\//i, /^Page\s+\d+/i, /^Mob\.No/i,
    /^VIJAY SINGH/i, /^ABKARI ROAD/i, /^SIROHI/i, /^RAJASTHAN/i, /^INDIA\.?$/i, /^ROAD, \.,/i,
    /^Money Identification/i, /^Services Tax\)?/i, /^Lien Amount/i, /^\d{12}\s*$/i, /^\s*\d{12}\s+INDUS/i
  ];
  function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function isFurniture(l) { for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].test(l)) return true; return false; }
  function ymd(d, mon, y) { return y + (MON[mon.toLowerCase()] || '00') + d; }

  function parse(text) {
    var raw = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l !== ''; });
    var closing = null;
    raw.forEach(function (l) {
      var c = l.match(/^\d{9,}\s+[A-Z ]+\s+INR\s+[\d,]+\.\d{2}\s+([\d,]+\.\d{2})$/);
      if (c && closing === null) closing = num(c[1]);
    });
    var sumLine = raw.filter(function (l) { return /^\d{9,}\s+INDUS CLASSIC/i.test(l); })[0];
    var closing_summary = null;
    if (sumLine) { var t = sumLine.split(' '); closing_summary = num(t[t.length - 1]); }

    var rows = [], cur = null, skipped = [];
    function close() { if (cur) { rows.push(cur); cur = null; } }
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      var m = line.match(ROW);
      if (m) {
        close();
        var toks = m[4].split(' ').filter(function (t) { return t !== ''; });
        if (toks.length < 3) { skipped.push({ lines: [line], reason: 'too few fields on dated line' }); continue; }
        var bal = toks[toks.length - 1], dep = toks[toks.length - 2], wdl = toks[toks.length - 3];
        if (!MONEY.test(bal) || !MONEY.test(dep) || !MONEY.test(wdl)) { skipped.push({ lines: [line], reason: 'withdrawal/deposit/balance not on the dated line' }); continue; }
        var desc = toks.slice(0, toks.length - 3), ref = '';
        if (desc.length && REF.test(desc[desc.length - 1]) && /\d/.test(desc[desc.length - 1])) ref = desc.pop();
        var w = num(wdl), d = num(dep);
        cur = { date: ymd(m[1], m[2], m[3]), narration: desc.join(' '), refNo: ref, withdrawal: w, deposit: d, balance: num(bal) };
        continue;
      }
      if (!cur) continue;                                  // header block before the first row
      if (isFurniture(line)) continue;
      cur.narration += ' ' + line;
    }
    close();

    // rows are newest first in the statement; the chain runs oldest -> newest
    var chron = rows.slice().reverse();
    var oldest = chron[0];
    var opening = null;
    if (oldest) opening = Math.round((oldest.balance - oldest.deposit + oldest.withdrawal) * 100) / 100;

    var prev = opening, transactions = [], sumD = 0, sumC = 0, bad = 0;
    chron.forEach(function (r, idx) {
      var amount, drCr, conf = 'high';
      if (r.withdrawal > 0 && r.deposit === 0) { amount = r.withdrawal; drCr = 'D'; }
      else if (r.deposit > 0 && r.withdrawal === 0) { amount = r.deposit; drCr = 'C'; }
      else { conf = 'low'; amount = Math.max(r.withdrawal, r.deposit); drCr = r.deposit > r.withdrawal ? 'C' : 'D'; }
      if (prev !== null) {
        var mv = Math.round((r.balance - prev) * 100) / 100;
        if (Math.abs(Math.abs(mv) - amount) >= 0.005) { conf = 'low'; bad++; }
      }
      prev = r.balance;
      transactions.push({ date: r.date, narration: r.narration.replace(/\s+/g, ' ').trim() || '(narration not detected)',
        amount: Math.round(amount * 100) / 100, drCr: drCr, refNo: r.refNo, balance: r.balance, confidence: conf, reference_no: 'INDUS-' + (idx + 1) });
      if (drCr === 'D') sumD += amount; else sumC += amount;
    });
    sumD = Math.round(sumD * 100) / 100; sumC = Math.round(sumC * 100) / 100;
    transactions.reverse();                                 // keep the statement's own order (newest first)

    // closing = balance after the newest transaction in the history. The Account Summary balance is the balance on the
    // day the statement was generated, which can be later than the period end, so it is only kept for reference.
    closing = transactions.length ? transactions[0].balance : closing;

    var dates = transactions.map(function (t) { return t.date; }).sort();
    return {
      transactions: transactions, skipped: skipped, layout: 'indusind', directionFromMarker: true,
      statement: {
        opening_balance: opening, closing_balance: closing,
        period_start: dates[0] || null, period_end: dates[dates.length - 1] || null,
        opening_source: opening !== null ? 'derived' : 'none', closing_source: 'derived', account_summary_balance: sumLine ? closing_summary : null,
        printed_total_debit: null, printed_total_credit: null, totals_match: null
      },
      repair: { reconstructed: 0, noBalanceEffect: 0, amountFromBalance: 0, markerConflicts: 0, headGap: 0, tailGap: 0, firstDirection: 'columns', notes: bad ? [bad + ' row(s) did not match the balance movement.'] : [] }
    };
  }

  parse.wantsHints = false;
  parse.meta = {
    key: 'indusind_bank', label: 'IndusInd Bank', bankIds: ['10'],
    detect: function (t) { return /INDUSIND BANK/i.test(t) && /Transaction History/i.test(t) && /Withdrawal\s+Deposit\s+Balance/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
