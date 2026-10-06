/* =========================================================
   universal-parser.js -- balance-driven universal statement parser.
   Depends on bank-parser-core.js (BankParserCore). Plain <script> (window.UniversalParser) or Node.

   Idea (the accounting identity does the heavy lifting):
       Opening - Debits + Credits = Closing,   and for every row   previous balance +/- amount = balance.
   1. Find the OPENING balance: a label ("Opening Balance", "B/F", "Brought Forward"), a summary table, or
      -- failing that -- derive it from the first transaction (first balance +/- first amount).
   2. Find the CLOSING balance the same way (label / summary table).
   3. Walk the rows in chronological order. For each row the balance change tells us the EXACT amount and
      direction, whatever column the amount sat in. Wrong amount picked, direction unknown -> fixed.
   4. If a balance change is not explained by the row (a transaction the PDF text lost), the missing amount
      is rebuilt from the balance and added as a clearly flagged "reconstructed" entry.
      => Debit/Credit totals always reconcile exactly. Narration of such rows is NOT invented.
   Everything repaired is reported; nothing is silently changed.
   ========================================================= */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;
  var TOL = 0.01;
  var NUM = '(-?[\\d,]*\\d\\.\\d{2})';
  function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function toNum(s) { return parseFloat(String(s).replace(/,/g, '')); }
  function signed(v, marker) { return marker && /^dr$/i.test(marker) ? -Math.abs(v) : v; }

  /* ---------- statement-level detection ---------- */
  var OPEN_LABEL = /(opening\s*balance|opening\s*bal\b\.?|balance\s*b\/?f\b|b\/f\b|brought\s*forward|previous\s*balance)/ig;
  var CLOSE_LABEL = /(closing\s*balance|closing\s*bal\b\.?|balance\s*c\/?f\b|c\/f\b|carried\s*forward|ending\s*balance)/ig;
  var SEP = '(?:[\\s:|\\-\\u2013\\u2014\\u20b9]|Rs\\.?|INR)*';

  function moneyAfter(line, from, to) {
    var seg = line.slice(from, to === undefined ? line.length : to);
    var m = seg.match(new RegExp('^' + SEP + NUM + '\\s*(\\(?(Cr|Dr)\\)?)?', 'i'));
    if (!m) return null;
    return signed(toNum(m[1]), m[3]);
  }
  function detectBalances(rawText) {
    var lines = rawText.split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); });
    var openC = [], closeC = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]; if (!line) continue;
      var o = [], c = [], m;
      OPEN_LABEL.lastIndex = 0; while ((m = OPEN_LABEL.exec(line))) o.push({ idx: m.index, end: m.index + m[0].length, text: m[0] });
      CLOSE_LABEL.lastIndex = 0; while ((m = CLOSE_LABEL.exec(line))) c.push({ idx: m.index, end: m.index + m[0].length, text: m[0] });
      if (!o.length && !c.length) continue;
      var hasNum = new RegExp(NUM).test(line);
      if (o.length && c.length && !hasNum) {
        // header row of a summary table ("Opening Balance  Closing Balance") -> values on a following line
        for (var j = i + 1; j < Math.min(lines.length, i + 4); j++) {
          var nums = (lines[j].match(new RegExp(NUM + '\\s*\\(?(?:Cr|Dr)?\\)?', 'gi')) || []);
          if (nums.length >= 2) {
            var first = o[0].idx < c[0].idx;
            var a = Core.parseMoneyToken(nums[nums.length - 2]), b = Core.parseMoneyToken(nums[nums.length - 1]);
            var ov = first ? a : b, cv = first ? b : a;
            openC.push({ value: signed(ov.value, ov.marker), label: 'opening', how: 'summary_table', line: i });
            closeC.push({ value: signed(cv.value, cv.marker), label: 'closing', how: 'summary_table', line: i });
            break;
          }
        }
        continue;
      }
      var all = o.map(function (x) { return { x: x, kind: 'o' }; }).concat(c.map(function (x) { return { x: x, kind: 'c' }; })).sort(function (p, q) { return p.x.idx - q.x.idx; });
      all.forEach(function (e, k) {
        var stop = k + 1 < all.length ? all[k + 1].x.idx : undefined;
        var v = moneyAfter(line, e.x.end, stop);
        if (v === null && k === all.length - 1 && i + 1 < lines.length) {          // value alone on the next line
          var nx = lines[i + 1].match(new RegExp('^' + SEP + NUM + '\\s*(\\(?(Cr|Dr)\\)?)?$', 'i'));
          if (nx) v = signed(toNum(nx[1]), nx[3]);
        }
        if (v === null) return;
        var lab = /^opening|^previous/i.test(e.x.text) ? 'opening' : (/^closing|^ending/i.test(e.x.text) ? 'closing' : 'carry');
        (e.kind === 'o' ? openC : closeC).push({ value: v, label: lab, how: 'label', line: i });
      });
    }
    function pick(list, preferLabel, last) {
      if (!list.length) return null;
      var pref = list.filter(function (x) { return x.label === preferLabel; });
      var pool = pref.length ? pref : list;
      return last ? pool[pool.length - 1] : pool[0];
    }
    var opening = pick(openC, 'opening', false), closing = pick(closeC, 'closing', true);
    return { opening: opening, closing: closing, period: detectPeriod(lines) };
  }
  function detectPeriod(lines) {
    for (var i = 0; i < Math.min(lines.length, 120); i++) {
      var l = lines[i]; if (!/(period|statement|from|between|account statement)/i.test(l) && !/\bto\b|[-\u2013]/.test(l)) continue;
      var ds = [], rest = l, d, guard = 0;
      while ((d = Core.findDate(rest)) && guard++ < 4) { ds.push(d.date); rest = rest.slice(d.index + d.raw.length); }
      if (ds.length >= 2 && /to|[-\u2013\u2014]|till|through/i.test(l)) { var s = ds[0] < ds[1] ? ds[0] : ds[1], e = ds[0] < ds[1] ? ds[1] : ds[0]; return { start: s, end: e }; }
    }
    return null;
  }
  function dayNum(d) { return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) / 86400000; }

  /* ---------- first-row direction (only needed when no opening balance can be read) ---------- */
  var CREDIT_WORDS = /\b(RECD|RECEIVED|DEPOSIT|CREDIT|NEFTINW|INWARD|REFUND|REVERSAL|REV:|INT\.?\s?PD|INTEREST\s*(PAID|CREDIT)|SALARY\s*CREDIT|CR)\b/i;
  var DEBIT_WORDS = /\b(SENT|PAID|PAYMENT|WITHDRAWAL|DEBIT|CHRG|CHARGES?|ATM|POS|PURCHASE|EMI|NACH|ECS|CHQ|CHEQUE|DR)\b/i;
  function guessFirstDirection(item, bal0, amt0) {
    if (item.defaultAmount.marker === 'CR') return { dir: 'C', how: 'marker' };
    if (item.defaultAmount.marker === 'DR') return { dir: 'D', how: 'marker' };
    if (bal0 - amt0 < -TOL) return { dir: 'D', how: 'balance_cannot_be_negative' };   // a credit would imply a negative opening balance
    var t = item.text, c = CREDIT_WORDS.test(t), d = DEBIT_WORDS.test(t);
    if (c && !d) return { dir: 'C', how: 'narration' };
    if (d && !c) return { dir: 'D', how: 'narration' };
    return { dir: 'C', how: 'uncertain' };
  }

  /* Remove statement-level lines (opening/closing balance labels) and everything after the last transaction row
     once a closing section starts ("Account Summary", "End of Statement" ...). Those lines would otherwise be glued
     onto the last transaction as continuation text. detectBalances() has already read them from the full text. */
  var TAIL_MARKER = /^\s*(account summary|statement summary|summary of account|end of statement|important information|disclaimer|terms and conditions|abbreviations|legend)\b/i;
  function preprocess(rawText) {
    var lines = rawText.split(/\r?\n/), last = -1, i;
    for (i = 0; i < lines.length; i++) {
      var fd = Core.findDate(lines[i]);
      if (fd && fd.index <= 20 && !/[A-Za-z]{3,}/.test(lines[i].slice(0, fd.index)) && (lines[i].match(Core.MONEY_RE) || []).length >= 2) last = i;
    }
    var cut = lines.length;
    if (last >= 0) for (i = last + 1; i < lines.length; i++) if (TAIL_MARKER.test(lines[i]) || ((OPEN_LABEL.lastIndex = 0, OPEN_LABEL.test(lines[i])) || (CLOSE_LABEL.lastIndex = 0, CLOSE_LABEL.test(lines[i]))) && !Core.findDate(lines[i].slice(0, 20))) { cut = i; break; }
    return lines.slice(0, cut).filter(function (l) {
      var f = Core.findDate(l.slice(0, 20)); if (f) return true;
      OPEN_LABEL.lastIndex = 0; CLOSE_LABEL.lastIndex = 0; return !(OPEN_LABEL.test(l) || (CLOSE_LABEL.lastIndex = 0, CLOSE_LABEL.test(l)));
    }).join('\n');
  }

  /* ---------- main ---------- */
  function extractUniversal(rawText, opts) {
    opts = opts || {};
    var det = detectBalances(rawText);
    var blocks = Core.splitIntoBlocks(preprocess(rawText));
    var items = [], skipped = [], notes = [];
    blocks.forEach(function (block) {
      var text = block.lines.join(' ');
      var fd = Core.findDate(block.lines[0]);            // letters BEFORE the date => a heading ("Account Statement 01 Oct 2025 - ..."), not a row
      if (fd && /[A-Za-z]{3,}/.test(block.lines[0].slice(0, fd.index))) return;
      if (Core.NON_TRANSACTION_RE.test(text)) { skipped.push({ lines: block.lines, reason: 'opening/brought-forward line' }); return; }
      var toks = (text.match(Core.MONEY_RE) || []).map(Core.parseMoneyToken).filter(Boolean);
      if (toks.length < 2) { if (toks.length === 1) skipped.push({ lines: block.lines, reason: 'only one amount readable (amount or balance missing)' }); return; }
      var bal = toks[toks.length - 1], others = toks.slice(0, -1);
      var dflt = others[others.length - 1];
      items.push({ block: block, date: block.date, text: text, balance: signed(bal.value, bal.marker), tokens: others.map(function (t) { return { value: Math.abs(t.value), marker: t.marker }; }),
        defaultAmount: { value: Math.abs(dflt.value), marker: dflt.marker } });
    });
    if (!items.length) return { transactions: [], skipped: skipped, statement: {}, layout: 'universal', directionFromMarker: false, repair: { notes: ['No transaction rows found.'] } };

    // chronological order
    var up = 0, down = 0;
    for (var k = 1; k < items.length; k++) { if (items[k].date > items[k - 1].date) up++; else if (items[k].date < items[k - 1].date) down++; }
    var ascending = up >= down;
    var seq = ascending ? items.slice() : items.slice().reverse();

    // junk rows: legal text / headers that happen to contain a date and two numbers
    var period = det.period, lo = null, hi = null;
    if (period) { lo = dayNum(period.start) - 7; hi = dayNum(period.end) + 7; }
    else { var ds = items.map(function (i) { return dayNum(i.date); }).sort(function (a, b) { return a - b; }); var med = ds[Math.floor(ds.length / 2)]; lo = med - 400; hi = med + 400; }
    function linked(a, b) { var d = Math.abs(r2(b.balance - a.balance)); return b.tokens.some(function (t) { return Math.abs(t.value - d) <= TOL; }); }
    var kept = [];
    seq.forEach(function (it, idx) {
      var dn = dayNum(it.date), outOfRange = dn < lo || dn > hi;
      if (outOfRange) {
        var pl = idx > 0 && linked(seq[idx - 1], it), nl = idx + 1 < seq.length && linked(it, seq[idx + 1]);
        if (!pl && !nl) { skipped.push({ lines: it.block.lines, reason: 'date outside the statement period and not part of the balance chain (treated as page text)' }); return; }
      }
      kept.push(it);
    });
    seq = kept;
    if (!seq.length) return { transactions: [], skipped: skipped, statement: {}, layout: 'universal', directionFromMarker: false, repair: { notes: ['No usable rows.'] } };

    // ----- pass A: learn how THIS statement words credits vs debits, from rows the balance chain proves -----
    var words = {};                       // word -> {C:n, D:n}
    // Only the FIRST word of the narration is used as a feature (SENTIMPS / RECD / NEFTINW / UPI ...): that is the
    // transaction-type word. Party names appear on both sides of a ledger, so they would mislead the guess.
    function toWords(t) { var w = Core.stripAllDates(t).replace(Core.MONEY_RE, ' ').toUpperCase().replace(/^\s*\d+\s+/, '').split(/[^A-Z]+/).filter(function (x) { return x.length >= 3; }); return w.slice(0, 1); }
    function learn(it, dir) { toWords(it.text).forEach(function (w) { var e = words[w] || (words[w] = { C: 0, D: 0 }); e[dir]++; }); }
    for (var q = 1; q < seq.length; q++) {
      var dq = r2(seq[q].balance - seq[q - 1].balance), adq = Math.abs(dq);
      if (adq > TOL && seq[q].tokens.some(function (t) { return Math.abs(t.value - adq) <= TOL; })) learn(seq[q], dq > 0 ? 'C' : 'D');
    }
    function classify(it) {                // -> {dir, strength}  strength 0 = no evidence
      var lc = 0, ld = 0;
      toWords(it.text).forEach(function (w) { var e = words[w]; if (!e || e.C + e.D < 3) return; var n = e.C + e.D; lc += Math.log((e.C + 1) / (n + 2)); ld += Math.log((e.D + 1) / (n + 2)); });
      if (Math.abs(lc - ld) < 0.5) {       // statement-specific evidence is weak: fall back to generic words
        var c = CREDIT_WORDS.test(it.text), d = DEBIT_WORDS.test(it.text);
        if (c && !d) return { dir: 'C', strength: 2 }; if (d && !c) return { dir: 'D', strength: 2 };
        return { dir: lc >= ld ? 'C' : 'D', strength: 0 };
      }
      return { dir: lc > ld ? 'C' : 'D', strength: Math.abs(lc - ld) };
    }

    // ----- pass B: the balance walk -----
    var opening = det.opening ? det.opening.value : null, openingSource = det.opening ? 'statement' : 'derived';
    var closing = det.closing ? det.closing.value : null;
    var out = [], rep = { reconstructed: 0, amountFromBalance: 0, noBalanceEffect: 0, markerConflicts: 0, headGap: 0, tailGap: 0, firstDirection: null, notes: notes };
    var prev = opening;
    function push(it, o) { out.push(Object.assign({ date: it.date, refNo: '' }, o)); }
    function synth(date, amount, dir, balanceAfter, why) {
      rep.reconstructed++;
      out.push({ date: date, narration: '(not extracted — rebuilt from balance)', amount: r2(Math.abs(amount)), drCr: dir, refNo: '', balance: balanceAfter, confidence: 'low', reconstructed: true, reconstructed_reason: why });
    }
    function cleanNarr(it) {
      var n = Core.stripAllDates(it.text).replace(Core.MONEY_RE, '').trim().replace(/\s+/g, ' ').replace(/^\d+\s+/, '');
      return n || '(narration not detected)';
    }
    function ownDirection(it, delta) {     // direction of the row's own printed amount when the chain cannot tell us
      var mk = it.defaultAmount.marker; if (mk === 'CR') return { dir: 'C', how: 'marker' }; if (mk === 'DR') return { dir: 'D', how: 'marker' };
      var cl = classify(it), a = it.defaultAmount.value;
      var gC = Math.abs(r2(delta - a)), gD = Math.abs(r2(delta + a));
      if (cl.strength >= 1.5) return { dir: cl.dir, how: 'wording' };       // strong evidence only (e.g. Recd vs Sent)
      return { dir: gC <= gD ? 'C' : 'D', how: 'smaller_gap' };       // otherwise the smaller unexplained amount is the likelier story
    }
    seq.forEach(function (it, idx) {
      var bal = it.balance;
      if (prev === null) {                                   // no opening anywhere: derive it from this first row
        var amt0 = it.defaultAmount.value, g;
        if (it.defaultAmount.marker === 'CR') g = { dir: 'C', how: 'marker' };
        else if (it.defaultAmount.marker === 'DR') g = { dir: 'D', how: 'marker' };
        else if (bal - amt0 < -TOL) g = { dir: 'D', how: 'balance cannot be negative' };      // a credit would imply a negative opening
        else { var cl0 = classify(it); g = { dir: cl0.dir, how: cl0.strength >= 1.5 ? 'wording of the other rows' : 'uncertain' }; }
        opening = r2(bal - (g.dir === 'C' ? amt0 : -amt0)); prev = opening; rep.firstDirection = g.how;
        if (g.how === 'uncertain') notes.push('The first transaction\'s direction could not be determined and no opening balance was found on the statement. Please type the opening balance printed on the statement into the validation box.');
        else notes.push('Opening balance derived from the first transaction (' + g.how + ').');
      }
      var delta = r2(bal - prev), absD = Math.abs(delta);
      if (absD <= TOL) {                                     // the balance did not move although the row shows an amount
        var own0 = it.defaultAmount, prevOut = out.length ? out[out.length - 1] : null;
        var dupe = prevOut && !prevOut.reconstructed && prevOut.amount === own0.value && prevOut.balance === bal && prevOut.date === it.date && prevOut.narration === cleanNarr(it);
        if (dupe) {                                          // identical to the row just before it: a repeated line, not a transaction
          rep.noBalanceEffect++;
          push(it, { narration: cleanNarr(it), amount: own0.value, drCr: own0.marker === 'DR' ? 'D' : 'C', balance: bal, confidence: 'low', no_balance_effect: true });
          return;
        }
        // Otherwise an equal and opposite transaction before it was lost (e.g. "received 50,000" then "sent 50,000").
        var od0 = ownDirection(it, 0), opp = od0.dir === 'C' ? 'D' : 'C';
        if (idx === 0 && openingSource === 'statement') rep.headGap++;
        synth(it.date, own0.value, opp, r2(prev + (opp === 'C' ? own0.value : -own0.value)), 'the balance did not change although this row shows ' + own0.value + ': an equal and opposite entry before it is missing');
        push(it, { narration: cleanNarr(it), amount: own0.value, drCr: od0.dir, balance: bal, confidence: od0.how === 'marker' ? 'high' : 'low', direction_inferred: od0.how === 'marker' ? undefined : od0.how + ' (the pair may be swapped)' });
        return;
      }
      var match = null; for (var t = it.tokens.length - 1; t >= 0; t--) { if (Math.abs(it.tokens[t].value - absD) <= TOL) { match = it.tokens[t]; break; } }
      var dir = delta > 0 ? 'C' : 'D';
      if (match) {
        var mk = it.defaultAmount.marker, conflict = (mk === 'CR' && dir === 'D') || (mk === 'DR' && dir === 'C');
        if (conflict) rep.markerConflicts++;
        push(it, { narration: cleanNarr(it), amount: match.value, drCr: dir, balance: bal, confidence: conflict ? 'low' : (match === it.tokens[it.tokens.length - 1] ? (mk ? 'high' : 'medium') : 'medium'), marker_conflict: conflict || undefined });
        prev = bal; return;
      }
      // The row does not explain the balance change on its own: a transaction before it was lost.
      // Keep the row exactly as printed and rebuild the missing amount from the balance.
      var own = it.defaultAmount, od = ownDirection(it, delta);
      var sOwn = od.dir === 'C' ? own.value : -own.value, gap = r2(delta - sOwn);
      if (idx === 0 && openingSource === 'statement') rep.headGap++;
      synth(it.date, gap, gap > 0 ? 'C' : 'D', r2(prev + gap), 'balance moved by ' + (delta > 0 ? '+' : '−') + absD + ' but the row after it accounts for ' + (od.dir === 'C' ? '+' : '−') + own.value);
      push(it, { narration: cleanNarr(it), amount: own.value, drCr: od.dir, balance: bal, confidence: od.how === 'marker' ? 'high' : 'medium', direction_inferred: od.how === 'marker' ? undefined : od.how });
      prev = bal;
    });
    // tail: closing balance printed on the statement but chain ended elsewhere
    if (closing !== null && prev !== null && Math.abs(r2(closing - prev)) > TOL) {
      var gap2 = r2(closing - prev); rep.tailGap++;
      synth(seq[seq.length - 1].date, gap2, gap2 > 0 ? 'C' : 'D', closing, 'statement closing balance differs from the last row\'s balance by ' + Math.abs(gap2));
    }
    if (rep.reconstructed) notes.push(rep.reconstructed + ' entr' + (rep.reconstructed === 1 ? 'y was' : 'ies were') + ' rebuilt from balance changes because the PDF text did not contain them. Amounts and Debit/Credit are exact; narration is missing — please review.');
        if (rep.noBalanceEffect) notes.push(rep.noBalanceEffect + ' row(s) did not change the balance (possible duplicates or non-transaction lines) — review them.');
    if (rep.markerConflicts) notes.push(rep.markerConflicts + ' row(s) had a Cr/Dr marker that contradicts the balance; the balance was followed.');

    // back to document order
    var doc = ascending ? out : out.slice().reverse();
    return {
      transactions: doc, skipped: skipped, layout: 'universal', directionFromMarker: false,
      statement: { opening_balance: det.opening ? opening : null, closing_balance: det.closing ? closing : null, period_start: period && period.start, period_end: period && period.end,
        opening_source: openingSource, closing_source: det.closing ? 'statement' : 'derived', derived_opening_balance: opening },
      repair: rep
    };
  }

  var UniversalParser = { extractUniversal: extractUniversal, detectBalances: detectBalances, guessFirstDirection: guessFirstDirection };
  if (typeof module !== 'undefined' && module.exports) module.exports = UniversalParser; else root.UniversalParser = UniversalParser;
})(typeof window !== 'undefined' ? window : this);
