/* =========================================================
   bank-parser-core.js
   Shared helpers + the generic (no-parser-needed) extractor, and the
   parser manager that picks a bank-specific parser when one exists.
   Plain <script> include (window.BankParserCore) / Node module.

   INPUT CONTRACT for every parser (generic or specific): a single string
   of the bank statement's extracted text (what pdf.js's text layer gives
   you, joined with newlines roughly per visual row). Every parser is
   built around one anchor: a transaction starts wherever a date appears
   near the start of a line; everything until the next such line (wrapped
   narration, blank lines) belongs to that same transaction. This is what
   survives the multi-line narrations most of the sample statements use
   (Federal, UCO, SBI, IDFC, Bank of India, Sarvodaya all wrap).

   Known trade-off, found while testing against a real Canara Bank
   statement: Canara sometimes prints a transaction's date+amount+balance
   in the *middle* of its narration (narration lines both before and
   after the date line, not just after). The date/amount/balance for
   each row are still captured correctly either way -- narration text can
   blend into the adjacent row in that specific layout. Flagged here
   rather than silently producing clean-looking but wrong narration.
   ========================================================= */
(function (root) {
  'use strict';

  var MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

  // Shape 1: numeric/short-month with separators -- 01-04-2025, 01/Apr/2025, 1-4-25
  var DATE_RE_DMY = /\b(\d{1,2})[-\/](\d{1,2}|[A-Za-z]{3,9})[-\/](\d{2,4})\b/;
  // Shape 2: full month name leading, no separator needed -- "March31, 2026",
  // "March 31, 2026", "Mar 31 2026" (seen on Bandhan Bank statements)
  var DATE_RE_MDY = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*(\d{1,2}),?\s*(\d{4})\b/i;

  // Shape 3: day, space, month name, space, year -- "01 Apr 2026", "1 April, 2026"
  var DATE_RE_DMONY = /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+(\d{4})\b/i;

  function normalizeDate(d, m, y) {
    var mm = parseInt(m, 10);
    if (isNaN(mm)) {
      mm = MONTHS[String(m).slice(0, 3).toLowerCase()];
      if (!mm) return null;
    }
    if (mm < 1 || mm > 12) return null;
    var dd = parseInt(d, 10);
    if (dd < 1 || dd > 31) return null;
    var yyyy = String(y).length === 2 ? '20' + y : String(y);
    return yyyy + String(mm).padStart(2, '0') + String(dd).padStart(2, '0');
  }

  /* Tries both date shapes, returns the earlier match in the line (or
     null). Callers get back the normalized date AND the raw matched
     text (so it can be stripped out of narration cleanly). */
  function findDate(text) {
    var m1 = text.match(DATE_RE_DMY);
    var m2 = text.match(DATE_RE_MDY);
    var m3 = text.match(DATE_RE_DMONY);
    var candidates = [];
    if (m1) candidates.push({ m: m1, kind: 'dmy' });
    if (m2) candidates.push({ m: m2, kind: 'mdy' });
    if (m3) candidates.push({ m: m3, kind: 'dmy' }); // same group order as shape 1
    if (!candidates.length) return null;
    candidates.sort(function (a, b) { return a.m.index - b.m.index; });
    var c = candidates[0];
    var date = c.kind === 'dmy'
      ? normalizeDate(c.m[1], c.m[2], c.m[3])
      : normalizeDate(c.m[2], c.m[1], c.m[3]); // month-name shape: day is group 2, month group 1
    if (!date) return null;
    return { date: date, raw: c.m[0], index: c.m.index };
  }

  // Many banks print BOTH a Transaction Date and a Value Date on the same
  // row (Federal, IDFC, Karur Vysya, Bank of Baroda, Bandhan). Only the
  // first is used to anchor the block, so narration cleanup needs to strip
  // every date-shaped substring, not just that one, or the second date
  // lingers as clutter in the narration text.
  var DATE_RE_DMY_G = new RegExp(DATE_RE_DMY.source, 'g');
  var DATE_RE_MDY_G = new RegExp(DATE_RE_MDY.source, 'gi');
  var DATE_RE_DMONY_G = new RegExp(DATE_RE_DMONY.source, 'gi');
  function stripAllDates(text) {
    return text.replace(DATE_RE_DMY_G, '').replace(DATE_RE_DMONY_G, '').replace(DATE_RE_MDY_G, '');
  }

  /* A line counts as a transaction start if a date shows up within its
     first ~20 characters -- covers "Date first" layouts (Kotak, Axis,
     Federal, Bandhan), "Sr.No, Date" layouts (Bank of India, Karur
     Vysya, Bank of Baroda), and month-name layouts, without needing to
     know which one we're in. */
  function lineStartsTransaction(line) {
    var d = findDate(line);
    return d && d.index <= 20 ? d : null;
  }

  function splitIntoBlocks(rawText) {
    var lines = rawText.split(/\r?\n/);
    var blocks = [];
    var current = null;
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      if (!trimmed) continue;
      var d = lineStartsTransaction(trimmed);
      if (d) {
        if (current) blocks.push(current);
        current = { date: d.date, dateRaw: d.raw, lines: [trimmed] };
      } else if (current) {
        current.lines.push(trimmed);
      }
      // lines before the first date match (account header info) are dropped
    }
    if (current) blocks.push(current);
    return blocks;
  }

  // Amounts: 1,23,456.78 or 1234.78, optionally negative, optionally preceded
  // by a currency prefix (INR/Rs/Rupee-sign glued on with no space, e.g.
  // "INR19.00"), optionally followed by (Cr)/(Dr)/Cr/Dr/CR/DR right after.
  var MONEY_RE = /(?:INR|Rs\.?|\u20b9)?-?[\d,]+\.\d{2}\s*\(?(Cr|Dr|CR|DR)?\)?/g;

  function parseMoneyToken(tok) {
    var m = tok.match(/(-?[\d,]+\.\d{2})\s*\(?(\w{2})?\)?/);
    if (!m) return null;
    return { value: parseFloat(m[1].replace(/,/g, '')), marker: (m[2] || '').toUpperCase() };
  }

  // Rows that aren't real transactions at all -- opening balance / brought
  // forward lines -- show up across several sample banks (Sarvodaya,
  // Central Bank of India) with the same number repeated as both "amount"
  // and "balance". Filtered by narration text, not by the coincidence of
  // matching numbers, since that's the actual signal.
  var NON_TRANSACTION_RE = /opening\s+balance|brought\s*fwd|b\/f\b|balance\s+forward/i;

  /* A bank's statement isn't always printed oldest-first (SBI's loan
     account and Bandhan's savings statement both print newest-first).
     Balance-delta only means something if it's compared in true
     chronological order, so detect the file's own direction first and
     walk that way -- then hand results back in original document order. */
  function inferDirections(items) {
    if (!items.length) return items;
    var up = 0, down = 0; // majority vote over adjacent rows: one stray out-of-order row can't flip it
    for (var k = 1; k < items.length; k++) {
      if (items[k].block.date > items[k - 1].block.date) up++; else if (items[k].block.date < items[k - 1].block.date) down++;
    }
    var ascending = up >= down;
    var order = ascending ? items : items.slice().reverse();
    var prevBalance = null;
    order.forEach(function (item) {
      if (item.amount.marker === 'CR') { item.drCr = 'C'; item.confidence = 'high'; }
      else if (item.amount.marker === 'DR') { item.drCr = 'D'; item.confidence = 'high'; }
      else if (prevBalance !== null) {
        item.drCr = item.balance.value >= prevBalance ? 'C' : 'D';
        item.confidence = 'medium';
      } else {
        item.drCr = 'C'; // unresolvable guess -- only the chronologically first row hits this
        item.confidence = 'low';
      }
      prevBalance = item.balance.value;
    });
    return items; // same objects either way -- order/reverse only changed iteration, not identity
  }

  /* ---------- Generic fallback extractor ----------
     No bank-specific knowledge at all. Direction signals, in order:
       1. An explicit (Cr)/(Dr) marker on the amount itself, when present.
       2. Otherwise, compare this row's balance to the chronologically
          previous row's -- balance moved toward more money = Credit,
          away = Debit. Works for "separate Debit/Credit column, no
          marker" banks (Bank of India, Axis, ICICI, BOB, Central Bank,
          SBI, Sarvodaya, Canara...) without knowing which column is
          which, and without assuming the statement lists oldest-first. */
  function extractGeneric(rawText) {
    var blocks = splitIntoBlocks(rawText);
    var items = [];
    var skipped = [];

    blocks.forEach(function (block) {
      var text = block.lines.join(' ');
      if (NON_TRANSACTION_RE.test(text)) { skipped.push({ block: block, reason: 'opening_balance' }); return; }

      var tokens = text.match(MONEY_RE) || [];
      var parsed = tokens.map(parseMoneyToken).filter(Boolean);
      if (parsed.length < 2) { skipped.push({ block: block, reason: 'insufficient_amounts' }); return; }

      var bal = parsed[parsed.length - 1];
      // an explicit (Dr) on the balance means overdrawn: carry that as a negative balance
      items.push({ block: block, balance: { value: bal.marker === 'DR' ? -Math.abs(bal.value) : bal.value, marker: bal.marker }, amount: parsed[parsed.length - 2] });
    });

    inferDirections(items);

    var transactions = items.map(function (item) {
      var text = item.block.lines.join(' ');
      var narration = stripAllDates(text)
        .replace(MONEY_RE, '')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/^\d+\s+/, ''); // strip a leading Sr.No if the date wasn't at position 0

      return {
        date: item.block.date,
        narration: narration || '(narration not detected)',
        amount: Math.abs(item.amount.value),
        drCr: item.drCr,
        refNo: '',
        balance: item.balance.value, // statement's own running balance, used by balance-validator.js
        confidence: item.confidence
      };
    });

    return { transactions: transactions, skipped: skipped };
  }

  /* ---------- Parser manager ----------
     In the real tool this registry is populated by scanning /parsers/*.js
     at load time; here it's an explicit map for clarity. register() is
     what a new bank-specific parser file calls on itself. */
  var registry = {};
  function registerParser(bankId, parseFn) { registry[bankId] = parseFn; }
  function getParser(bankId) { return registry[bankId] || extractGeneric; }
  function hasSpecificParser(bankId) { return !!registry[bankId]; }

  var BankParserCore = {
    findDate: findDate, normalizeDate: normalizeDate, stripAllDates: stripAllDates,
    splitIntoBlocks: splitIntoBlocks,
    MONEY_RE: MONEY_RE, parseMoneyToken: parseMoneyToken,
    inferDirections: inferDirections,
    NON_TRANSACTION_RE: NON_TRANSACTION_RE,
    extractGeneric: extractGeneric,
    registerParser: registerParser, getParser: getParser, hasSpecificParser: hasSpecificParser
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BankParserCore;
  } else {
    root.BankParserCore = BankParserCore;
  }
})(typeof window !== 'undefined' ? window : this);
