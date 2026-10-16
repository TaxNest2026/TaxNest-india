/* pdf-lines.js -- turns pdf.js text items into text lines (shared by the browser and by tests).

   groupItemsIntoLines(items, state) -> { plain, hinted }
     plain  : exactly what the parsers have always received.
     hinted : the same text, but every amount that sits under a "Withdrawal/Debit" or "Deposit/Credit" column header
              is followed by "(Dr)" or "(Cr)". The universal parser uses these as an INDEPENDENT second opinion on
              direction (the balance chain remains the final judge). Column headers are remembered across pages,
              because many banks print them on the first page only.
   Items follow pdf.js's shape: { str, width, height, transform: [a,b,c,d,x,y] }. */
(function (root) {
  'use strict';
  var DEBIT_H = /^(withdrawals?|withdrawl|withdrawn|debits?|dr\.?)$/i, CREDIT_H = /^(deposits?|credits?|cr\.?)$/i, BAL_H = /^(balance|bal\.?|closing|available)$/i;
  var AMOUNT = /^-?[\d,]*\d\.\d{2}$/;

  function cx(it) { return it.transform[4] + (it.width || 0) / 2; }
  function clean(s) { return String(s).replace(/[^A-Za-z.]/g, ''); }

  function findColumns(items) {
    var d = [], c = [], b = [];
    items.forEach(function (it) {
      var t = clean(it.str); if (!t) return;
      if (DEBIT_H.test(t)) d.push(it); else if (CREDIT_H.test(t)) c.push(it); else if (BAL_H.test(t)) b.push(it);
    });
    var best = null;
    d.forEach(function (di) {
      c.forEach(function (ci) {
        var dy = Math.abs(di.transform[5] - ci.transform[5]), dx = Math.abs(cx(di) - cx(ci));
        if (dy <= 16 && dx >= 40) {                    // same header band, clearly separate columns ("Dr / Cr" glued together is not)
          var bal = b.filter(function (x) { return Math.abs(x.transform[5] - di.transform[5]) <= 16; }).sort(function (p, q) { return Math.abs(cx(p) - Math.max(cx(di), cx(ci))) - Math.abs(cx(q) - Math.max(cx(di), cx(ci))); })[0];
          if (!best || dx < best.dx) best = { dx: dx, debit: cx(di), credit: cx(ci), balance: bal ? cx(bal) : null, y: Math.min(di.transform[5], ci.transform[5]) };
        }
      });
    });
    return best;
  }

  function sortGroup(items) {
    var sorted = items.slice().sort(function (a, b) { return b.transform[5] - a.transform[5]; });
    var groups = [], cur = null;
    sorted.forEach(function (it) {
      var y = it.transform[5], tol = Math.max(2, (it.height || 10) * 0.5);
      if (cur && Math.abs(y - cur.y) <= tol) cur.items.push(it); else { cur = { y: y, items: [it] }; groups.push(cur); }
    });
    return groups.map(function (g) { return g.items.slice().sort(function (a, b) { return a.transform[4] - b.transform[4]; }); });
  }

  var DATE_START = /^\s*(?:\d{1,5}\s+)?(?:[A-Z]\d{4,}\s+)?\d{1,2}[-\/. ](?:\d{1,2}|[A-Za-z]{3,9})[-\/. ,]/;
  /* Banks that centre the date vertically inside a tall wrapped cell (Canara): the lines ABOVE the date belong to that row, but plain
     top-to-bottom reading glues them to the previous row. With opts.centered, every line that is not a dated line is assigned to the
     NEAREST dated line by distance, and lines that belong to the next row are moved to just after its dated line. */
  function reassignCentered(lines) {              // lines: [{y, text, hint}]
    var dated = []; lines.forEach(function (l, i) { if (DATE_START.test(l.text)) dated.push(i); });
    if (dated.length < 2) return lines;
    var buckets = dated.map(function () { return []; }), pre = [];
    lines.forEach(function (l, i) {
      if (DATE_START.test(l.text)) return;
      var prev = -1, next = -1;
      for (var k = 0; k < dated.length; k++) { if (dated[k] < i) prev = k; else { next = k; break; } }
      var target;
      if (prev < 0) target = next; else if (next < 0) target = prev;
      else target = Math.abs(lines[dated[prev]].y - l.y) <= Math.abs(lines[dated[next]].y - l.y) ? prev : next;
      if (target < 0) { pre.push(l); return; } buckets[target].push(l);
    });
    var out = pre.slice();
    dated.forEach(function (di, k) { out.push(lines[di]); buckets[k].forEach(function (l) { out.push(l); }); });
    return out;
  }

  function groupItemsIntoLines(items, state, opts) {
    state = state || {}; opts = opts || {};
    if (!items.length) return { plain: '', hinted: '' };
    var cols = findColumns(items); if (cols) state.cols = cols; else cols = state.cols || null;
    var plain = [], hinted = [], rows = [];
    sortGroup(items).forEach(function (line) {
      var ptxt = line.map(function (i) { return i.str; }).join(' ');
      var htxt = line.map(function (i) {
        if (!cols || !AMOUNT.test(String(i.str).trim())) return i.str;
        if (cols.firstPageHeaderY !== undefined && false) return i.str;
        var x = cx(i), dd = Math.abs(x - cols.debit), dc = Math.abs(x - cols.credit), db = cols.balance === null ? 1e9 : Math.abs(x - cols.balance);
        var best = Math.min(dd, dc, db); if (best > 75) return i.str;
        if (best === db) return i.str;                 // balance column: no hint
        return i.str + (best === dd ? '(Dr)' : '(Cr)');
      }).join(' ');
      rows.push({ y: line[0].transform[5], text: ptxt, hint: htxt });
    });
    if (opts.centered) rows = reassignCentered(rows);
    rows.forEach(function (r) { plain.push(r.text); hinted.push(r.hint); });
    return { plain: plain.join('\n'), hinted: hinted.join('\n') };
  }

  var PdfLines = { groupItemsIntoLines: groupItemsIntoLines, findColumns: findColumns };
  if (typeof module !== 'undefined' && module.exports) module.exports = PdfLines; else root.PdfLines = PdfLines;
})(typeof window !== 'undefined' ? window : this);
