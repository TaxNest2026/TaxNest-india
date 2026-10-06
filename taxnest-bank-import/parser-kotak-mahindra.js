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


  /* ---------------------------------------------------------------
     Layout B -- "serial-number layout" (Privy League / newer Kotak PDFs)
       # | Date (DD Mon YYYY) | Description | Chq/Ref. No. | Withdrawal (Dr.) | Deposit (Cr.) | Balance
     Confirmed against a real 17-page statement (443 rows). Differences from layout A:
       - rows start with a serial number, dates are "01 Oct 2025"
       - NO Cr/Dr suffix: one amount is printed in either the Withdrawal or the Deposit
         column and the text layer does not say which. Direction is therefore derived from the
         running balance (balance up = credit), and every row is cross-checked: the amount must
         equal the balance change exactly, otherwise the row is marked low confidence.
       - opening balance is the "Opening Balance" row; closing balance is in the Account
         Summary at the end -- both are read from the statement, so balance-validator.js can
         report a genuine 'passed'.
       - the serial numbers must run 1..N with no gaps; any gap means a lost row and is reported.
     --------------------------------------------------------------- */
  var SERIAL_ROW_RE = /^\s*(\d{1,5})\s+(\d{2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\s+(.*)$/i;
  var TAIL_RE = /^(.*?)\s*(-?[\d,]*\d\.\d{2})\s+(-?[\d,]*\d\.\d{2})\s*$/;
  var MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  var REF_TAIL_RE = /\s((?:IMPS|NEFTINW|RTGSINW|UPI|MB|KPG|NCRCTS_?|GBM)-[\w-]+|NACHDB\d+|\d{3}\/\d{9,}|\d{12})$/;

  function isSerialLayout(rawText) {
    return /Withdrawal\s*\(Dr\.?\)/i.test(rawText) && /^\s*\d{1,5}\s+\d{2}\s+[A-Za-z]{3}\s+\d{4}\s/m.test(rawText);
  }
  // PDF wraps can split one long token across lines ("...SBK-" / "13990262000217"): no space after a trailing hyphen or slash
  function joinNarration(a, b) { return (/[-\/]$/.test(a) ? a + b : a + ' ' + b).trim(); }
  function money(s) { return Math.round(parseFloat(String(s).replace(/,/g, '')) * 100) / 100; }

  function parseSerialLayout(rawText) {
    var lines = rawText.split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); });
    var transactions = [], skipped = [];
    var statement = { opening_balance: null, closing_balance: null, holder: '', period_start: null, period_end: null, serial_gaps: [] };

    // --- statement-level facts (all read from the document, nothing assumed) ---
    var nameLine = lines.filter(function (l) { return /\sAccount No\.\s*\d/.test(l) || /^Account No\./.test(l); })[0];
    var nm = rawText.match(/\n([^\n]+?)\s+Account No\.\s*(\d+)/);
    if (nm) { statement.holder = nm[1].trim(); statement.account_number_masked = 'XXXX' + nm[2].slice(-4); }
    var per = rawText.match(/(\d{2})\s+([A-Za-z]{3})\s+(\d{4})\s*-\s*(\d{2})\s+([A-Za-z]{3})\s+(\d{4})/);
    if (per) {
      statement.period_start = per[3] + MONTHS[per[2].toLowerCase()] + per[1];
      statement.period_end = per[6] + MONTHS[per[5].toLowerCase()] + per[4];
    }
    var ob = rawText.match(/Opening Balance[^\n\d-]*(?:-\s*)*(?:-\s+)*([\d,]*\d\.\d{2})\s*(?:\n|$)/);
    if (ob) statement.opening_balance = money(ob[1]);
    var sumIdx = -1;
    for (var s = 0; s < lines.length; s++) if (/Opening Balance\s+Closing Balance/.test(lines[s])) { sumIdx = s; break; }
    if (sumIdx >= 0) {
      for (var s2 = sumIdx + 1; s2 < Math.min(lines.length, sumIdx + 4); s2++) {
        var sm = lines[s2].match(/([\d,]*\d\.\d{2})\s+([\d,]*\d\.\d{2})\s*$/);
        if (sm) { if (statement.opening_balance === null) statement.opening_balance = money(sm[1]); statement.summary_opening = money(sm[1]); statement.closing_balance = money(sm[2]); break; }
      }
    }

    // --- rows ---
    var holder = statement.holder;
    var inTable = false, skipPageNoise = false, last = null, prevBalance = statement.opening_balance, expectedSerial = 1;
    function isNoise(l) {
      return !l || /^Statement Generated on/i.test(l) || /^Account Statement\b/i.test(l) || /^Account No\./i.test(l) ||
        /^Current Account Transactions$/i.test(l) || (holder && (l === holder || l.indexOf(holder + ' Account No.') === 0));
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^#\s+Date\s+Description/i.test(line)) { inTable = true; skipPageNoise = false; continue; }
      if (/^(Account Summary|End of Statement)\b/i.test(line)) { if (inTable) inTable = false; skipPageNoise = true; continue; }
      if (!inTable) continue;
      if (/^Statement Generated on/i.test(line)) { skipPageNoise = true; continue; }   // page footer: ignore until next table header
      if (skipPageNoise || isNoise(line)) continue;
      if (/Opening Balance/i.test(line) && /^[-\s]+Opening Balance/.test(line)) continue;

      var m = line.match(SERIAL_ROW_RE);
      var tail = m ? m[5].match(TAIL_RE) : null;
      if (m && tail) {
        var serial = parseInt(m[1], 10);
        if (serial !== expectedSerial) statement.serial_gaps.push({ expected: expectedSerial, found: serial });
        expectedSerial = serial + 1;
        var body = tail[1], amount = money(tail[2]), balance = money(tail[3]);
        var ref = '';
        var rm = (' ' + body).match(REF_TAIL_RE);
        if (rm) { ref = rm[1]; body = body.slice(0, body.length - ref.length).trim(); }
        else if (/CASH WITHDRAWAL/i.test(body)) { var cm = body.match(/\s(\d{3,5})$/); if (cm) { ref = cm[1]; body = body.slice(0, body.length - ref.length).trim(); } }
        var delta = prevBalance === null ? null : Math.round((balance - prevBalance) * 100) / 100;
        var consistent = delta !== null && Math.abs(Math.abs(delta) - amount) < 0.005;
        var drCr = delta === null ? (amount ? 'C' : 'D') : (delta >= 0 ? 'C' : 'D');
        last = {
          date: m[4] + MONTHS[m[3].toLowerCase()] + m[2], narration: body, amount: amount, drCr: drCr, refNo: ref,
          balance: balance, serial: serial, confidence: consistent ? 'high' : 'low'
        };
        transactions.push(last);
        prevBalance = balance;
      } else if (m) {
        skipped.push({ lines: [line], reason: 'serial row without amount+balance' });
      } else if (last) {
        // continuation of the previous row's wrapped Description / Ref cell
        // NACH refs wrap into the next line as 1-3 trailing digits ("...2000217 00") -- give them back to the ref
        var wrap = /^NACHDB/.test(last.refNo) ? line.match(/^(?:(.*?)\s+)?(\d{1,3})$/) : null;
        if (wrap) { last.refNo += wrap[2]; if (wrap[1]) last.narration = joinNarration(last.narration, wrap[1]); }
        else last.narration = joinNarration(last.narration, line);
      } else {
        skipped.push({ lines: [line], reason: 'text before first row' });
      }
    }
    statement.row_count = transactions.length;
    statement.last_serial = expectedSerial - 1;
    transactions.forEach(function (t) { if (!t.narration) t.narration = '(narration not detected)'; });
    return { transactions: transactions, skipped: skipped, statement: statement, layout: 'kotak_serial', directionFromMarker: false };
  }

  function parseKotakMahindra(rawText) {
    if (isSerialLayout(rawText)) return parseSerialLayout(rawText);   // layout B (no Cr/Dr markers)
    var blocks = Core.splitIntoBlocks(rawText);
    var transactions = [];
    var skipped = [];

    blocks.forEach(function (block) {
      var text = block.lines.join(' ');
      // splitIntoBlocks already normalized the date (block.date) and kept the raw text (block.dateRaw)
      var date = block.date;
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
        .replace(block.dateRaw, '')
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
        balance: balance.value * (balance.marker === 'DR' ? -1 : 1),
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
