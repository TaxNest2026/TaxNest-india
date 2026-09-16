/* =========================================================
   bank-parser-core.js
   Shared helpers + the generic (no-parser-needed) extractor, and the
   parser manager that picks a bank-specific parser when one exists.
   Plain <script> include (window.BankParserCore) / Node module.

   INPUT CONTRACT for every parser (generic or specific): a single string
   of the bank statement's extracted text (what pdf.js's text layer gives
   you, joined with newlines roughly per visual row). Every parser in this
   system, generic or specific, is built around one anchor: a transaction
   starts wherever a date appears near the start of a line; everything
   until the next such line (wrapped narration, blank lines) belongs to
   that same transaction. This is what survives the multi-line narrations
   that show up in most of the sample statements (Federal, UCO, SBI, IDFC,
   Bank of India all wrap).
   ========================================================= */
(function (root) {
  'use strict';

  var MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

  // Covers every date shape seen across the sample banks:
  // 01-04-2025, 01/04/2025, 01-Apr-2025, 01-Apr-25
  var DATE_RE = /\b(\d{1,2})[-\/](\d{1,2}|[A-Za-z]{3,9})[-\/](\d{2,4})\b/;

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

  /* A line counts as a transaction start if a date shows up within its
     first ~20 characters -- covers both "Date first" layouts (Kotak,
     Axis, Federal) and "Sr.No, Date" layouts (Bank of India, Karur
     Vysya, Bank of Baroda) without needing to know which one we're in. */
  function lineStartsTransaction(line) {
    var m = line.match(DATE_RE);
    return m && m.index <= 20 ? m : null;
  }

  function splitIntoBlocks(rawText) {
    var lines = rawText.split(/\r?\n/);
    var blocks = [];
    var current = null;
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      if (!trimmed) continue;
      var m = lineStartsTransaction(trimmed);
      if (m) {
        if (current) blocks.push(current);
        current = { dateMatch: m, lines: [trimmed] };
      } else if (current) {
        current.lines.push(trimmed);
      }
      // lines before the first date match (account header info) are dropped
    }
    if (current) blocks.push(current);
    return blocks;
  }

  // Amounts: 1,23,456.78 or 1234.78, optionally negative, optionally
  // followed by (Cr)/(Dr)/Cr/Dr/CR/DR right after.
  var MONEY_RE = /-?[\d,]+\.\d{2}\s*\(?(Cr|Dr|CR|DR)?\)?/g;

  function parseMoneyToken(tok) {
    var m = tok.match(/(-?[\d,]+\.\d{2})\s*\(?(\w{2})?\)?/);
    if (!m) return null;
    return { value: parseFloat(m[1].replace(/,/g, '')), marker: (m[2] || '').toUpperCase() };
  }

  /* ---------- Generic fallback extractor ----------
     No bank-specific knowledge at all. Two direction signals, in order:
       1. An explicit (Cr)/(Dr) marker on the amount itself, when present.
       2. Otherwise, compare this row's balance to the previous row's --
          balance went up = money in (Credit), down = money out (Debit).
          This works for the "separate Debit/Credit column, no marker"
          banks (Bank of India, Axis, ICICI, BOB, Central Bank, South
          Indian...) *without* needing to know which column is which.
     Only the very first row, when there's no marker AND no prior balance
     to compare against, is a genuine guess -- flagged low-confidence so
     the review grid can surface it. Everything else is either high
     confidence (marker present) or medium (balance-delta inferred). */
  function extractGeneric(rawText) {
    var blocks = splitIntoBlocks(rawText);
    var transactions = [];
    var skipped = [];
    var prevBalance = null;

    blocks.forEach(function (block) {
      var text = block.lines.join(' ');
      var date = normalizeDate(block.dateMatch[1], block.dateMatch[2], block.dateMatch[3]);
      if (!date) { skipped.push(block); return; }

      var tokens = text.match(MONEY_RE) || [];
      var parsed = tokens.map(parseMoneyToken).filter(Boolean);
      if (parsed.length < 2) { skipped.push(block); return; } // need amount + balance at minimum

      var balance = parsed[parsed.length - 1];
      var amount = parsed[parsed.length - 2];
      var drCr, confidence;

      if (amount.marker === 'CR') { drCr = 'C'; confidence = 'high'; }
      else if (amount.marker === 'DR') { drCr = 'D'; confidence = 'high'; }
      else if (prevBalance !== null) {
        drCr = balance.value >= prevBalance ? 'C' : 'D';
        confidence = 'medium';
      } else {
        drCr = 'C'; // unresolvable guess on row 1 only
        confidence = 'low';
      }
      prevBalance = balance.value;

      var narration = text
        .replace(block.dateMatch[0], '')
        .replace(MONEY_RE, '')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/^\d+\s+/, ''); // strip a leading Sr.No if the date wasn't at position 0

      transactions.push({
        date: date,
        narration: narration || '(narration not detected)',
        amount: Math.abs(amount.value),
        drCr: drCr,
        refNo: '',
        confidence: confidence
      });
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
    DATE_RE: DATE_RE, normalizeDate: normalizeDate,
    splitIntoBlocks: splitIntoBlocks,
    MONEY_RE: MONEY_RE, parseMoneyToken: parseMoneyToken,
    extractGeneric: extractGeneric,
    registerParser: registerParser, getParser: getParser, hasSpecificParser: hasSpecificParser
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BankParserCore;
  } else {
    root.BankParserCore = BankParserCore;
  }
})(typeof window !== 'undefined' ? window : this);
