/* excel-import.js -- reads a bank statement that the user exported to Excel / CSV (already turned into rows by SheetJS in the browser).
   No bank parser is needed: the column HEADERS say what each column is.
   Input : rows = array of arrays (cells are numbers, strings or Dates-as-serials), as read from the first sheet.
   Output: { transactions:[{date:'YYYYMMDD', narration, amount, drCr:'D'|'C', refNo, balance|null, confidence}], mapping, notes, skipped }

   Columns recognised (any spelling a bank uses):
     date        : "Transaction Date", "Txn Date", "Date", "Value Date" (transaction date is preferred)
     narration   : "Particulars", "Narration", "Description", "Details", "Remarks"
     debit/credit: separate columns "Withdrawal(Dr)", "Debit", "Dr", "Paid out"  /  "Deposit(Cr)", "Credit", "Cr", "Received"
     amount+flag : ONE amount column ("Amount", "Txn Amount") plus a Dr/Cr column ("Dr/Cr", "Type", "D/C") - the flag can also be
                   written inside the amount cell ("1,000.00 Dr")
     balance     : "Balance", "Closing Balance", "Available Balance"
     ref         : "Chq/Ref No", "Cheque No", "UTR", "Reference"                                                                   */
(function (root) {
  'use strict';
  var MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function headerScore(row) {
    var t = row.map(function (c) { return norm(c).toLowerCase(); });
    var has = function (re) { return t.some(function (x) { return re.test(x); }); };
    var s = 0;
    if (has(/date/)) s++;
    if (has(/particular|narration|description|details|remark/)) s++;
    if (has(/withdraw|debit|^dr\b|paid out|amount|deposit|credit|^cr\b|received/)) s++;
    return s;
  }
  function findHeader(rows) {
    var best = -1, bestS = -1;
    for (var i = 0; i < Math.min(rows.length, 60); i++) { var s = headerScore(rows[i] || []); if (s > bestS) { bestS = s; best = i; } }
    return bestS >= 2 ? best : -1;
  }
  function mapColumns(header) {
    var h = header.map(function (c) { return norm(c).toLowerCase(); }), m = {};
    function pick(re, exclude) { for (var i = 0; i < h.length; i++) if (re.test(h[i]) && !(m._taken && m._taken[i]) && !(exclude && exclude.test(h[i]))) return i; return -1; }
    m._taken = {};
    function take(key, i) { if (i >= 0) { m[key] = i; m._taken[i] = 1; } }
    take('date', pick(/^transaction\s*date|^txn\s*date|^tran\s*date|^posting\s*date/)); if (m.date === undefined) take('date', pick(/date/, /value/)); if (m.date === undefined) take('date', pick(/date/));
    take('narration', pick(/particular|narration|description|details|remark/));
    take('ref', pick(/chq|cheque|ref|utr|instrument/));
    take('debit', pick(/withdraw|debit|^dr\b|paid out/, /dr\/cr|cr\/dr/));
    take('credit', pick(/deposit|credit|^cr\b|received/, /dr\/cr|cr\/dr/));
    take('balance', pick(/balance/));
    take('amount', pick(/^amount|txn amount|transaction amount/));
    take('flag', pick(/dr\/cr|cr\/dr|^type$|^d\/c$|^dc$/));
    delete m._taken; return m;
  }

  function toYmd(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && v > 20000 && v < 80000) {                     // Excel serial date
      var d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return d.getUTCFullYear() + ('0' + (d.getUTCMonth() + 1)).slice(-2) + ('0' + d.getUTCDate()).slice(-2);
    }
    var s = norm(v), m;
    if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) return m[1] + ('0' + m[2]).slice(-2) + ('0' + m[3]).slice(-2);
    if ((m = s.match(/^(\d{1,2})[-\/. ]([A-Za-z]{3})[a-z]*[-\/., ]+(\d{2,4})/))) { var y = m[3].length === 2 ? '20' + m[3] : m[3]; return y + MON[m[2].toLowerCase()] + ('0' + m[1]).slice(-2); }
    if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/))) { var yy = m[3].length === 2 ? '20' + m[3] : m[3]; return yy + ('0' + m[2]).slice(-2) + ('0' + m[1]).slice(-2); }
    return null;
  }
  function toNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = norm(v); if (s === '' || s === '-') return null;
    var neg = /^\(.*\)$/.test(s) || /-\s*\d/.test(s.replace(/,/g, '')) && /^-/.test(s.replace(/[₹\s]/g, '')), n = parseFloat(s.replace(/[₹,\s()]|Cr|Dr|CR|DR/g, ''));
    if (!isFinite(n)) return null;
    return neg ? -Math.abs(n) : n;
  }
  function flagOf(v) {
    var s = norm(v).toLowerCase();
    if (/^(dr|debit|d|withdrawal|w|paid out|debit\(dr\))\b|\bdr$|\(dr\)|\bdebit\b/.test(s) && !/cr/.test(s)) return 'D';
    if (/^(cr|credit|c|deposit|received)\b|\bcr$|\(cr\)|\bcredit\b/.test(s)) return 'C';
    return null;
  }

  function parseRows(rows) {
    var notes = [], skipped = [];
    var hi = findHeader(rows);
    if (hi < 0) return { transactions: [], mapping: null, notes: ['Could not find a header row with Date, Particulars and Amount/Withdrawal/Deposit columns.'], skipped: [] };
    var m = mapColumns(rows[hi]);
    if (m.date === undefined) return { transactions: [], mapping: m, notes: ['No date column found in the header row.'], skipped: [] };
    var mapping = {};
    Object.keys(m).forEach(function (k) { mapping[k] = norm(rows[hi][m[k]]); });
    var hasSplit = m.debit !== undefined || m.credit !== undefined;
    var hasSingle = m.amount !== undefined;
    if (!hasSplit && !hasSingle) return { transactions: [], mapping: mapping, notes: ['No amount columns found (need Withdrawal/Deposit, Debit/Credit or Amount).'], skipped: [] };
    var out = [];
    for (var r = hi + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var date = toYmd(row[m.date]);
      if (!date) { if (norm(row.join('')) !== '') skipped.push({ row: r + 1, reason: 'no date' }); continue; }
      var narr = m.narration !== undefined ? norm(row[m.narration]) : '';
      var dr = null, cr = null, drCr = null, amount = null, conf = 'high';
      if (hasSplit) {
        dr = m.debit !== undefined ? toNum(row[m.debit]) : null;
        cr = m.credit !== undefined ? toNum(row[m.credit]) : null;
        if (dr && Math.abs(dr) > 0) { amount = Math.abs(dr); drCr = 'D'; }
        if (cr && Math.abs(cr) > 0) { if (amount !== null) { conf = 'low'; } amount = Math.abs(cr); drCr = 'C'; }
      }
      if (amount === null && hasSingle) {
        var raw = row[m.amount], n = toNum(raw);
        if (n !== null) {
          amount = Math.abs(n);
          var f = m.flag !== undefined ? flagOf(row[m.flag]) : null;
          if (!f) f = flagOf(raw);
          if (f) drCr = f; else if (n < 0) drCr = 'D';
          if (!drCr) conf = 'low';
        }
      }
      if (amount === null || amount === 0) { skipped.push({ row: r + 1, reason: 'no amount' }); continue; }
      if (!drCr) { skipped.push({ row: r + 1, reason: 'Dr/Cr unknown' }); continue; }
      var bal = m.balance !== undefined ? toNum(row[m.balance]) : null;
      out.push({ date: date, narration: narr || '(narration not detected)', amount: Math.round(amount * 100) / 100, drCr: drCr,
        refNo: m.ref !== undefined ? norm(row[m.ref]) : '', balance: bal, confidence: conf, source_row: r + 1 });
    }
    if (out.length && out.every(function (t) { return t.balance !== null; })) {
      // the balance column lets the balance chain confirm (or correct) each direction
      var ok = 0;
      for (var i = 1; i < out.length; i++) {
        var d = Math.round((out[i].balance - out[i - 1].balance) * 100) / 100;
        if (Math.abs(Math.abs(d) - out[i].amount) < 0.005) { ok++; var dir = d > 0 ? 'C' : 'D'; if (dir !== out[i].drCr) { out[i].drCr = dir; out[i].direction_from_balance = true; } }
      }
      notes.push('Balance column present: every row checked against its balance change.');
    } else if (hasSingle && !hasSplit) {
      notes.push('Direction came from the Dr/Cr column or a Dr/Cr marker. Without a balance column it cannot be cross-checked.');
    }
    if (out.length) notes.push(out.length + ' transactions read from row ' + (hi + 2) + ' onwards.');
    return { transactions: out, mapping: mapping, notes: notes, skipped: skipped, header_row: hi + 1 };
  }
  var ExcelImport = { parseRows: parseRows, toYmd: toYmd, toNum: toNum, findHeader: findHeader, mapColumns: mapColumns };
  if (typeof module !== 'undefined' && module.exports) module.exports = ExcelImport; else root.ExcelImport = ExcelImport;
})(typeof window !== 'undefined' ? window : this);
