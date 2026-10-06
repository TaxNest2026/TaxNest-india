/* =========================================================
   parser-bandhan-bank.js
   Specific parser for Bandhan Bank statements.
   Column shape (confirmed against a real multi-page statement):
     Transaction Date | Value Date | Description | Amount | Dr / Cr | Balance
   Two things make this bank different from Kotak's shape:
     1. Dates print as "March31, 2026" -- month name glued to the day, no
        separator (handled by bank-parser-core's DATE_RE_MDY).
     2. The Dr/Cr marker is its OWN column, sitting between the amount and
        the balance, not glued onto the amount like Kotak's "(Cr)". Genuine
        per-row signal though -- checked against multiple pages, it does
        vary row to row (Cr, Dr, Dr, Dr...), unlike some other banks in this
        set where a trailing Cr/Dr next to the *balance* just means "this
        account is in credit" and never changes.
     Statement also prints newest-first, same as SBI -- handled already by
     bank-parser-core's chronological-direction detection.
   bank_id 'bandhan' must match the id used in bank-list.js.
   ========================================================= */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  function parseBandhan(rawText) {
    var blocks = Core.splitIntoBlocks(rawText);
    var items = [];
    var skipped = [];

    blocks.forEach(function (block) {
      var text = block.lines.join(' ');
      if (Core.NON_TRANSACTION_RE.test(text)) { skipped.push({ block: block, reason: 'opening_balance' }); return; }

      var matches = Array.from(text.matchAll(Core.MONEY_RE));
      var parsed = matches.map(function (m) { return Core.parseMoneyToken(m[0]); }).filter(Boolean);
      if (parsed.length < 2) { skipped.push({ block: block, reason: 'insufficient_amounts' }); return; }

      var balanceMatch = matches[matches.length - 1];
      var amountMatch = matches[matches.length - 2];
      var amount = parsed[parsed.length - 2];
      var balance = parsed[parsed.length - 1];

      // The Dr/Cr column sits in the gap between the amount and the balance
      var between = text.slice(amountMatch.index + amountMatch[0].length, balanceMatch.index);
      if (/\bcr\b/i.test(between)) amount.marker = 'CR';
      else if (/\bdr\b/i.test(between)) amount.marker = 'DR';

      items.push({ block: block, amount: amount, balance: balance });
    });

    Core.inferDirections(items); // uses the marker we just set when present, balance-delta otherwise

    var transactions = items.map(function (item) {
      var text = item.block.lines.join(' ');
      var narration = Core.stripAllDates(text)
        .replace(Core.MONEY_RE, '')
        .replace(/\b(Dr|Cr)\b/gi, '')
        .trim()
        .replace(/\s+/g, ' ');

      return {
        date: item.block.date,
        narration: narration || '(narration not detected)',
        amount: Math.abs(item.amount.value),
        drCr: item.drCr,
        refNo: '',
        balance: item.balance.value,
        confidence: item.confidence
      };
    });

    return { transactions: transactions, skipped: skipped };
  }

  if (Core && Core.registerParser) Core.registerParser('bandhan', parseBandhan);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = parseBandhan;
  } else {
    root.parseBandhan = parseBandhan;
  }
})(typeof window !== 'undefined' ? window : this);
