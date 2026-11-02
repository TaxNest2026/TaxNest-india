/* parser-kotak-mahindra-crdr.js -- Kotak Mahindra Bank statement, format "Date | Narration | Chq/Ref No | Withdrawal(Dr) / Deposit(Cr) | Balance"
   with explicit markers: every amount and balance ends with "(Cr)" or "(Dr)".
   Single file, standalone. Layout (verified on a 13-page Kotak statement, Apr-Oct 2025, 315 transactions):
     - a transaction starts on a line: dd-mm-yyyy, the narration, then the amount with its marker and the balance with its marker
     - the amount marker is the direction: (Dr) = withdrawal, (Cr) = deposit. The balance marker gives the sign of the balance
     - the narration wraps onto the lines below (e.g. "/KKBK/X2336/IMPS", "UBIN0558184") until the next dated line
     - the statement prints Opening Balance, Total Withdrawal, Total Deposit and Closing Balance, all with markers: used as checks.
   Registers with the tool: bank id 11 (Kotak Mahindra Bank Ltd), or the statement text.
   The other Kotak format (serial numbers, Withdrawal (Dr.) / Deposit (Cr.) columns) is parser-kotak-mahindra.js. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  var ROW = /^(\d{2})-(\d{2})-(\d{4})\s+(.*)$/;
  var MARKED = /^(-?[\d,]+\.\d{2})\((Cr|Dr)\)$/i;
  var FURNITURE = [
    /^Page \d+ of \d+/i, /^Date\s+Narration\s+Chq\/Ref No/i, /^Withdrawal\(Dr\)\//i, /^Deposit\(Cr\)/i, /^Statement Summary/i,
    /^Any discrepancy/i, /^End of Statement/i, /^This is system generated/i, /^Opening Balance\s*:/i, /^Total (Withdrawal|Deposit) Amount\s*:/i,
    /^Closing Balance\s*:/i, /^Withdrawal Count\s*:/i, /^Deposit Count\s*:/i, /^Account Statement/i, /^Period\s*:/i, /^Currency\s*:/i,
    /^Nominee Registered/i, /^Branch\s*:/i, /^Branch Address/i, /^Branch Phone No/i, /^MICR Code/i, /^IFSC Code/i, /^Cust Reln No/i,
    /^Account No\s*:/i, /^KOTAK MAHINDRA BANK/i, /^GUJARAT,?INDIA/i
  ];
  function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function signed(s, marker) { var v = num(s); return marker.toUpperCase() === 'DR' ? -Math.abs(v) : Math.abs(v); }
  function isFurniture(l) { for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].test(l)) return true; return false; }

  function parse(text) {
    var raw = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l !== ''; });
    var opening = null, tW = null, tD = null, closing = null;
    raw.forEach(function (l) {
      var o = l.match(/^Opening Balance\s*:\s*(-?[\d,]+\.\d{2})\((Cr|Dr)\)/i); if (o && opening === null) opening = signed(o[1], o[2]);
      var c = l.match(/^Closing Balance\s*:\s*(-?[\d,]+\.\d{2})\((Cr|Dr)\)/i); if (c && closing === null) closing = signed(c[1], c[2]);
      var w = l.match(/^Total Withdrawal Amount\s*:\s*([\d,]+\.\d{2})/i); if (w && tW === null) tW = num(w[1]);
      var d = l.match(/^Total Deposit Amount\s*:\s*([\d,]+\.\d{2})/i); if (d && tD === null) tD = num(d[1]);
    });

    var rows = [], cur = null, skipped = [];
    function close() { if (cur) { rows.push(cur); cur = null; } }
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      if (/^Statement Summary/i.test(line)) { close(); break; }
      var m = line.match(ROW);
      if (m) {
        close();
        var toks = m[4].split(' ').filter(function (t) { return t !== ''; });
        var n = toks.length;
        var balTok = n >= 1 ? toks[n - 1] : '', amtTok = n >= 2 ? toks[n - 2] : '';
        var b = balTok.match(MARKED), a = amtTok.match(MARKED);
        if (!b || !a) { skipped.push({ lines: [line], reason: 'amount or balance without its Cr/Dr marker' }); continue; }
        var desc = toks.slice(0, n - 2), ref = '';
        if (desc.length && /^[A-Z]{0,8}-?\d{6,}$|^\d{4,}$/.test(desc[desc.length - 1])) ref = desc.pop();
        cur = { date: m[3] + m[2] + m[1], narration: desc.join(' '), refNo: ref,
          amount: Math.abs(num(a[1])), drCr: a[2].toUpperCase() === 'DR' ? 'D' : 'C', balance: signed(b[1], b[2]) };
        continue;
      }
      if (!cur) continue;                                     // statement header before the first row
      if (isFurniture(line)) continue;
      cur.narration += ' ' + line;
    }
    close();

    var prev = opening, transactions = [], sumD = 0, sumC = 0, bad = 0;
    rows.forEach(function (r, idx) {
      var conf = 'high';
      if (prev !== null) {
        var mv = Math.round((r.balance - prev) * 100) / 100;
        var ok = (r.drCr === 'C' && mv > 0 || r.drCr === 'D' && mv < 0) && Math.abs(Math.abs(mv) - r.amount) < 0.005;
        if (!ok) { conf = 'low'; bad++; }
      }
      prev = r.balance;
      if (r.drCr === 'D') sumD += r.amount; else sumC += r.amount;
      transactions.push({ date: r.date, narration: r.narration.replace(/\s+/g, ' ').trim() || '(narration not detected)',
        amount: Math.round(r.amount * 100) / 100, drCr: r.drCr, refNo: r.refNo, balance: r.balance, confidence: conf, reference_no: 'KOTAK-' + (idx + 1) });
    });
    sumD = Math.round(sumD * 100) / 100; sumC = Math.round(sumC * 100) / 100;

    var dates = transactions.map(function (t) { return t.date; }).sort();
    return {
      transactions: transactions, skipped: skipped, layout: 'kotak_crdr', directionFromMarker: true,
      statement: {
        opening_balance: opening, closing_balance: closing,
        period_start: dates[0] || null, period_end: dates[dates.length - 1] || null,
        opening_source: opening !== null ? 'statement' : 'none', closing_source: closing !== null ? 'statement' : 'none',
        printed_total_debit: tW, printed_total_credit: tD,
        totals_match: tW !== null && tD !== null ? (Math.abs(sumD - tW) < 0.05 && Math.abs(sumC - tD) < 0.05) : null
      },
      repair: { reconstructed: 0, noBalanceEffect: 0, amountFromBalance: 0, markerConflicts: bad, headGap: 0, tailGap: 0, firstDirection: 'marker',
        notes: bad ? [bad + ' row(s) did not agree with the balance movement.'] : [] }
    };
  }

  parse.wantsHints = false;
  parse.meta = {
    key: 'kotak_crdr', label: 'Kotak Mahindra Bank (Cr/Dr marker format)', bankIds: ['11'],
    detect: function (t) { return /Withdrawal Count\s*:/i.test(t) && /Deposit Count\s*:/i.test(t) && /\((Cr|Dr)\)/.test(t) && /KKBK0\d{6}|Kotak Mahindra/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
