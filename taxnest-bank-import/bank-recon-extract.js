// bank-recon-extract.js -- Step 1 -> Step 2 orchestration.
// PDF text extraction (pdf.js) -> bank-specific parser if registered, universal parser otherwise
// -> normalised entries (TXN-000001..., Suspense default) -> balance validation -> BankReconReview.
// Entry point: window.BankReconExtract.start(bank, file), called by bank-recon-landing.js.
(function () {
  'use strict';

  var MAX_FILE_MB = 25;
  var step1El = document.getElementById('continue-btn') && document.getElementById('continue-btn').closest('.sheet-wrap');
  var step2El = document.getElementById('step-2');
  var rootEl = document.getElementById('rv-root');
  var missing = [];
  if (!step1El) missing.push('continue-btn'); if (!step2El) missing.push('step-2'); if (!rootEl) missing.push('rv-root');
  ['BankParserCore', 'UniversalParser', 'PdfLines', 'BankProfiles', 'ExcelImport', 'BalanceValidator', 'MappingEngine', 'SmartMapping', 'LedgerImport', 'BankReconReview', 'TallyXML'].forEach(function (g) { if (!window[g]) missing.push('script:' + g); });
  if (missing.length) {
    console.error('bank-recon-extract.js: missing ' + missing.join(', ') + ' -- check the HTML has the Step 2 markup and every script tag (balance-validator.js, mapping-engine.js, smart-mapping.js, pdf-lines.js, bank-profiles.js, excel-import.js, ledger-import.js, universal-parser.js, bank-recon-review.js, tally-xml-builder.js, bank-parser-core.js).');
    window.BankReconExtract = { start: function () { alert('Setup problem: missing ' + missing.join(', ') + '. See the browser console.'); } };
    return;
  }

  // bank-list.js ids are numeric and can shift if that list is regenerated, so they're kept decoupled from
  // bank-parser-core's stable registry keys. Add one line here for every new bank-specific parser.
  var BANK_ID_TO_PARSER_KEY = { '11': 'kotak_mahindra', '36': 'bandhan', '8': 'icici', '5': 'canara', '301': 'sarvodaya' };   // parsers that list their bank id in parser.meta.bankIds are found automatically; this table is only a backup for older parsers

  var STAGES = ['Reading PDF', 'Detecting pages', 'Extracting text', 'Identifying statement structure', 'Parsing transactions', 'Normalizing dates and amounts', 'Validating balances', 'Preparing review'];

  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }   // let the progress UI paint between real steps

  /* ---- pdf.js text extraction, grouped into lines by Y (see notes in git history: sort on Y alone, then group
         against each line's anchor, tolerance scaled to text height) ---- */
  async function extractPdfText(file, onPages, opts) {
    if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js did not load (check your internet connection and the CDN script tag)');
    var buf = await file.arrayBuffer();
    var pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    if (onPages) onPages(pdf.numPages);
    var plain = [], hinted = [], chars = 0, st = {};
    for (var p = 1; p <= pdf.numPages; p++) {
      var page = await pdf.getPage(p), content = await page.getTextContent();
      var r = PdfLines.groupItemsIntoLines(content.items, st, opts);
      chars += r.plain.replace(/\s/g, '').length; plain.push(r.plain); hinted.push(r.hinted);
    }
    // a bank that wraps the year of the date onto the next line is stitched back together for every parser
    return { text: BankParserCore.fixSplitDates(plain.join('\n') + '\n'), hinted: BankParserCore.fixSplitDates(hinted.join('\n') + '\n'), pages: pdf.numPages, chars: chars };
  }

  function showStep2() { step1El.hidden = true; step2El.hidden = false; window.scrollTo(0, 0); }
  function backToStep1() { step2El.hidden = true; step1El.hidden = false; }
  window.BankReconReview.onBack = backToStep1;

  function toEntries(txns, suspense) {
    var withRefs = BalanceValidator.assignReferences(txns, suspense);
    var dups = BalanceValidator.findPossibleDuplicates(withRefs);
    withRefs.forEach(function (e) { e.parse_confidence = e.confidence; e.flags = []; e.excluded = false; });
    dups.forEach(function (d) { withRefs[d.index].flags.push('possible_duplicate'); });
    return withRefs;
  }

  function buildSession(bank, fileName, result, parserMode, parserKey, ex, usedFallback) {
    var suspense = MappingEngine.SUSPENSE;
    var entries = toEntries(result.transactions, suspense);
    var directionFromMarker = result.directionFromMarker !== undefined ? result.directionFromMarker : entries.every(function (e) { return e.parse_confidence === 'high'; });
    var statement = result.statement || {};
    var vopts = { opening: typeof statement.opening_balance === 'number' ? statement.opening_balance : null, closing: typeof statement.closing_balance === 'number' ? statement.closing_balance : null, directionFromMarker: directionFromMarker };
    var state = MappingEngine.createState(entries, { suspense: suspense });
    MappingEngine.setLedgers(state, [], 'none'); state.ledgersSource = 'none';
    var skipped = result.skipped || [];
    return { bank: { id: bank.id, name: bank.name, parser_mode: parserMode }, fileName: String(fileName).replace(/[^\w.\- ()]/g, '_'), parserMode: parserMode, parserKey: parserKey || null,
      statement: statement, vopts: vopts, bankLedger: bank.name, state: state, rawText: ex.text, hintedText: ex.hinted, repair: result.repair || null, repairNotes: (result.repair && result.repair.notes) || [],
      extraction: { pages: ex.pages, chars: ex.chars, layout: result.layout || (parserMode === 'universal' ? 'universal' : 'bank-specific'), usedFallback: !!usedFallback, skippedCount: skipped.length,
        skippedSample: skipped.slice(0, 20).map(function (s) { return (s.reason ? s.reason + ': ' : '') + (s.lines ? s.lines.join(' ') : (s.block ? s.block.lines.join(' ') : '')).slice(0, 140); }) } };
  }
  // "Try the universal parser instead" (offered when a bank-specific parser's result fails validation)
  function rerunUniversal(S) {
    var result = UniversalParser.extractUniversal(S.hintedText || S.rawText);
    if (!result.transactions.length) { alert('The universal parser could not find transactions either.'); return; }
    var ses = buildSession({ id: S.bank.id, name: S.bank.name }, S.fileName, result, 'universal', null, { text: S.rawText, pages: S.extraction.pages, chars: S.extraction.chars }, false);
    BankReconReview.open(ses); BankReconReview.persist();
  }

  function isSheetFile(file) { return /\.(xlsx|xls|csv|tsv)$/i.test(file.name); }
  /* Excel / CSV: no bank parser needed. The column headers say what each column is (see excel-import.js). */
  async function startSheet(bank, file) {
    showStep2();
    var prog = BankReconReview.showProgress(['Reading the spreadsheet', 'Finding the header row', 'Matching columns', 'Reading transactions', 'Checking balances', 'Preparing review']);
    var fail = function (info) { BankReconReview.showError(info, backToStep1); };
    try {
      prog.set(0); await tick();
      if (typeof XLSX === 'undefined') return fail({ reason: 'The Excel reader did not load.', solutions: ['Check your internet connection and reload the page'] });
      var buf = await file.arrayBuffer(), wb = XLSX.read(buf, { type: 'array', cellDates: false });
      prog.set(2); await tick();
      var ws = wb.Sheets[wb.SheetNames[0]], rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
      prog.set(3); await tick();
      var res = ExcelImport.parseRows(rows);
      if (!res.transactions.length) return fail({ reason: 'Could not read transactions from this file.', detail: res.notes.join(' '), rawText: JSON.stringify(rows.slice(0, 40)),
        solutions: ['Make sure the first sheet holds the statement', 'Keep the header row (Date, Particulars, Debit/Credit or Amount) in the file', 'Or upload the PDF statement instead'] });
      prog.set(4); await tick();
      var result = { transactions: res.transactions, statement: {}, skipped: res.skipped, layout: 'excel', repair: { notes: res.notes.concat(['Columns: ' + Object.keys(res.mapping || {}).filter(function (k) { return k !== '_taken'; }).map(function (k) { return k + '=' + res.mapping[k]; }).join(', ')]) }, directionFromMarker: true };
      prog.set(5); await tick();
      var session = buildSession(bank, file.name, result, 'excel', null, { text: '', pages: 1, chars: 0, hinted: '' }, false);
      prog.set(6); await tick(); if (window.TaxNestSound) TaxNestSound.play('extracted');
      BankReconReview.open(session); BankReconReview.persist();
    } catch (err) {
      console.error(err); fail({ reason: 'Something went wrong while reading the spreadsheet.', detail: err && err.message, solutions: ['Try saving the file again as .xlsx or .csv'] });
    }
  }

  async function start(bank, file) {
    if (isSheetFile(file)) return startSheet(bank, file);
    showStep2();
    var prog = BankReconReview.showProgress(STAGES);
    var fail = function (info) { BankReconReview.showError(info, backToStep1); };
    try {
      prog.set(0); await tick();
      if (file.size > MAX_FILE_MB * 1024 * 1024) return fail({ reason: 'This file is larger than ' + MAX_FILE_MB + ' MB.', solutions: ['Download a statement for a shorter period', 'Split the PDF and import the parts one at a time'] });
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return fail({ reason: 'This does not look like a PDF file.', solutions: ['Choose the PDF statement downloaded from your bank'] });

      prog.set(1); await tick();
      var ex;
      // Which parser handles this bank? (1) a parser file that lists this bank id, (2) a parser that recognises the statement text,
      // (3) the older id table below. Choosing by bank id first means a registered parser is never silently skipped.
      var parserKey = BANK_ID_TO_PARSER_KEY[bank.id];
      var preParser = BankParserCore.findParser(bank.id, '');
      try { ex = await extractPdfText(file, function () { prog.set(2); }, { centered: !!(preParser && preParser.centered) }); }
      catch (err) {
        var pw = err && (err.name === 'PasswordException' || /password/i.test(err.message || ''));
        return fail({ reason: pw ? 'This PDF is password-protected.' : 'The PDF could not be read.', detail: err && err.message,
          solutions: pw ? ['Open it with the password and save/print a copy without a password', 'Many banks use your customer ID or date of birth as the password'] : ['Try downloading the statement again', 'Try another PDF'] });
      }
      prog.set(3); await tick();
      if (ex.chars < 80) return fail({ title: 'Scanned PDF detected', reason: 'This appears to be a scanned/image-based PDF. OCR extraction is required.', detail: 'OCR is not available in this version, so no data was extracted (nothing was guessed).',
        solutions: ['Download the electronic (text) statement from net banking instead', 'Ask the bank for a digitally generated PDF'] });

      var parserMode = 'universal', result = null, usedFallback = false, parserLabel = 'Universal parser', fallbackReason = '';
      prog.set(4); await tick();
      var parser = BankParserCore.findParser(bank.id, ex.text) || (parserKey && BankParserCore.hasSpecificParser(parserKey) ? BankParserCore.getParser(parserKey) : null);
      if (parser) {
        parserLabel = (parser.meta && parser.meta.label) || parserKey || 'Bank parser';
        try { result = parser(parser.wantsHints ? ex.hinted : ex.text); parserMode = 'bank_specific'; }
        catch (err) { fallbackReason = 'parser error: ' + (err && err.message); console.error('TaxNest: ' + parserLabel + ' failed, using universal parser.', err); result = null; }
        if (result && (!result.transactions || !result.transactions.length)) { fallbackReason = 'parser found no transactions'; result = null; }
        if (result) { usedFallback = false; console.info('TaxNest: used ' + parserLabel + ' (' + result.transactions.length + ' rows)'); }
        else { usedFallback = true; console.warn('TaxNest: ' + parserLabel + ' could not read this statement (' + fallbackReason + '). Using universal parser.'); }
      } else {
        console.info('TaxNest: no bank-specific parser for bank id ' + bank.id + ' or this statement text. Using universal parser.');
      }
      if (!result) { result = UniversalParser.extractUniversal(ex.hinted); parserMode = 'universal'; parserLabel = 'Universal parser'; }
      if (!result.transactions.length) return fail({ reason: 'Transaction columns could not be identified.', detail: 'No rows with a date, an amount and a balance were found in ' + ex.pages + ' page(s).', rawText: ex.text,
        solutions: ['Try another PDF (e.g. a different date range)', 'Make sure you selected the right bank', 'Download the extracted text (below) and send it for a parser to be built for this bank'] });

      prog.set(5); await tick();
      prog.set(6); await tick();
      var session = buildSession(bank, file.name, result, parserMode, parserKey, ex, usedFallback);
      session.parserLabel = parserLabel; session.fallbackReason = fallbackReason;
      prog.set(7); await tick(); if (window.TaxNestSound) TaxNestSound.play('extracted');
      BankReconReview.open(session);
      BankReconReview.persist();
    } catch (err) {
      console.error(err);
      fail({ reason: 'Something went wrong while processing this statement.', detail: err && err.message, solutions: ['Reload the page and try again', 'If it keeps happening, download the extracted text and send it for review'] });
    }
  }

  /* ---- resume a saved working copy (spec: don't lose the user's work) ---- */
  function offerResume() {
    var info = BankReconReview.resumeInfo(); if (!info) return;
    var host = document.querySelector('#step-1-resume'); if (host) return;
    var box = document.createElement('div'); box.className = 'resume'; box.id = 'step-1-resume';
    var when = new Date(info.savedAt).toLocaleString('en-IN');
    box.appendChild(document.createTextNode('Saved statement in this browser: ' + (info.bank || 'bank') + ', ' + info.count + ' transactions (' + when + ').'));
    var go = document.createElement('button'); go.type = 'button'; go.className = 'btn-s'; go.textContent = 'Continue where I left off';
    go.addEventListener('click', function () {
      var s = info.snapshot, state = MappingEngine.createState(s.state.entries, { suspense: s.state.suspense });
      state.ledgers = s.state.ledgers || []; state.ledgersSource = s.state.ledgersSource || 'none'; state.audit = s.state.audit || []; state.aiThreshold = s.state.aiThreshold || state.aiThreshold;
      showStep2();
      BankReconReview.open({ bank: s.bank, fileName: s.fileName, parserMode: s.parserMode, parserKey: s.parserKey, statement: s.statement || {}, vopts: s.vopts || {}, bankLedger: s.bankLedger, state: state, rawText: null, extraction: s.extraction || {} });
    });
    var del = document.createElement('button'); del.type = 'button'; del.className = 'btn-s'; del.textContent = 'Discard'; del.addEventListener('click', function () { BankReconReview.clearSaved(); box.remove(); });
    box.appendChild(go); box.appendChild(del);
    var lede = document.querySelector('.lede'); if (lede && lede.parentNode) lede.parentNode.insertBefore(box, lede.nextSibling);
  }
  offerResume();

  window.BankReconExtract = { start: start, rerunUniversal: rerunUniversal };
})();
