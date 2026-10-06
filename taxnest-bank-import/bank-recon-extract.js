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
  ['BankParserCore', 'UniversalParser', 'BalanceValidator', 'MappingEngine', 'SmartMapping', 'LedgerImport', 'BankReconReview', 'TallyXML'].forEach(function (g) { if (!window[g]) missing.push('script:' + g); });
  if (missing.length) {
    console.error('bank-recon-extract.js: missing ' + missing.join(', ') + ' -- check the HTML has the Step 2 markup and every script tag (balance-validator.js, mapping-engine.js, smart-mapping.js, ledger-import.js, universal-parser.js, bank-recon-review.js, tally-xml-builder.js, bank-parser-core.js).');
    window.BankReconExtract = { start: function () { alert('Setup problem: missing ' + missing.join(', ') + '. See the browser console.'); } };
    return;
  }

  // bank-list.js ids are numeric and can shift if that list is regenerated, so they're kept decoupled from
  // bank-parser-core's stable registry keys. Add one line here for every new bank-specific parser.
  var BANK_ID_TO_PARSER_KEY = { '11': 'kotak_mahindra', '36': 'bandhan' };

  var STAGES = ['Reading PDF', 'Detecting pages', 'Extracting text', 'Identifying statement structure', 'Parsing transactions', 'Normalizing dates and amounts', 'Validating balances', 'Preparing review'];

  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }   // let the progress UI paint between real steps

  /* ---- pdf.js text extraction, grouped into lines by Y (see notes in git history: sort on Y alone, then group
         against each line's anchor, tolerance scaled to text height) ---- */
  async function extractPdfText(file, onPages) {
    if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js did not load (check your internet connection and the CDN script tag)');
    var buf = await file.arrayBuffer();
    var pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    if (onPages) onPages(pdf.numPages);
    var fullText = '', chars = 0;
    for (var p = 1; p <= pdf.numPages; p++) {
      var page = await pdf.getPage(p), content = await page.getTextContent();
      var t = groupTextItemsIntoLines(content.items); chars += t.replace(/\s/g, '').length; fullText += t + '\n';
    }
    return { text: fullText, pages: pdf.numPages, chars: chars };
  }
  function groupTextItemsIntoLines(items) {
    if (!items.length) return '';
    var sorted = items.slice().sort(function (a, b) { return b.transform[5] - a.transform[5]; });
    var groups = [], cur = null;
    sorted.forEach(function (it) {
      var y = it.transform[5], tol = Math.max(2, (it.height || 10) * 0.5);
      if (cur && Math.abs(y - cur.y) <= tol) cur.items.push(it); else { cur = { y: y, items: [it] }; groups.push(cur); }
    });
    return groups.map(function (g) { return g.items.slice().sort(function (a, b) { return a.transform[4] - b.transform[4]; }).map(function (i) { return i.str; }).join(' '); }).join('\n');
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
      statement: statement, vopts: vopts, bankLedger: bank.name, state: state, rawText: ex.text, repair: result.repair || null, repairNotes: (result.repair && result.repair.notes) || [],
      extraction: { pages: ex.pages, chars: ex.chars, layout: result.layout || (parserMode === 'universal' ? 'universal' : 'bank-specific'), usedFallback: !!usedFallback, skippedCount: skipped.length,
        skippedSample: skipped.slice(0, 20).map(function (s) { return (s.reason ? s.reason + ': ' : '') + (s.lines ? s.lines.join(' ') : (s.block ? s.block.lines.join(' ') : '')).slice(0, 140); }) } };
  }
  // "Try the universal parser instead" (offered when a bank-specific parser's result fails validation)
  function rerunUniversal(S) {
    var result = UniversalParser.extractUniversal(S.rawText);
    if (!result.transactions.length) { alert('The universal parser could not find transactions either.'); return; }
    var ses = buildSession({ id: S.bank.id, name: S.bank.name }, S.fileName, result, 'universal', null, { text: S.rawText, pages: S.extraction.pages, chars: S.extraction.chars }, false);
    BankReconReview.open(ses); BankReconReview.persist();
  }

  async function start(bank, file) {
    showStep2();
    var prog = BankReconReview.showProgress(STAGES);
    var fail = function (info) { BankReconReview.showError(info, backToStep1); };
    try {
      prog.set(0); await tick();
      if (file.size > MAX_FILE_MB * 1024 * 1024) return fail({ reason: 'This file is larger than ' + MAX_FILE_MB + ' MB.', solutions: ['Download a statement for a shorter period', 'Split the PDF and import the parts one at a time'] });
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return fail({ reason: 'This does not look like a PDF file.', solutions: ['Choose the PDF statement downloaded from your bank'] });

      prog.set(1); await tick();
      var ex;
      try { ex = await extractPdfText(file, function () { prog.set(2); }); }
      catch (err) {
        var pw = err && (err.name === 'PasswordException' || /password/i.test(err.message || ''));
        return fail({ reason: pw ? 'This PDF is password-protected.' : 'The PDF could not be read.', detail: err && err.message,
          solutions: pw ? ['Open it with the password and save/print a copy without a password', 'Many banks use your customer ID or date of birth as the password'] : ['Try downloading the statement again', 'Try another PDF'] });
      }
      prog.set(3); await tick();
      if (ex.chars < 80) return fail({ title: 'Scanned PDF detected', reason: 'This appears to be a scanned/image-based PDF. OCR extraction is required.', detail: 'OCR is not available in this version, so no data was extracted (nothing was guessed).',
        solutions: ['Download the electronic (text) statement from net banking instead', 'Ask the bank for a digitally generated PDF'] });

      var parserKey = BANK_ID_TO_PARSER_KEY[bank.id], parserMode = 'universal', result = null, usedFallback = false;
      prog.set(4); await tick();
      if (parserKey) {
        try { result = BankParserCore.getParser(parserKey)(ex.text); parserMode = 'bank_specific'; } catch (err) { console.error('Bank-specific parser failed, falling back to universal:', err); result = null; }
        if (!result || !result.transactions || !result.transactions.length) { result = null; usedFallback = true; }
      }
      if (!result) { result = UniversalParser.extractUniversal(ex.text); parserMode = 'universal'; }
      if (!result.transactions.length) return fail({ reason: 'Transaction columns could not be identified.', detail: 'No rows with a date, an amount and a balance were found in ' + ex.pages + ' page(s).', rawText: ex.text,
        solutions: ['Try another PDF (e.g. a different date range)', 'Make sure you selected the right bank', 'Download the extracted text (below) and send it for a parser to be built for this bank'] });

      prog.set(5); await tick();
      prog.set(6); await tick();
      var session = buildSession(bank, file.name, result, parserMode, parserKey, ex, usedFallback);
      prog.set(7); await tick();
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
