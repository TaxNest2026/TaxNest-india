/* parser-punjab-national-bank-instrument.js -- Punjab National Bank statement, format "Date | Instrument ID | Amount(INR) | Type | Balance | Remarks".
   Single file, standalone. Layout (verified on a 13-page PNB statement, 397 transactions, newest first):
     - a transaction starts on a line beginning dd/mm/yyyy; the line carries: [instrument id], amount, type (DR / CR), balance,
       then the first part of the remarks. The type is explicit, so direction is read directly.
     - remarks continue on the lines below, until the next dated line
     - page headers and footers repeat; the abbreviations and conditions block at the end is not a transaction
     - no totals are printed; the opening balance is taken from the oldest row, and the balance chain is checked on every row.
   Registers with the tool: bank id 14 (Punjab National Bank), or the statement text. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  var ROW = /^(\d{2})\/(\d{2})\/(\d{4})\s+(.*)$/;
  var MONEY = /^\d{1,3}(?:,\d{2,3})*\.\d{1,2}$|^\d+\.\d{1,2}$/;
  var STOP = /^(\*\*\*Generated through PNB|Unless constituent|Customers are requested|Abbreviations are as under|Please maintain|Please note Penal|Important)/i;
  var FURNITURE = [
    /^Date\s+Instrument ID/i, /^Page\s+\d+$/i, /^Date:\s*\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}/i, /^Statement of Account/i,
    /^Branch Details/i, /^Branch Name:/i, /^Branch Address:/i, /^City:/i, /^Pin:/i, /^IFSC:/i, /^MICR Code:/i,
    /^Customer Details/i, /^Customer Name:/i, /^Customer Address:/i, /^CKYC Number/i, /^Joint Account Holder/i,
    /^Statement of Account:/i, /^Date\s+Instrument/i, /^This is a computer/i
  ];
  function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function clean(l) { return l.replace(/^l\s+/, '').trim(); }        // bullet points in the notice print as "l "
  function isFurniture(l) { for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].test(l)) return true; return false; }

  function parse(text) {
    var raw = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l !== ''; });
    var rows = [], cur = null, skipped = [];
    function close() { if (cur) { rows.push(cur); cur = null; } }
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      if (STOP.test(clean(line))) { close(); break; }
      var m = line.match(ROW);
      if (m) {
        close();
        var toks = m[4].split(' ').filter(function (t) { return t !== ''; });
        var ti = -1;
        for (var k = 0; k < toks.length; k++) if (/^(DR|CR)$/i.test(toks[k])) { ti = k; break; }
        if (ti < 1 || ti + 1 >= toks.length || !MONEY.test(toks[ti - 1]) || !MONEY.test(toks[ti + 1])) {
          skipped.push({ lines: [line], reason: 'amount, type or balance not found on the dated line' }); continue;
        }
        var instr = ti >= 2 && /^\d+$/.test(toks[ti - 2]) ? toks[ti - 2] : '';
        cur = { date: m[3] + m[2] + m[1], narration: toks.slice(ti + 2).join(' '), refNo: instr,
          amount: num(toks[ti - 1]), drCr: toks[ti].toUpperCase() === 'DR' ? 'D' : 'C', balance: num(toks[ti + 1]) };
        continue;
      }
      if (!cur) continue;                                        // header block before the first row
      if (isFurniture(line)) continue;
      cur.narration += ' ' + line;
    }
    close();

    // oldest row sits last; its balance and type give the opening balance
    var oldest = rows[rows.length - 1];
    var opening = null;
    if (oldest) opening = Math.round((oldest.drCr === 'C' ? oldest.balance - oldest.amount : oldest.balance + oldest.amount) * 100) / 100;

    var chron = rows.slice().reverse(), prev = opening, bad = 0, sumD = 0, sumC = 0;
    var transactions = chron.map(function (r, idx) {
      var conf = 'high';
      if (prev !== null) {
        var mv = Math.round((r.balance - prev) * 100) / 100;
        var ok = ((r.drCr === 'C' && mv > 0) || (r.drCr === 'D' && mv < 0)) && Math.abs(Math.abs(mv) - r.amount) < 0.005;
        if (!ok) { conf = 'low'; bad++; }
      }
      prev = r.balance;
      if (r.drCr === 'D') sumD += r.amount; else sumC += r.amount;
      return { date: r.date, narration: r.narration.replace(/\s+/g, ' ').trim() || '(narration not detected)',
        amount: Math.round(r.amount * 100) / 100, drCr: r.drCr, refNo: r.refNo, balance: r.balance, confidence: conf, reference_no: 'PNB2-' + (idx + 1) };
    });
    transactions.reverse();                                      // keep the statement's own order (newest first)
    sumD = Math.round(sumD * 100) / 100; sumC = Math.round(sumC * 100) / 100;

    var closing = transactions.length ? transactions[0].balance : null;
    var dates = transactions.map(function (t) { return t.date; }).sort();
    return {
      transactions: transactions, skipped: skipped, layout: 'pnb_instrument', directionFromMarker: true,
      statement: {
        opening_balance: opening, closing_balance: closing,
        period_start: dates[0] || null, period_end: dates[dates.length - 1] || null,
        opening_source: opening !== null ? 'derived' : 'none', closing_source: 'derived',
        printed_total_debit: null, printed_total_credit: null, totals_match: null
      },
      repair: { reconstructed: 0, noBalanceEffect: 0, amountFromBalance: 0, markerConflicts: 0, headGap: 0, tailGap: 0, firstDirection: 'marker', notes: bad ? [bad + ' row(s) did not match the balance movement.'] : [] }
    };
  }

  parse.wantsHints = false;
  parse.meta = {
    key: 'pnb_instrument', label: 'Punjab National Bank (Instrument format)', bankIds: ['14'],
    detect: function (t) { return /Statement of Account:\s*\d+\s+For Period/i.test(t) && /Instrument ID\s+Amount\(INR\)\s+Type\s+Balance/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
