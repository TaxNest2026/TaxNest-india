/* parser-indian-overseas-bank.js -- Indian Overseas Bank account statement ("Statement for the period from dd/mm/yyyy to dd/mm/yyyy").
   Single file, standalone. Layout (verified on a 5-page IOB statement, 2019):
     DATE | CHQ NO | NARRATION | COD | DEBIT | CREDIT | BALANCE
     - a transaction starts on a line beginning dd-MON-yyyy; on that line the last two amounts are the amount and the balance
       and the token before them is the code (CLR, TRF, CSH ...)
     - the cheque / reference number, when present, sits on the line below as a number; narration may wrap on further lines
     - there is NO Dr/Cr marker: direction comes from the running balance
     - the statement prints only Total Debit and Total Credit; the opening balance is derived from them and the closing balance:
       opening = closing - total credit + total debit. The first row's balance is checked against it.
     - balances may be negative (overdraft): a leading minus sign is kept.
   Registers with the tool: bank id 64 (Indian Overseas Bank), or the statement text. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  var MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
  var ROW = /^(\d{2})-([A-Z]{3})-(\d{4})\s+(.*)$/;
  var MONEY = /^-?\d{1,3}(?:,\d{2,3})*\.\d{1,2}$|^-?\d+\.\d{1,2}$/;
  var CODES = /^(CLR|TRF|CSH|CHQ|ATM|CLG|DD|ECS|NEFT|RTGS|IMPS|SI|INT|CHG)$/i;
  var FURNITURE = [
    /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}$/, /^DATE\s+CHQ/i, /^NO\s*$/i, /^Statement for the period/i,
    /^Total Debit/i, /denotes cancelled/i, /computer generated/i, /^Page\s+\d+/i, /^Customer Id/i, /^Open Dt/i,
    /^Status\s*:/i, /^Address\s*:/i, /IFSC CODE/i, /MICR CODE/i, /^EMAIL ID/i, /^INDIAN OVERSEAS BANK/i, /^\(\d{4}\)/
  ];
  function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function isFurniture(l) { for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].test(l)) return true; return false; }
  function ymd(d, mon, y) { return y + (MON[mon.toUpperCase()] || '00') + d; }

  function parse(text) {
    var raw = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l !== ''; });
    var tDebit = null, tCredit = null;
    raw.forEach(function (l) {
      var t = l.match(/Total Debit:\s*([\d,]+\.?\d*)\s+Total Credit:\s*([\d,]+\.?\d*)/i);
      if (t && tDebit === null) { tDebit = num(t[1]); tCredit = num(t[2]); }
    });

    var rows = [], cur = null, skipped = [];
    function close() { if (cur) { rows.push(cur); cur = null; } }
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      if (/^Total Debit/i.test(line)) { close(); break; }
      var m = line.match(ROW);
      if (m) {
        close();
        var toks = m[4].split(' ').filter(function (t) { return t !== ''; });
        var bal = toks[toks.length - 1], amt = toks[toks.length - 2];
        if (!MONEY.test(bal) || !MONEY.test(amt)) { skipped.push({ lines: [line], reason: 'amount/balance not on the dated line' }); continue; }
        var desc = toks.slice(0, toks.length - 2);
        if (desc.length && CODES.test(desc[desc.length - 1])) desc.pop();
        cur = { date: ymd(m[1], m[2], m[3]), narration: desc.join(' '), refNo: '', amount: Math.abs(num(amt)), balance: num(bal) };
        continue;
      }
      if (!cur) continue;                                  // statement header before the first row
      if (isFurniture(line)) continue;
      if (/^\d{5,}$/.test(line) && !cur.refNo) { cur.refNo = line; continue; }   // cheque / reference number on its own line
      cur.narration += ' ' + line;
    }
    close();

    // opening balance: derived from the printed totals and the closing balance (IOB prints no opening figure)
    var closing = rows.length ? rows[rows.length - 1].balance : null;
    var opening = (tDebit !== null && closing !== null) ? Math.round((closing - tCredit + tDebit) * 100) / 100 : null;

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
        amount: Math.round(r.amount * 100) / 100, drCr: drCr, refNo: r.refNo, balance: r.balance, confidence: conf, reference_no: 'IOB-' + (idx + 1) });
      if (drCr === 'D') sumD += r.amount; else sumC += r.amount;
    });
    sumD = Math.round(sumD * 100) / 100; sumC = Math.round(sumC * 100) / 100;

    var dates = transactions.map(function (t) { return t.date; }).sort();
    return {
      transactions: transactions, skipped: skipped, layout: 'iob', directionFromMarker: false,
      statement: {
        opening_balance: opening, closing_balance: closing,
        period_start: dates[0] || null, period_end: dates[dates.length - 1] || null,
        opening_source: opening !== null ? 'derived' : 'none', closing_source: closing !== null ? 'derived' : 'none',
        printed_total_debit: tDebit, printed_total_credit: tCredit,
        totals_match: tDebit !== null ? (Math.abs(sumD - tDebit) < 0.05 && Math.abs(sumC - tCredit) < 0.05) : null
      },
      repair: { reconstructed: 0, noBalanceEffect: 0, amountFromBalance: 0, markerConflicts: 0, headGap: 0, tailGap: 0, firstDirection: 'balance', notes: bad ? [bad + ' row(s) did not match the balance movement.'] : [] }
    };
  }

  parse.wantsHints = false;
  parse.meta = {
    key: 'indian_overseas_bank', label: 'Indian Overseas Bank', bankIds: ['64'],
    detect: function (t) { return /Statement for the period from/i.test(t) && /IOBA0\d{6}/i.test(t) && /DEBIT\s+CREDIT\s+BALANCE/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
