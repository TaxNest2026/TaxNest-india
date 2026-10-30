/* parser-federal-bank.js -- The Federal Bank Ltd, savings / current statement ("STATEMENT OF ACCOUNT PERIOD").
   Single file, standalone. Layout (verified on a 3-page Federal statement, 37 transactions):
     Date | Value Date | Particulars (may wrap) | Tran Type | Cheque Details | Withdrawals | Deposits | Balance | Dr/Cr
     - the row line carries: date, value date, particulars, tran type (TFR/CLG/CASH), amount, balance, Dr/Cr
     - Dr/Cr at the end of the row is the transaction direction (Dr = money out, Cr = money in)
     - a printed GRAND TOTAL line gives withdrawals and deposits: used as a check.
   Registers with the tool: bank id 6 (Federal Bank Ltd) or the statement text. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  var ROW = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2})\/(\d{2})\/(\d{4})\s+(.*)$/;
  var MONEY = /^\d{1,3}(?:,\d{3})*\.\d{2}$|^\d+\.\d{2}$/;
  var DRCR = /^(Dr|Cr)$/i;
  var TRAN = /^(TFR|CLG|CASH|ATM|CHQ|SMS)$/i;
  var FURNITURE = [/^Page \d+ of \d+/i, /^The Federal Bank Ltd/i, /^Phone number/i, /24\*7 Phone Banking/i, /^1800 /i,
    /^www\.federal/i, /^Date\s+Value Date/i, /^STATEMENT OF ACCOUNT/i, /^Abbreviations Used/i, /^CASH\s+Cash/i, /^FT\s+Fund/i];
  function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function isFurniture(l) { for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].test(l)) return true; return false; }

  function parse(text) {
    var raw = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); });
    var opening = null, gTotal = null;
    for (var i = 0; i < raw.length; i++) {
      if (opening === null && /^Opening Balance\s+[\d,]+\.\d{2}$/i.test(raw[i])) opening = num(raw[i].split(' ').pop());
      if (gTotal === null && /^GRAND TOTAL/i.test(raw[i])) { var g = raw[i].split(' ').filter(MONEY.test.bind(MONEY)); if (g.length >= 2) gTotal = { debit: num(g[0]), credit: num(g[1]) }; }
    }

    var rows = [], cur = null, skipped = [];
    function close() { if (cur) { rows.push(cur); cur = null; } }
    for (var k = 0; k < raw.length; k++) {
      var line = raw[k];
      if (!line) continue;
      if (/^GRAND TOTAL/i.test(line)) break;
      var m = line.match(ROW);
      if (m) {
        close();
        var toks = m[7].split(' ').filter(function (t) { return t !== ''; });
        var dr = toks[toks.length - 1];
        if (!DRCR.test(dr)) { skipped.push({ lines: [line], reason: 'Dr/Cr marker missing' }); continue; }
        var bal = toks[toks.length - 2];
        if (!MONEY.test(bal)) { skipped.push({ lines: [line], reason: 'balance missing' }); continue; }
        var end = toks.length - 2, amt = toks[end - 1];
        if (!MONEY.test(amt)) { skipped.push({ lines: [line], reason: 'amount missing' }); continue; }
        var nEnd = end - 1;
        var tranIdx = -1;
        for (var t = nEnd - 1; t >= 0 && t >= nEnd - 3; t--) if (TRAN.test(toks[t])) { tranIdx = t; break; }
        var narr = tranIdx >= 0 ? toks.slice(0, tranIdx) : toks.slice(0, nEnd);
        var cheque = tranIdx >= 0 ? toks.slice(tranIdx + 1, nEnd) : [];
        cur = {
          date: m[3] + m[2] + m[1], valueDate: m[6] + m[5] + m[4],
          narration: narr.join(' '), refNo: cheque.join(' '),
          amount: num(amt), balance: num(bal), drCr: dr.toUpperCase() === 'DR' ? 'D' : 'C', lines: 1
        };
        continue;
      }
      if (!cur) continue;                                      // header block and account details
      if (isFurniture(line)) continue;
      cur.narration += ' ' + line;
    }
    close();

    var transactions = [], sumD = 0, sumC = 0;
    rows.forEach(function (r, idx) {
      var n = r.narration.replace(/\s+/g, ' ').trim();
      transactions.push({ date: r.date, narration: n || '(narration not detected)', amount: Math.round(r.amount * 100) / 100, drCr: r.drCr,
        refNo: r.refNo, balance: r.balance, confidence: 'high', reference_no: 'FED-' + (idx + 1) });
      if (r.drCr === 'D') sumD += r.amount; else sumC += r.amount;
    });
    sumD = Math.round(sumD * 100) / 100; sumC = Math.round(sumC * 100) / 100;

    var dates = transactions.map(function (t) { return t.date; }).sort();
    return {
      transactions: transactions, skipped: skipped, layout: 'federal', directionFromMarker: true,
      statement: {
        opening_balance: opening, closing_balance: transactions.length ? transactions[transactions.length - 1].balance : null,
        period_start: dates[0] || null, period_end: dates[dates.length - 1] || null,
        opening_source: opening !== null ? 'statement' : 'none', closing_source: 'derived',
        printed_total_debit: gTotal ? gTotal.debit : null, printed_total_credit: gTotal ? gTotal.credit : null,
        totals_match: gTotal ? (Math.abs(sumD - gTotal.debit) < 0.05 && Math.abs(sumC - gTotal.credit) < 0.05) : null
      },
      repair: { reconstructed: 0, noBalanceEffect: 0, amountFromBalance: 0, markerConflicts: 0, headGap: 0, tailGap: 0, firstDirection: 'marker', notes: [] }
    };
  }

  parse.wantsHints = false;
  parse.meta = {
    key: 'federal_bank', label: 'Federal Bank', bankIds: ['6'],
    detect: function (t) { return /federal\.co\.in|The Federal Bank Ltd/i.test(t) && /STATEMENT OF ACCOUNT PERIOD/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
