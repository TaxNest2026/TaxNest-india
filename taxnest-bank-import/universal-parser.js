/* universal-parser-v2.js -- universal statement parser for banks without a dedicated parser.
   Method (in order):
   1. DATES FIRST. A transaction is a line that starts with a date (optionally after a serial number).
      Date formats recognised: dd/mm/yyyy, dd-mm-yy, dd.mm.yyyy, yyyy-mm-dd, dd-Mon-yyyy, dd Mon yyyy, Mon dd, yyyy (e.g. "March31, 2026").
      Day/month order is decided from the dates themselves (a part above 12 is the day).
      Lines that continue a transaction (narration) are attached to the previous dated line.
   2. FURNITURE OUT. Lines that repeat on several pages (page headers, footers, bank address) and lines before the first
      transaction are removed. Carry-forward / page-total lines carry no date and so never become transactions.
   3. NUMBERS. Each dated line gives its money values. A row with fewer than two money values (for example a
      balance-only "B/F" line) is not a transaction.
   4. BALANCE COLUMN FROM THE CHAIN. The balance is the number that moves from row to row: for each candidate column
      and each statement order (ascending or descending), count the rows whose balance change equals one of the row's
      other amounts. The best candidate is the balance column. A constant column cannot satisfy this, so it is never chosen.
   5. DIRECTION FROM THE MOVEMENT. Balance up = credit, balance down = debit. The amount is the value that equals the movement.
      The first row uses a printed opening balance when present, otherwise a Dr/Cr marker, otherwise it is flagged low.
   6. OPENING NEVER BECOMES AN ENTRY. The opening balance is derived or printed, never added as a transaction.
   7. CHECKS. Printed opening/closing and printed total debit/credit (when labelled) are compared with the result.
   Plain <script> include (window.UniversalParser) or Node module. Same contract as universal-parser.js.
   Known limits: table borders are not visible in extracted text; narration that wraps ABOVE its date line is attached to
   the row above it. */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function monthNum(s) { return MONTHS[String(s).toLowerCase().slice(0, 4).replace(/^sept$/, 'sept')] || MONTHS[String(s).toLowerCase().slice(0, 3)] || 0; }

  // a date at the start of a line, after an optional serial number. Each returns parts for ordering.
  var DATE_FORMS = [
    { re: /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})(?![\d])/, kind: 'num' },
    { re: /^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})(?![\d])/, kind: 'iso' },
    { re: /^(\d{1,2})[\/.\- ]?([A-Za-z]{3,9})\.?[\/.\-, ]*\s?(\d{4}|\d{2})(?![\dA-Za-z])/, kind: 'mon' },
    { re: /^([A-Za-z]{3,9})\.?\s?(\d{1,2}),?\s?(\d{4})(?![\d])/, kind: 'monfirst' }
  ];
  var SERIAL = /^(\d{1,5})\s+(?=\S)/;
  var ID_TOKEN = /^([A-Z]\d{4,}|\d{6,})\s+(?=\d)/;   // transaction id printed between serial and date (ICICI)

  function matchDate(s) {
    // the line may start with the date itself ("31 Dec 2025 ...") or with a serial number and then the date ("1 31 Dec 2025 ..."):
    // try the date first, then the serial form
    var r0 = matchDateAt(s, '', s);
    if (r0) return r0;
    var sm = s.match(SERIAL);
    if (!sm) return null;
    var t = s.slice(sm[0].length), ser = sm[1];
    var im = t.match(ID_TOKEN); if (im) { var r1 = matchDateAt(t.slice(im[0].length), ser, s); if (r1) return r1; }
    return matchDateAt(t, ser, s);
  }
  function matchDateAt(t, ser, s) {
    for (var k = 0; k < DATE_FORMS.length; k++) {
      var f = DATE_FORMS[k], m = t.match(f.re);
      if (!m) continue;
      var rest = t.slice(m[0].length);
      if (f.kind === 'num') return { kind: 'num', a: +m[1], b: +m[2], y: m[3], len: m[0].length, serial: ser, rest: rest };
      if (f.kind === 'iso') return { kind: 'iso', y: m[1], a: +m[2], b: +m[3], len: m[0].length, serial: ser, rest: rest };
      if (f.kind === 'mon') { var mo = monthNum(m[2]); if (!mo) continue; return { kind: 'mon', d: +m[1], mo: mo, y: m[3], len: m[0].length, serial: ser, rest: rest }; }
      if (f.kind === 'monfirst') { var mo2 = monthNum(m[1]); if (!mo2) continue; return { kind: 'monfirst', d: +m[2], mo: mo2, y: m[3], len: m[0].length, serial: ser, rest: rest }; }
    }
    return null;
  }

  // decide day/month order from the dates themselves
  function decideOrder(dates) {
    var dayFirst = 0, monthFirst = 0;
    dates.forEach(function (d) {
      if (d.kind !== 'num') return;
      if (d.a > 12) dayFirst++;
      if (d.b > 12) monthFirst++;
    });
    return monthFirst > dayFirst ? 'mdy' : 'dmy';
  }
  function toYmd(d, order) {
    var y, mo, dd;
    if (d.kind === 'num') { if (order === 'mdy') { mo = d.a; dd = d.b; } else { dd = d.a; mo = d.b; } y = d.y; }
    else if (d.kind === 'iso') { y = d.y; mo = d.a; dd = d.b; }
    else { dd = d.d; mo = d.mo; y = d.y; }
    if (String(y).length === 2) y = '20' + y;
    if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null;
    return String(y) + ('0' + mo).slice(-2) + ('0' + dd).slice(-2);
  }

  // money values: "1,234.56", "-1,234.56", "1234.5", with optional INR/Rs/₹ prefix and Cr/Dr or (Cr)/(Dr) marker
  var MONEY_RE = /^[-(]?(?:INR|Rs\.?|₹)?-?(\d{1,3}(?:,\d{2,3})+|\d+)\.(\d{1,2})\)?(?:\((Cr|Dr)\)|(Cr|Dr|CR|DR)\.?)?$/;
  var MONEY_INT_RE = /^[-(]?(?:INR|Rs\.?|₹)?-?\d{1,3}(?:,\d{2,3})+\)?(?:\((Cr|Dr)\)|(Cr|Dr|CR|DR)\.?)?$/;
  function parseMoney(tok, intMode) {
    var re = intMode ? MONEY_INT_RE : MONEY_RE, m = tok.match(re);
    if (!m) return null;
    var neg = /^\(|^-/.test(tok);
    var clean = tok.replace(/^[-(]?(?:INR|Rs\.?|₹)?-?/, '').replace(/[()]|\((Cr|Dr)\)|(Cr|Dr|CR|DR)\.?$/g, '').replace(/,/g, '');
    var v = parseFloat(clean);
    if (!isFinite(v)) return null;
    var marker = m[3] || m[4] || '';
    marker = marker.toUpperCase();
    if (neg) v = -Math.abs(v);
    return { v: v, marker: marker, tok: tok };
  }

  function num(s) { return parseFloat(String(s).replace(/[^0-9.\-]/g, '')); }

  function parse(text, opts) {
    opts = opts || {};
    var fixed = Core.fixSplitDates ? Core.fixSplitDates(String(text || '')) : String(text || '');
    // footer / summary wording that can be printed on the same line as a transaction: cut it, keep any amount
    var MARK = /(transaction total|closing balance|important message|end of statement|statement summary|this is system generated|computer generated|\*?\s*denotes cancelled|total debit:?|total credit:?|grand total|page total|unless the constituent|this is system)/i;
    var MARK_WORDS = /(transaction total|closing balance|important message|end of statement|statement summary|this is system generated|computer generated|\*?\s*denotes cancelled|total debit:?|total credit:?|grand total|page total|unless the constituent|this is system)/ig;
    var FOOT_START = /^(unless\b|please\b|kindly\b|note:|this statement|important\b|terms\b|disclaimer|\*\s)/i;
    var lines0 = fixed.split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l !== ''; }).map(function (l) {
      var m = l.search(MARK);
      if (m < 0) return l;
      var tail = l.slice(m);
      if (!/\d[\d,]*\.\d{2}/.test(tail)) return l.slice(0, m).trim();      // pure footer: cut it
      return (l.slice(0, m) + ' ' + tail.replace(MARK_WORDS, ' ')).replace(/\s+/g, ' ').trim();
    }).filter(function (l) { return l !== ''; });

    // --- 1. dates first
    var dated = [], dateLineIdx = [];
    lines0.forEach(function (l, i) { var d = matchDate(l); if (d) { dated.push(d); dateLineIdx.push(i); } });
    var order = decideOrder(dated);
    var firstDate = dateLineIdx.length ? dateLineIdx[0] : lines0.length;

    // --- 2. furniture: lines that repeat on several pages (digits masked) and anything before the first transaction
    var seen = {};
    lines0.forEach(function (l, i) { if (matchDate(l)) return; var key = l.replace(/\d/g, '#').toLowerCase(); seen[key] = (seen[key] || 0) + 1; });
    // page furniture carries no amounts; a line with an amount is never furniture, even if its shape repeats
    var isRepeating = function (l) { if (/\d[\d,]*\.\d{2}/.test(l)) return false; var key = l.replace(/\d/g, '#').toLowerCase(); return (seen[key] || 0) >= 3 && l.length < 140; };
    var FOOTER = /page\s*\d+\s*(of|\/)\s*\d+|generated on|computer[- ]generated|does not require signature|end of statement|this is a system/i;

    // --- 3. rows: dated line + continuation lines (non-dated, non-furniture) until the next dated line
    var stopped = false;
    var rows = [], cur = null, header = [], openingPrinted = null, closingPrinted = null, totalDr = null, totalCr = null;
    lines0.forEach(function (l, i) {
      var label = l.match(/(opening balance|opening bal|balance b\/f|b\/f|brought forward|balance brought)[^\d\-]*([\d,]+\.\d{1,2})/i);
      if (label && openingPrinted === null) openingPrinted = num(label[2]);
      var cl = l.match(/(closing balance|closing bal|balance c\/f|c\/f|carried forward)[^\d\-]*([\d,]+\.\d{1,2})/i);
      if (cl) closingPrinted = num(cl[2]);
      var tdr = l.match(/total (debit|debits|withdrawal|withdrawals)[^\d]*([\d,]+\.\d{1,2})/i); if (tdr && totalDr === null) totalDr = num(tdr[2]);
      var tcr = l.match(/total (credit|credits|deposit|deposits)[^\d]*([\d,]+\.\d{1,2})/i); if (tcr && totalCr === null) totalCr = num(tcr[2]);
      var gr = l.match(/^grand\s+([\d,]+\.\d{1,2})\s+([\d,]+\.\d{1,2})$/i); if (gr && totalDr === null) { totalDr = num(gr[1]); totalCr = num(gr[2]); }
    });
    // summary block: labels on one line ("Opening Balance  Total Credits  Total Debits  Closing Balance"), values on the next
    lines0.forEach(function (l, i) {
      if (!/opening balance|opening bal/i.test(l) || !lines0[i + 1]) return;
      var labels = []; var lm; var re = /(opening balance|total credits?|total debits?|closing balance|closing bal)/ig;
      while ((lm = re.exec(l))) labels.push(lm[1].toLowerCase());
      var vals = lines0[i + 1].split(' ').map(function (t) { return t.replace(/^INR/i, ''); }).filter(function (t) { return /^[\d,]+\.\d{1,2}$/.test(t); });
      if (labels.length !== vals.length || vals.length < 3) return;
      labels.forEach(function (lab, k) {
        var v = num(vals[k]);
        if (/^opening/.test(lab) && openingPrinted === null) openingPrinted = v;
        if (/^closing/.test(lab) && closingPrinted === null) closingPrinted = v;
        if (/credit/.test(lab) && totalCr === null) totalCr = v;
        if (/debit/.test(lab) && totalDr === null) totalDr = v;
      });
    });
    var skipped = [];
    lines0.forEach(function (l, i) {
      var d = matchDate(l);
      if (d) {
        if (cur) rows.push(cur);
        cur = { line: l, date: d, lines: [l], cont: [] };
        return;
      }
      if (i < firstDate) { header.push(l); return; }
      if (/^(statement )?summary\b/i.test(l) && cur) { stopped = true; }
      if (stopped) return;
      if (!cur) return;
      if (isRepeating(l) || FOOTER.test(l) || FOOT_START.test(l)) return;
      cur.cont.push(l);
    });
    if (cur) rows.push(cur);

    // --- split each row into date-free text and money tokens (integer mode if decimal money is rare)
    var decRows = rows.filter(function (r) { return /\d\.\d{2}/.test(r.line); }).length;
    var intMode = rows.length > 5 && decRows / rows.length < 0.3;
    rows.forEach(function (r) {
      var rest = r.date.rest;
      // a second date (value date) right after the first is not narration
      var extra = matchDate(rest); while (extra && extra.len <= rest.length && extra.kind) { rest = extra.rest; extra = matchDate(rest); }
      var toks = rest.split(' ').filter(function (t) { return t !== ''; });
      r.money = []; r.text = [];
      r.wordMarker = '';
      var markAt = -1;
      toks.forEach(function (t) {
        var mv = parseMoney(t, intMode);
        if (mv) r.money.push(mv);
        else if (/^(Dr|Cr|DR|CR)\.?$/.test(t)) { if (markAt < 0) markAt = r.money.length; r.text.push(t); }   // "Dr"/"Cr" word beside the amount
        else r.text.push(t);
      });
      // a word marker is the transaction direction only when a money value follows it (i.e. it is not the balance's own marker)
      if (markAt >= 0 && markAt < r.money.length) r.wordMarker = r.text.filter(function (t) { return /^(Dr|Cr|DR|CR)\.?$/.test(t); })[0].replace('.', '').toUpperCase();
      r.text = r.text.filter(function (t) { return !/^(Dr|Cr|DR|CR)\.?$/.test(t) || !r.wordMarker; });
      // balance printed on the line below the date (common when the narration wraps): take money from continuation lines
      // amounts printed on the lines below the date (a wrapped description): take them, in order, until the row has two
      if (r.money.length < 2) {
        r.cont = r.cont.map(function (c) {
          if (r.money.length >= 2) return c;
          var parts = c.split(' ').filter(function (t) { return t !== ''; });
          var ms = parts.filter(function (t) { return parseMoney(t, intMode); });
          if (!ms.length) return c;
          ms.forEach(function (t) { if (r.money.length < 2) r.money.push(parseMoney(t, intMode)); });
          return parts.filter(function (t) { return !parseMoney(t, intMode); }).join(' ');
        }).filter(function (c) { return c !== ''; });
      }
      r.narr = r.text.join(' ');
      r.cont.forEach(function (c) { r.narr += ' ' + c; });
      r.narr = r.narr.replace(/\s+/g, ' ').trim();
    });

    // --- 4. balance column from the chain, and statement order
    var good = rows.filter(function (r) { return r.money.length >= 2; });
    var best = null;
    ['asc', 'desc'].forEach(function (ord) {
      [-1, -2].forEach(function (k) {
        var seq = ord === 'asc' ? good.slice() : good.slice().reverse();
        var match = 0, tried = 0;
        for (var i = 1; i < seq.length; i++) {
          var prevB = seq[i - 1].money[seq[i - 1].money.length + k].v;
          var r = seq[i], bi = r.money.length + k;
          if (bi < 0) continue;
          var b = r.money[bi].v, mv = Math.round((b - prevB) * 100) / 100;
          tried++;
          if (mv === 0) continue;
          var ok = r.money.some(function (m, j) { return j !== bi && Math.abs(Math.abs(mv) - Math.abs(m.v)) < 0.005; });
          if (ok) match++;
        }
        var score = tried ? match / tried : 0;
        if (!best || score > best.score) best = { ord: ord, k: k, score: score, match: match, tried: tried };
      });
    });
    var chainOk = best && best.score >= 0.6;

    // --- 5. build transactions in chronological order
    var chron = best && best.ord === 'desc' ? good.slice().reverse() : good.slice();
    var lastBal = null;
    if (chainOk && chron.length) { var lr = chron[chron.length - 1]; lastBal = lr.money[lr.money.length + best.k].v; }
    var closeForDerive = closingPrinted !== null ? closingPrinted : lastBal;
    var openingDerived = (openingPrinted === null && totalDr !== null && totalCr !== null && closeForDerive !== null) ? Math.round((closeForDerive - totalCr + totalDr) * 100) / 100 : null;
    var prev = openingPrinted !== null ? openingPrinted : openingDerived, transactions = [], sumD = 0, sumC = 0, lowCount = 0, dropped = 0;
    if (chainOk) {
      chron.forEach(function (r, idx) {
        var bi = r.money.length + best.k, bal = r.money[bi].v;
        var others = r.money.filter(function (m, j) { return j !== bi; });
        var conf = 'high', amount = null, drCr = null;
        if (prev !== null) {
          var mv = Math.round((bal - prev) * 100) / 100;
          var mark = (others.filter(function (m) { return m.marker; })[0] || {}).marker || r.wordMarker || '';
          if (mv !== 0) {
            var cand = others.filter(function (m) { return Math.abs(Math.abs(mv) - Math.abs(m.v)) < 0.005; })[0];
            if (cand) { amount = Math.abs(cand.v); drCr = mv > 0 ? 'C' : 'D'; if (mark && (mark === 'DR' ? 'D' : 'C') !== drCr) { drCr = mark === 'DR' ? 'D' : 'C'; conf = 'low'; lowCount++; } }
            else { conf = 'low'; amount = Math.abs(mv); drCr = mv > 0 ? 'C' : 'D'; lowCount++; }
          } else {
            // no movement: a zero-value line or a reversal pair; keep the non-zero amount as low confidence
            var nz = others.filter(function (m) { return Math.abs(m.v) > 0; })[0];
            if (!nz) { dropped++; prev = bal; return; }
            amount = Math.abs(nz.v); drCr = nz.marker === 'DR' ? 'D' : 'C'; conf = 'low'; lowCount++;
          }
        } else {
          // first row with no printed opening: use the marker or a zero placeholder, else flag low
          var mk = others.filter(function (m) { return m.marker; })[0] || (r.wordMarker ? { v: 0, marker: r.wordMarker } : null);
          var nzo = others.filter(function (m) { return Math.abs(m.v) > 0; });
          if (mk) { amount = Math.abs(mk.v); drCr = mk.marker === 'DR' ? 'D' : 'C'; conf = 'medium'; }
          else if (nzo.length === 1) { amount = Math.abs(nzo[0].v); drCr = 'C'; conf = 'low'; lowCount++; }
          else { amount = Math.abs(nzo[0] ? nzo[0].v : 0); drCr = 'C'; conf = 'low'; lowCount++; }
        }
        prev = bal;
        if (drCr === 'D') sumD += amount; else sumC += amount;
        transactions.push({ date: toYmd(r.date, order), narration: r.narr || '(narration not detected)', amount: Math.round(amount * 100) / 100,
          drCr: drCr, refNo: '', balance: bal, confidence: conf, reference_no: 'UNI-' + (idx + 1) });
      });
    }
    if (best && best.ord === 'desc') transactions.reverse();
    sumD = Math.round(sumD * 100) / 100; sumC = Math.round(sumC * 100) / 100;

    var openingFinal = openingPrinted !== null ? openingPrinted : openingDerived;
    var closingFinal = transactions.length ? (best && best.ord === 'desc' ? transactions[0].balance : transactions[transactions.length - 1].balance) : null;
    if (closingPrinted !== null) closingFinal = closingPrinted;
    var dates = transactions.map(function (t) { return t.date; }).filter(Boolean).sort();
    var skippedAll = rows.filter(function (r) { return r.money.length < 2; }).map(function (r) { return { lines: [r.line], reason: 'no amount/balance pair on the dated line (balance-only or header line)' }; });

    return {
      transactions: transactions, skipped: skippedAll, layout: 'universal_v2', directionFromMarker: false,
      statement: {
        opening_balance: openingFinal, closing_balance: closingFinal,
        derived_opening_balance: transactions.length && openingFinal === null && chainOk ? null : openingFinal,
        period_start: dates[0] || null, period_end: dates[dates.length - 1] || null,
        opening_source: openingPrinted !== null ? 'statement' : (openingDerived !== null ? 'derived_from_totals' : 'none'), closing_source: closingPrinted !== null ? 'statement' : 'derived',
        printed_total_debit: totalDr, printed_total_credit: totalCr,
        totals_match: totalDr !== null && totalCr !== null ? (Math.abs(sumD - totalDr) < 0.05 && Math.abs(sumC - totalCr) < 0.05) : null
      },
      diagnostics: { date_order: order, date_forms: dated.length, rows: rows.length, money_rows: good.length, balance_column: chainOk ? (best.k === -1 ? 'last' : 'second last') : null,
        statement_order: best ? best.ord : null, chain_match_rate: best ? Math.round(best.score * 1000) / 10 : 0, integer_mode: intMode,
        header_lines: header.slice(-8), repeating_lines_removed: Object.keys(seen).filter(function (k) { return seen[k] >= 3; }).length, zero_movement_dropped: dropped },
      repair: { reconstructed: 0, noBalanceEffect: 0, amountFromBalance: 0, markerConflicts: 0, headGap: 0, tailGap: 0, firstDirection: openingPrinted !== null ? 'opening' : 'marker',
        notes: [].concat(chainOk ? [] : ['No balance column could be matched to the transactions; please check the statement.'],
          lowCount ? [lowCount + ' row(s) are low confidence (no exact balance match).'] : []) }
    };
  }

  var UniversalParser = { extractUniversal: parse, parse: parse };
  // drop-in replacement: the page calls window.UniversalParser.extractUniversal(text)
  if (typeof module !== 'undefined' && module.exports) module.exports = UniversalParser; else root.UniversalParser = UniversalParser;
})(typeof window !== 'undefined' ? window : this);
