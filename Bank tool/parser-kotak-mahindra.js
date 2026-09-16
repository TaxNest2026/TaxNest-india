/* =========================================================
   parser-kotak-mahindra.js
   Specific parser for Kotak Mahindra Bank statements.
   Column shape (confirmed against a real 13-page statement):
     Date | Narration | Chq/Ref No | Withdrawal(Dr)/Deposit(Cr) | Balance
   The amount always carries an explicit (Cr)/(Dr) suffix, so direction
   is never a guess here -- this is what a specific parser buys you over
   the generic fallback. Ref No is a distinct token right before the
   amount (IMPS-..., NEFTINW-..., UPI-..., MB-..., NCRCTS_..., or a bare
   cheque number), so we can pull it out instead of leaving it blank.
   bank_id 'kotak_mahindra' must match the id used in bank-list.js so the
   parser manager picks this over the generic fallback automatically.
   ========================================================= */
(function (root) {
  'use strict';
  var Core = (typeof module !== 'undefined' && module.exports) ? require('./bank-parser-core.js') : root.BankParserCore;

  function parseKotakMahindra(rawText) {
    var blocks = Core.splitIntoBlocks(rawText);
    var transactions = [];
    var skipped = [];

    blocks.forEach(function (block) {
      var text = block.lines.join(' ');
      var date = Core.normalizeDate(block.dateMatch[1], block.dateMatch[2], block.dateMatch[3]);
      if (!date) { skipped.push(block); return; }

      var tokens = text.match(Core.MONEY_RE) || [];
      var parsed = tokens.map(Core.parseMoneyToken).filter(Boolean);
      // Kotak always prints amount then balance, both with a Cr/Dr suffix
      if (parsed.length < 2) { skipped.push(block); return; }
      var balance = parsed[parsed.length - 1];
      var amount = parsed[parsed.length - 2];
      if (!amount.marker) { skipped.push(block); return; } // not the expected Kotak shape -- bail to generic upstream

      // Ref No: the token right after the narration, before the amount --
      // Kotak's own instrument/reference id, e.g. IMPS-509111721243
      var refMatch = text.match(/\b((?:IMPS|NEFTINW|RTGSINW|UPI|MB|NCRCTS_?|KPG-|GBM-)[\w-]*|\d{9,})\b(?=[^\d]*-?[\d,]+\.\d{2})/);

      var narration = text
        .replace(block.dateMatch[0], '')
        .replace(Core.MONEY_RE, '')
        .trim()
        .replace(/\s+/g, ' ');
      if (refMatch) narration = narration.replace(refMatch[0], '').trim().replace(/\s+/g, ' ');

      transactions.push({
        date: date,
        narration: narration || '(narration not detected)',
        amount: Math.abs(amount.value),
        drCr: amount.marker === 'CR' ? 'C' : 'D',
        refNo: refMatch ? refMatch[0] : '',
        confidence: 'high'
      });
    });

    return { transactions: transactions, skipped: skipped };
  }

  if (Core && Core.registerParser) Core.registerParser('kotak_mahindra', parseKotakMahindra);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = parseKotakMahindra;
  } else {
    root.parseKotakMahindra = parseKotakMahindra;
  }
})(typeof window !== 'undefined' ? window : this);
