/* parser-nutan-nagrik-bank.js -- Nutan Nagarik Sahakari Bank Ltd statement ("STATEMENT OF THE ACCOUNT", Statement Period from ... to ...).
   Single file, standalone. Layout (verified on a 3-page statement, Apr-Sep 2025):
     Sr. No. | Date | Transaction particulars | Instrument number | Withdrawals | Deposits | Balance
     - each transaction is printed as a numbered row carrying the date, the particulars, and (last two amounts) the amount and balance
     - a payment usually appears as two numbered rows: the credit leg, then the debit leg (its particulars start with "-")
     - there is NO Dr/Cr marker: direction comes from the running balance; the printed opening balance starts the chain
     - the statement prints a TOTAL line: withdrawals, deposits and the closing balance. Used as the checks.
   Registers with the tool: bank id 123 (Nutan Nagarik Sahakari Bank Ltd), or the statement text. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  var ROW = /^(\d+)\s+(\d{2})\/(\d{2})\/(\d{4})\s+(.*)$/;
  var MONEY = /^\d{1,3}(?:,\d{2,3})*\.\d{2}$|^\d+\.\d{2}$/;
  var FURNITURE = [
    /^STATEMENT OF THE ACCOUNT/i, /^Customer\s*:/i, /^Customer Id\s*:/i, /^Name\s/i, /^Mobile Number/i, /^IFSC Code\s*:/i,
    /^Address\s/i, /^COLINA/i, /^Branch Address/i, /^Branch Name/i, /^Statement Date/i, /^Sr\. No\./i, /^DATE\s+NUMBER/i,
    /^Branch\s*$/i, /^Page\s+\d+/i, /^This is a computer/i, /^Nutan Nagarik/i, /^NAGARIK SAHAKARI/i, /^Nagar Colony/i,
    /^Naranpura,?$/i, /^MR KUNAL/i, /^SHAH$/i, /^C 601/i
  ];
  function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function isFurniture(l) { for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].test(l)) return true; return false; }

  function parse(text) {
    var raw = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l !== ''; });
    var opening = null, tW = null, tD = null, tClose = null;
    raw.forEach(function (l) {
      var o = l.match(/Opening Balance\s*:\s*([\d,]+\.\d{2})/i); if (o && opening === null) opening = num(o[1]);
      var t = l.match(/^TOTAL\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/i); if (t && tW === null) { tW = num(t[1]); tD = num(t[2]); tClose = num(t[3]); }
    });

    var rows = [], cur = null, skipped = [];
    function close() { if (cur) { rows.push(cur); cur = null; } }
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      if (/^TOTAL\s/i.test(line)) { close(); break; }
      var m = line.match(ROW);
      if (m) {
        close();
        var toks = m[5].split(' ').filter(function (t) { return t !== ''; });
        var bal = toks[toks.length - 1], amt = toks[toks.length - 2];
        if (!MONEY.test(bal) || !MONEY.test(amt)) { skipped.push({ lines: [line], reason: 'amount/balance not on the numbered row' }); continue; }
        var desc = toks.slice(0, toks.length - 2), ref = '';
        if (desc.length && /^\d{9,}$/.test(desc[desc.length - 1])) ref = desc.pop();
        cur = { date: m[4] + m[3] + m[2], srNo: m[1], narration: desc.join(' '), refNo: ref, amount: num(amt), balance: num(bal) };
        continue;
      }
      if (!cur) continue;
      if (isFurniture(line)) continue;
      cur.narration += ' ' + line;
    }
    close();

    var prev = opening, transactions = [], sumW = 0, sumD = 0, bad = 0;
    rows.forEach(function (r, idx) {
      var conf = 'high', drCr = 'D';
      if (prev !== null) {
        var mv = Math.round((r.balance - prev) * 100) / 100;
        if (Math.abs(Math.abs(mv) - r.amount) < 0.005) drCr = mv > 0 ? 'C' : 'D';
        else { conf = 'low'; bad++; drCr = mv > 0 ? 'C' : 'D'; }
      } else conf = 'low';
      prev = r.balance;
      if (drCr === 'D') sumW += r.amount; else sumD += r.amount;
      transactions.push({ date: r.date, narration: r.narration.replace(/\s+/g, ' ').trim() || '(narration not detected)',
        amount: Math.round(r.amount * 100) / 100, drCr: drCr, refNo: r.refNo, balance: r.balance, confidence: conf, reference_no: 'NNSB-' + r.srNo });
    });
    sumW = Math.round(sumW * 100) / 100; sumD = Math.round(sumD * 100) / 100;

    var closing = transactions.length ? transactions[transactions.length - 1].balance : null;
    var dates = transactions.map(function (t) { return t.date; }).sort();
    return {
      transactions: transactions, skipped: skipped, layout: 'nutan_nagrik', directionFromMarker: false,
      statement: {
        opening_balance: opening, closing_balance: tClose !== null ? tClose : closing,
        period_start: dates[0] || null, period_end: dates[dates.length - 1] || null,
        opening_source: opening !== null ? 'statement' : 'none', closing_source: tClose !== null ? 'statement' : 'derived',
        printed_total_debit: tW, printed_total_credit: tD,
        totals_match: tW !== null ? (Math.abs(sumW - tW) < 0.05 && Math.abs(sumD - tD) < 0.05) : null
      },
      repair: { reconstructed: 0, noBalanceEffect: 0, amountFromBalance: 0, markerConflicts: 0, headGap: 0, tailGap: 0, firstDirection: 'balance', notes: bad ? [bad + ' row(s) did not match the balance movement.'] : [] }
    };
  }

  parse.wantsHints = false;
  parse.meta = {
    key: 'nutan_nagrik', label: 'Nutan Nagarik Sahakari Bank', bankIds: ['123'],
    detect: function (t) { return /STATEMENT OF THE ACCOUNT/i.test(t) && /NNSB0\d{6}/i.test(t) && /Statement Period from/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
