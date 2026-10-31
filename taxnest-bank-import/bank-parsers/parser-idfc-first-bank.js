/* parser-idfc-first-bank.js -- IDFC FIRST Bank Ltd savings statement ("STATEMENT OF ACCOUNT", STATEMENT PERIOD yyyy-mm-dd TO yyyy-mm-dd).
   Single file, standalone. Layout (verified on a 10-page IDFC FIRST statement):
     Transaction Date | Value Date | Particulars | Cheque No | Debit | Credit | Balance
     - a transaction starts on a line beginning dd-Mon-yyyy (then the value date)
     - its last two amounts on that line are the amount and the running balance
     - the particulars continue on the lines below, until the next dated line
     - there is NO Dr/Cr marker: direction comes from the running balance; the printed opening starts the chain
     - the statement prints Opening Balance, Total Debit, Total Credit, Closing Balance: used as checks.
   Registers with the tool: bank id for IDFC First Bank Ltd, or the statement text. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  var MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  var ROW = /^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2})-([A-Za-z]{3})-(\d{4})\s+(.*)$/;
  var MONEY = /^\d{1,3}(?:,\d{2,3})*\.\d{2}$|^\d+\.\d{2}$/;
  var FURNITURE = [
    /^Transaction\s+Value Date/i, /^Date\s+No\s*$/i, /^Opening Balance/i, /^Total Debit/i, /^Closing Balance/i,
    /^STATEMENT OF ACCOUNT/i, /^CUSTOMER ID/i, /^ACCOUNT NO/i, /^STATEMENT PERIOD/i, /^CUSTOMER NAME/i, /^BRANCH ADDRESS/i,
    /^COMMUNICATION/i, /^EMAIL ID/i, /^PHONE NO/i, /^CKYC ID/i, /^NOMINATION/i, /^NOMINEE NAME/i, /^CURRENCY/i,
    /^Page\s+\d+/i, /^This is a computer/i, /^IDFC FIRST BANK/i, /Registered Office/i, /^End of statement/i,
    /^Power - \d+K/i, /^(ADDRESS|SHAH|SABARMATI|JAIN DERASAR|380005 GUJARAT)/i
  ];
  function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function isFurniture(l) { for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].test(l)) return true; return false; }
  function ymd(d, mon, y) { return y + (MON[mon.toLowerCase()] || '00') + d; }

  function parse(text) {
    var raw = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l !== ''; });
    var opening = null, tDebit = null, tCredit = null, closing = null;
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i].match(/^([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/);
      if (s && opening === null && i > 0 && /Opening Balance/i.test(raw[i - 1])) {
        opening = num(s[1]); tDebit = num(s[2]); tCredit = num(s[3]); closing = num(s[4]); break;
      }
    }
    if (opening === null) { var ob = raw.filter(function (l) { return /^Opening Balance\s+[\d,]+\.\d{2}$/i.test(l); })[0]; if (ob) opening = num(ob.split(' ').pop()); }

    var rows = [], cur = null, skipped = [];
    function close() { if (cur) { rows.push(cur); cur = null; } }
    for (var k = 0; k < raw.length; k++) {
      var line = raw[k];
      if (/^Opening Balance/i.test(line)) continue;
      if (/^IMPORTANT MESSAGE|End of the statement/i.test(line)) { close(); break; }   // legal notice after the last row
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
        var d = Math.round((r.balance - prev) * 100) / 100;
        if (Math.abs(Math.abs(d) - r.amount) < 0.005) drCr = d > 0 ? 'C' : 'D';
        else { conf = 'low'; bad++; drCr = d > 0 ? 'C' : 'D'; }
      } else conf = 'low';
      prev = r.balance;
      transactions.push({ date: r.date, narration: r.narration.replace(/\s+/g, ' ').trim() || '(narration not detected)',
        amount: Math.round(r.amount * 100) / 100, drCr: drCr, refNo: r.refNo, balance: r.balance, confidence: conf, reference_no: 'IDFC-' + (idx + 1) });
      if (drCr === 'D') sumD += r.amount; else sumC += r.amount;
    });
    sumD = Math.round(sumD * 100) / 100; sumC = Math.round(sumC * 100) / 100;

    var dates = transactions.map(function (t) { return t.date; }).sort();
    return {
      transactions: transactions, skipped: skipped, layout: 'idfc_first', directionFromMarker: false,
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
    key: 'idfc_first_bank', label: 'IDFC FIRST Bank', bankIds: ['24'],
    detect: function (t) { return /STATEMENT OF ACCOUNT/i.test(t) && /IDFB0\d{6}/i.test(t) && /IDFC FIRST/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
