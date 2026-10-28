/* check-parser.js -- runs one parser on one PDF the same way the tool does, and prints what it found.
   Usage (from the project root):
     node tools/check-parser.js <statement.pdf> <bank-id> [parser-file]
   Needs pdfjs-dist installed (npm install pdfjs-dist) for PDF text extraction.                      */
'use strict';
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const require2 = createRequire(__filename);

(async () => {
  const [pdfPath, bankId, parserFile] = process.argv.slice(2);
  if (!pdfPath || !bankId) { console.log('Usage: node tools/check-parser.js <statement.pdf> <bank-id> [parser-file]'); process.exit(1); }
  const root = path.join(__dirname, '..');
  const Core = require2(path.join(root, 'bank-parser-core.js'));
  const PL = require2(path.join(root, 'pdf-lines.js'));
  const V = require2(path.join(root, 'balance-validator.js'));
  require2(path.join(root, 'universal-parser.js'));
  if (parserFile) require2(path.resolve(parserFile));
  else fs.readdirSync(path.join(root, 'bank-parsers')).filter(f => /^parser-.*\.js$/.test(f))
    .forEach(f => require2(path.join(root, 'bank-parsers', f)));

  // same text pipeline as the browser: pdf.js text items -> visual lines -> one text
  const pdfjs = await import(require2.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: true }).promise;
  const st = {}, pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    pages.push(PL.groupItemsIntoLines((await page.getTextContent()).items, st, {}).plain);
  }
  const text = Core.fixSplitDates(pages.join('\n') + '\n');

  const parser = Core.findParser(bankId, text);
  if (!parser) { console.log('No parser matched bank id ' + bankId + ' or this statement text.'); process.exit(2); }
  const r = parser.meta && parser.meta.label ? parser : parser;
  const result = parser(parser.wantsHints ? text : text);
  const tx = result.transactions || [];
  const dr = tx.filter(t => t.drCr === 'D'), cr = tx.filter(t => t.drCr === 'C');
  const sum = a => Math.round(a.reduce((s, t) => s + t.amount, 0) * 100) / 100;
  const v = V.validateStatement(tx, { opening: result.statement && result.statement.opening_balance, closing: result.statement && result.statement.closing_balance });
  console.log('parser        : ' + (parser.meta ? parser.meta.key + ' (' + parser.meta.label + ')' : 'unknown'));
  console.log('rows          : ' + tx.length + '  (Dr ' + dr.length + ', Cr ' + cr.length + ')');
  console.log('totals        : debit ' + sum(dr) + '  credit ' + sum(cr));
  console.log('printed       : debit ' + (result.statement && result.statement.printed_total_debit) + '  credit ' + (result.statement && result.statement.printed_total_credit));
  console.log('opening/close : ' + (result.statement && result.statement.opening_balance) + ' / ' + (result.statement && result.statement.closing_balance));
  console.log('balance check: ' + v.status + '  difference ' + v.difference + '  failures ' + v.failures.length);
  console.log('low-confidence rows: ' + tx.filter(t => t.confidence === 'low').length + '  skipped lines: ' + (result.skipped || []).length);
  tx.slice(0, 3).forEach(t => console.log('  ' + t.date + ' ' + t.drCr + ' ' + t.amount + ' | ' + String(t.narration).slice(0, 70)));
})().catch(e => { console.error(e); process.exit(1); });
