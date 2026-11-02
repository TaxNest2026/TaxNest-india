/* parser-canara-bank-txn.js -- Canara Bank account statement, format "Txn Date | Value Date | Cheque No. | Description | Branch Code | Debit | Credit | Balance".
   Single file, standalone. Layout (verified on a 3-page Canara statement, 2019-2020):
     - a transaction starts on a line beginning dd-Mon-yyyy (transaction date), then the value date;
       on that line the last two amounts are the transaction amount and the running balance
     - the description may wrap onto the lines below (e.g. "CLIENT-SCNB...") and a branch code / cheque no sits before the description
     - there is NO Dr/Cr marker in the text: direction comes from the running balance; the printed opening starts the chain
     - the statement prints Opening Balance and Closing Balance (used as checks). No totals are printed.
   Registers with the tool: bank id 5 (Canara Bank), or the statement text. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  var MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  var ROW = /^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2})-([A-Za-z]{3})-(\d{4})\s+(.*)$/;
  var MONEY = /^\d{1,3}(?:,\d{2,3})*\.\d{2}$|^\d+\.\d{2}$/;
  var FURNITURE = [
    /^Txn Date\s+Value Date/i, /^No\. Code$/i, /^Page \d+ of \d+/i, /^Account Statement as of/i, /^Customer Name/i,
    /^Branch\s+DOLESHWAR/i, /^Account Number/i, /^Customer Id/i, /^Account Currency/i, /^Opening Balance/i, /^Closing Balance/i,
    /^Statement of/i, /^This is a computer/i, /^Canara Bank/i
  ];
  function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function ymd(d, mon, y) { return y + (MON[mon.toLowerCase()] || '00') + d; }
  function isFurniture(l) { for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].test(l)) return true; return false; }

  function parse(text) {
    var raw = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l !== ''; });
    var opening = null, closing = null;
    raw.forEach(function (l) {
      var o = l.match(/^Opening Balance\s+([\d,]+\.\d{2})$/i); if (o && opening === null) opening = num(o[1]);
      var c = l.match(/^Closing Balance\s+([\d,]+\.\d{2})$/i); if (c && closing === null) closing = num(c[1]);
    });

    var rows = [], cur = null, skipped = [];
    function close() { if (cur) { rows.push(cur); cur = null; } }
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      if (/^ ?-+ ?END OF STATEMENT/i.test(line)) { close(); break; }
      var m = line.match(ROW);
      if (m) {
        close();
        var toks = m[7].split(' ').filter(function (t) { return t !== ''; });
        var bal = toks[toks.length - 1], amt = toks[toks.length - 2];
        if (!MONEY.test(bal) || !MONEY.test(amt)) { skipped.push({ lines: [line], reason: 'amount/balance not on the dated line' }); continue; }
        var desc = toks.slice(0, toks.length - 2), ref = '';
        if (desc.length && /^\d{6,}$/.test(desc[desc.length - 1])) ref = desc.pop();
        cur = { date: ymd(m[1], m[2], m[3]), narration: desc.join(' '), refNo: ref, amount: num(amt), balance: num(bal) };
        continue;
      }
      if (!cur) continue;
      if (isFurniture(line)) continue;
      cur.narration += ' ' + line;
    }
    close();

    var prev = opening, transactions = [], sumD = 0, sumC = 0, bad = 0;
    rows.forEach(function (r, idx) {
      var conf = 'high', drCr = 'D';
      if (prev !== null) {
        var mv = Math.round((r.balance - prev) * 100) / 100;
        if (Math.abs(Math.abs(mv) - r.amount) < 0.005) drCr = mv > 0 ? 'C' : 'D';
        else { conf = 'low'; bad++; drCr = mv > 0 ? 'C' : 'D'; }
      } else conf = 'low';
      prev = r.balance;
      if (drCr === 'D') sumD += r.amount; else sumC += r.amount;
      transactions.push({ date: r.date, narration: r.narration.replace(/\s+/g, ' ').trim() || '(narration not detected)',
        amount: Math.round(r.amount * 100) / 100, drCr: drCr, refNo: r.refNo, balance: r.balance, confidence: conf, reference_no: 'CAN-' + (idx + 1) });
    });
    sumD = Math.round(sumD * 100) / 100; sumC = Math.round(sumC * 100) / 100;

    var dates = transactions.map(function (t) { return t.date; }).sort();
    return {
      transactions: transactions, skipped: skipped, layout: 'canara_txn', directionFromMarker: false,
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
    key: 'canara_txn', label: 'Canara Bank (Txn Date format)', bankIds: ['5'],
    detect: function (t) { return /Txn Date\s+Value Date\s+Cheque/i.test(t) && /Account Statement as of/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
