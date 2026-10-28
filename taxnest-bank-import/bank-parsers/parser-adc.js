/* parser-adc.js -- The Ahmedabad District Co-op Bank Ltd (ADC) statement parser. Single file, standalone.
   Layout it relies on (verified on an ADC "Statement of Account" PDF, 11 pages, 218 transactions):
     - a transaction starts on a line:  Post Date  Value Date  Narration ...  Cheque  <amount>  <balance>
       dates are dd-mm-yyyy; the balance ends with "Cr" or "Dr"; the amount has no suffix and sits in Debit or Credit
     - narration continues on the lines below until the next transaction
     - each page prints a header and footer block (bank name, account no, "Page x of 11") that is not narration
     - the last page prints: Open Bal | Dr count | Cr count | Debits | Credits | Clo Bal. The opening balance itself is
       not printed, so it is derived: opening = closing - credits + debits. The running balance then decides Dr/Cr for every row.
   Registers itself with the tool: bank id 75 (The Ahmedabad District Co-op Bank Ltd) or the statement text. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('../bank-parser-core.js') : root.BankParserCore;

  var ROW = /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2})-(\d{2})-(\d{4})\s+(.*)$/;
  var MONEY = /^\d{1,3}(?:,\d{3})*\.\d{2}$|^\d+\.\d{2}$/;
  var BAL = /^(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})(Cr|Dr)$/i;
  var FURNITURE = [
    /^Page \d+ of \d+$/i, /MAHALAXMI ANAJ BHANDAR/i, /^Account No\.\s*:/i, /^Statement of Account/i,
    /^Post Date\s+Value Date/i, /^Details\s*$/i, /computer-generated document/i
  ];
  function isFurniture(line) { for (var i = 0; i < FURNITURE.length; i++) if (FURNITURE[i].test(line)) return true; return false; }
  function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function ymd(d, m, y) { return y + m + d; }
  function signedBal(s) { var m = s.match(BAL); return m ? (m[2].toLowerCase() === 'dr' ? -1 : 1) * num(m[1]) : null; }

  function summary(lines) {
    // "Open Bal  Dr count  Cr count  Debits  Credits  Clo Bal" followed by the values line
    for (var i = 0; i < lines.length; i++) {
      if (/^Open Bal/i.test(lines[i])) {
        for (var j = i + 1; j < Math.min(lines.length, i + 3); j++) {
          var t = lines[j].split(' ').filter(function (x) { return x !== ''; });
          if (t.length >= 5 && /^\d+$/.test(t[0]) && /^\d+$/.test(t[1]) && BAL.test(t[4])) {
            return { dr: +t[0], cr: +t[1], debit: num(t[2]), credit: num(t[3]), closing: signedBal(t[4]) };
          }
        }
        return null;
      }
    }
    return null;
  }

  function parse(text) {
    var raw = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); });
    var sum = summary(raw);
    var end = raw.length;
    for (var s = 0; s < raw.length; s++) if (/^Open Bal/i.test(raw[s])) { end = s; break; }

    var rows = [], cur = null, skipped = [];
    function close() { if (cur) { rows.push(cur); cur = null; } }
    for (var i = 0; i < end; i++) {
      var line = raw[i];
      if (!line) continue;
      var m = line.match(ROW);
      if (m) {
        close();
        var toks = m[7].split(' ').filter(function (t) { return t !== ''; });
        var bIdx = -1, aIdx = -1;
        for (var k = toks.length - 1; k >= 0; k--) {
          if (bIdx < 0 && BAL.test(toks[k])) { bIdx = k; continue; }
          if (bIdx >= 0 && MONEY.test(toks[k])) { aIdx = k; break; }
        }
        if (bIdx < 0 || aIdx < 0) { skipped.push({ lines: [line], reason: 'amount or balance not found on the transaction line' }); continue; }
        var nar = toks.slice(0, aIdx);
        var cheque = '';
        if (nar.length && (nar[nar.length - 1] === '-' || /^\d{4,}$/.test(nar[nar.length - 1]))) cheque = nar.pop();
        cur = {
          date: ymd(m[1], m[2], m[3]), valueDate: ymd(m[4], m[5], m[6]),
          narration: nar.join(' '), refNo: cheque === '-' ? '' : cheque,
          amount: num(toks[aIdx]), balance: signedBal(toks[bIdx]), lines: 1
        };
        continue;
      }
      if (!cur) continue;                       // page-1 bank and account block before the first row
      if (isFurniture(line)) continue;
      cur.narration += ' ' + line; cur.lines++;
    }
    close();

    var opening = sum ? Math.round((sum.closing - sum.credit + sum.debit) * 100) / 100 : null;   // derived: the statement does not print it
    var prev = opening, transactions = [], dr = 0, cr = 0;
    rows.forEach(function (r, idx) {
      var conf = 'high', drCr = 'D';
      if (prev !== null) {
        var d = Math.round((r.balance - prev) * 100) / 100;
        if (Math.abs(Math.abs(d) - r.amount) < 0.005) drCr = d > 0 ? 'C' : 'D';
        else { conf = 'low'; drCr = d > 0 ? 'C' : 'D'; }
      } else conf = 'low';
      prev = r.balance;
      var narration = r.narration.replace(/\s+/g, ' ').replace(/^[-\s]+|[-\s]+$/g, '').trim();
      transactions.push({ date: r.date, narration: narration || '(narration not detected)', amount: Math.round(r.amount * 100) / 100,
        drCr: drCr, refNo: r.refNo, balance: Math.round(r.balance * 100) / 100, confidence: conf, reference_no: 'ADC-' + (idx + 1) });
      if (drCr === 'C') cr += r.amount; else dr += r.amount;
    });

    var dates = transactions.map(function (t) { return t.date; }).sort();
    var statement = {
      opening_balance: opening, closing_balance: sum ? sum.closing : null,
      period_start: dates[0] || null, period_end: dates[dates.length - 1] || null,
      opening_source: opening !== null ? 'derived' : 'none', closing_source: sum ? 'statement' : 'none',
      printed_total_debit: sum ? sum.debit : null, printed_total_credit: sum ? sum.credit : null,
      totals_match: sum ? (Math.abs(Math.round(dr * 100) / 100 - sum.debit) < 0.05 && Math.abs(Math.round(cr * 100) / 100 - sum.credit) < 0.05 && transactions.length === sum.dr + sum.cr) : null
    };
    return {
      transactions: transactions, skipped: skipped, statement: statement, layout: 'adc', directionFromMarker: false,
      repair: { reconstructed: 0, noBalanceEffect: 0, amountFromBalance: 0, markerConflicts: 0, headGap: 0, tailGap: 0, firstDirection: null,
        notes: sum ? [] : ['The closing totals were not found; the opening balance could not be derived.'] }
    };
  }

  parse.wantsHints = false;
  parse.meta = {
    key: 'adc', label: 'Ahmedabad District Co-op Bank', bankIds: ['75'],
    detect: function (t) { return /Ahmedabad District Co-op Bank/i.test(t) && /Statement of Account/i.test(t) && /GSCB0ADC/i.test(t); }
  };
  Core.registerParser(parse.meta.key, parse, parse.meta);
  if (typeof module !== 'undefined' && module.exports) module.exports = parse;
})(typeof window !== 'undefined' ? window : this);
