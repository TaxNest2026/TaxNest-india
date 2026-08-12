/**
 * TaxNest — Column Mapping, Format Detection & Reconciliation Proof Engine
 * ==========================================================================
 * File:   taxnest-mapping-engine.js
 * Status: NEW file, nothing existing edited to build it.
 *
 * INTEGRATION — only these two changes go into index.html:
 *
 *   1. In <head>, after the Chart.js line:
 *        <script src="taxnest-mapping-engine.js"></script>
 *
 *   2. Separate mode — inside handle2BFile(), change:
 *        file2BData = parse2BWorkbook(wb);
 *      to:
 *        file2BData = TaxNestMapper.smartParse2BFile(wb, parse2BWorkbook);
 *
 *      Combined mode — inside handleCombinedFile(), replace the sheet-
 *      reading/mapping block with:
 *        const combined = await TaxNestMapper.handleCombinedWorkbook(wb, showColMappingUI);
 *        filePRData = combined.prRows;
 *        file2BData = combined.file2BData;
 *
 *      Reconciliation proof table — after runReconciliation() has set
 *      recoData, anywhere you want it (e.g. inside exportFullReport(),
 *      or on-screen):
 *        const proof = TaxNestMapper.buildReconciliationProof(recoData);
 *        // Excel:  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(TaxNestMapper.proofRowsToSheetData(proof.rows)), 'Reconciliation Proof');
 *        // Screen: someContainer.innerHTML = TaxNestMapper.renderProofTableHTML(proof.rows);
 *
 * Everything else (parse2BWorkbook, parse2BSheet, parseTallyPR,
 * handlePRFile, detectPRColumns, parsePRRows, detectG2AColumns,
 * parseCustomG2ARows, showColMappingUI) stays exactly as it is — this
 * file only calls into showColMappingUI() as an optional low-confidence
 * fallback; everything else runs standalone.
 *
 * Zero dependencies at the core (works via require() in Node for testing);
 * smartParse2BFile()/handleCombinedWorkbook() use the page's already-
 * loaded global `XLSX` (SheetJS), same as the rest of index.html.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TaxNestMapper = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var VERSION = '1.0.0';

  // ---------------------------------------------------------------
  // 1. CANONICAL FIELD REGISTRY
  // ---------------------------------------------------------------
  var FIELDS = {
    invoiceNumber:  { required: true,  type: 'text'   },
    invoiceDate:    { required: true,  type: 'date'   },
    supplierGSTIN:  { required: true,  type: 'gstin'  },
    taxableValue:   { required: true,  type: 'amount' },
    supplierName:   { required: false, type: 'text'   },
    igst:           { required: false, type: 'amount' },
    cgst:           { required: false, type: 'amount' },
    sgst:           { required: false, type: 'amount' },
    cess:           { required: false, type: 'amount' },
    invoiceValue:   { required: false, type: 'amount' },
    voucherType:    { required: false, type: 'text'   },
    documentType:   { required: false, type: 'text'   },
    creditNoteNo:   { required: false, type: 'text'   },
    creditNoteDate: { required: false, type: 'date'   },
    reverseCharge:  { required: false, type: 'bool'   },
    placeOfSupply:  { required: false, type: 'text'   },
    financialYear:  { required: false, type: 'text'   },
    taxPeriod:      { required: false, type: 'text'   },
    hsn:            { required: false, type: 'text'   },
    rate:           { required: false, type: 'number' },
    quantity:       { required: false, type: 'number' },
    taxAmount:      { required: false, type: 'amount' },
    totalAmount:    { required: false, type: 'amount' }
  };

  // ---------------------------------------------------------------
  // 2. SYNONYM DICTIONARY
  //    Entries marked NEW were added after inspecting the real
  //    template + third-party (502) files — see chat reply.
  // ---------------------------------------------------------------
  var SYNONYMS = {
    invoiceNumber: ['invoice no','invoice number','invoice no.','bill no','bill no.',
      'bill number','voucher no','voucher no.','voucher number','document no','ref no',
      'reference','reference no','invoice#','invoice_id','inv no','inv. no.',
      'bill ref','bill ref no','invoice ref','2a invoice no.'],
    invoiceDate: ['invoice date','invoice dt','bill date','voucher date','date',
      'txn date','transaction date','document date','doc date','inv date','2a invoice date'],
    supplierGSTIN: ['gstin of supplier','gstin/uin of supplier','supplier gstin','gstin',
      'gst no','gst number','party gstin','vendor gstin','gstin no','gstin/uin',
      'gst reg no','tax registration no','gstin of party','2a gstn no.','gstin/uin of party'],
    supplierName: ['trade/legal name of supplier','trade/legal name','supplier name',
      'party name','vendor name','particulars','account name','ledger name','party',
      'name','2a name of supplier'],
    taxableValue: ['taxable value','taxable value (₹)','taxable amount','basic amount',
      'assessable value','taxable amt','taxable','basic amt','2a taxable',
      'tax val','tax. val','taxval','tax value'],                                // NEW (502 file)
    igst: ['integrated tax','integrated tax (₹)','igst amount','igst amt','igst',
      'integrated gst','2a igst'],
    cgst: ['central tax','central tax (₹)','cgst amount','cgst amt','cgst','2a cgst'],
    sgst: ['state/ut tax','state/ut tax (₹)','state tax','sgst amount','sgst amt',
      'sgst','utgst','ut tax','2a sgst'],
    cess: ['cess','cess (₹)','cess amount','compensation cess','2a cess'],
    invoiceValue: ['invoice value','invoice value (₹)','invoice value(₹)',
      'total invoice value','gross amount','total amount','net amount','value'],
    voucherType: ['vch type','voucher type','vch.type'],
    documentType: ['invoice type','document type','doc type','invoice sub-type'],
    creditNoteNo: ['note number','credit note no','cn no','cn number','note no'],
    creditNoteDate: ['note date','credit note date','cn date'],
    reverseCharge: ['supply attract reverse charge','reverse charge','rcm','is rcm',
      'reverse charge applicable','rev. chrg','rev chrg','revchrg'],              // NEW (502 file)
    placeOfSupply: ['place of supply','pos','supply state','state of supply'],
    financialYear: ['financial year','fy','year'],
    taxPeriod: ['tax period','gstr-1/iff/gstr-5 period','period','filing period',
      'gstr-1/1a/iff/gstr-5 period','gstr 1 period','gstr1 period'],
    hsn: ['hsn','hsn code','hsn/sac','sac'],
    rate: ['rate (%)','tax rate','gst rate','rate','applicable % of tax rate'],
    quantity: ['qty','quantity','no of units'],
    taxAmount: ['tax amount','total tax','total tax amount'],
    totalAmount: ['total amount','grand total','total']
  };

  // ---------------------------------------------------------------
  // 3. NORMALIZATION  (strips ANY non-alphanumeric — handles ★ ◆ etc.
  //    which the existing PR-side normalizer in index.html does not)
  // ---------------------------------------------------------------
  function lower(h) { return String(h == null ? '' : h).trim().toLowerCase(); }
  function noSpecial(h) { return lower(h).replace(/[^a-z0-9]/g, ''); }

  // ---------------------------------------------------------------
  // 4. PATTERN RECOGNITION
  // ---------------------------------------------------------------
  var GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
  var DATE_RES = [
    /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/,
    /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/,
    /^\d{1,2}[\/\-\s][A-Za-z]{3}[\/\-\s]\d{4}$/
  ];
  function looksLikeGSTIN(v) { return GSTIN_RE.test(String(v == null ? '' : v).trim().toUpperCase()); }
  function looksLikeDate(v) {
    if (v instanceof Date) return true;
    var s = String(v == null ? '' : v).trim();
    if (!s) return false;
    for (var i = 0; i < DATE_RES.length; i++) if (DATE_RES[i].test(s)) return true;
    var n = parseFloat(s);
    return !isNaN(n) && n > 25000 && n < 60000;
  }
  function looksLikeAmount(v) {
    if (typeof v === 'number') return true;
    var s = String(v == null ? '' : v).replace(/[₹,\s]/g, '');
    return s !== '' && !isNaN(parseFloat(s));
  }
  function toNumber(v) {
    if (typeof v === 'number') return v;
    var s = String(v == null ? '' : v).replace(/[₹,\s]/g, '');
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  // ---------------------------------------------------------------
  // 5. SCORING + mapColumns  (0-100 score; >=90 auto-applies per brief:
  //    "if confidence is below 90%, only then ask user")
  // ---------------------------------------------------------------
  function scoreHeader(field, header, colIdx, sampleRows) {
    var syns = SYNONYMS[field] || [];
    var hRaw = lower(header);
    if (hRaw) {
      if (syns.indexOf(hRaw) !== -1) return 100;
      var hNorm = noSpecial(header);
      for (var i = 0; i < syns.length; i++) if (noSpecial(syns[i]) === hNorm) return 96;
      for (var j = 0; j < syns.length; j++) {
        var sNorm = noSpecial(syns[j]);
        if (hNorm.length > 3 && sNorm.length > 3 &&
            (hNorm.indexOf(sNorm) !== -1 || sNorm.indexOf(hNorm) !== -1)) return 85;
      }
    }
    // pattern/type fallback — mainly rescues GSTIN columns with odd headers
    var type = FIELDS[field] ? FIELDS[field].type : null;
    if (!type || !sampleRows || !sampleRows.length) return 0;
    var vals = [], k;
    for (k = 0; k < sampleRows.length; k++) {
      var v = sampleRows[k][colIdx];
      if (v !== undefined && v !== null && v !== '') vals.push(v);
    }
    if (!vals.length) return 0;
    var hits = 0;
    for (k = 0; k < vals.length; k++) {
      if (type === 'gstin' && looksLikeGSTIN(vals[k])) hits++;
      else if (type === 'date' && looksLikeDate(vals[k])) hits++;
      else if (type === 'amount' && looksLikeAmount(vals[k])) hits++;
    }
    var ratio = hits / vals.length;
    if (type === 'gstin' && ratio >= 0.8) return 93;
    return 0;
  }

  function mapColumns(headers, sampleRows) {
    sampleRows = sampleRows || [];
    var used = {}, result = {}, fieldNames = Object.keys(FIELDS);
    for (var f = 0; f < fieldNames.length; f++) {
      var field = fieldNames[f], best = null;
      for (var c = 0; c < headers.length; c++) {
        if (used[c]) continue;
        var score = scoreHeader(field, headers[c], c, sampleRows);
        if (score > 0 && (!best || score > best.score)) best = { column: headers[c], colIdx: c, score: score };
      }
      if (best) {
        result[field] = {
          column: best.column, colIdx: best.colIdx, score: best.score,
          confidence: best.score >= 95 ? 'HIGH' : best.score >= 90 ? 'MEDIUM' : best.score >= 80 ? 'LOW' : 'VERY_LOW',
          autoApply: best.score >= 90, needsReview: best.score < 90
        };
        used[best.colIdx] = true;
      } else {
        result[field] = { column: null, colIdx: -1, score: 0, confidence: 'MISSING', autoApply: false, needsReview: FIELDS[field].required };
      }
    }
    return result;
  }

  function allRequiredConfident(mapping) {
    var names = Object.keys(FIELDS);
    for (var i = 0; i < names.length; i++) {
      var f = names[i];
      if (FIELDS[f].required && (!mapping[f] || !mapping[f].autoApply)) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------
  // 6. SMART HEADER-ROW FINDER  (doc brief Part 6 — headers not on row 1)
  // ---------------------------------------------------------------
  var HEADER_SIGNALS = [/gstin/i, /invoice/i, /inv\.?\s*no/i, /bill\s*no/i, /voucher/i,
    /particulars/i, /supplier/i, /party/i, /igst/i, /cgst/i, /sgst/i, /taxable/i,
    /amount/i, /sr\.?\s*no/i, /rate/i, /tax\.?\s*val/i];

  function findHeaderRow(rawRows, maxScan) {
    maxScan = Math.min(maxScan || 20, rawRows.length);
    var best = -1, bestHits = 0;
    for (var i = 0; i < maxScan; i++) {
      var row = rawRows[i] || [], hits = 0;
      for (var c = 0; c < row.length; c++) {
        var cell = row[c] == null ? '' : String(row[c]);
        if (!cell) continue;
        for (var s = 0; s < HEADER_SIGNALS.length; s++) { if (HEADER_SIGNALS[s].test(cell)) { hits++; break; } }
      }
      if (hits >= 3 && hits > bestHits) { best = i; bestHits = hits; }
    }
    return best; // -1 = not found, caller falls back to row 0
  }

  // Handles the official-portal-style 2-row merged header (group label on
  // row N spanning several BLANK cells, real sub-headers filling those exact
  // blanks on row N+1) — see GSTR-2B critical parsing note. Signal used is
  // structural (where the blanks are), not content-based, so it can't be
  // confused with an ordinary data row sitting right below a clean header
  // (a data row rarely fills the *exact* blank positions of the row above).
  function mergeIfSplitHeader(rawRows, headerIdx) {
    var row0 = rawRows[headerIdx] || [];
    var row1 = rawRows[headerIdx + 1] || [];
    var len = Math.max(row0.length, row1.length);
    var row0Blanks = 0, fillsBlank = 0, row1NonBlank = 0;
    for (var i = 0; i < len; i++) {
      var a = row0[i] == null || row0[i] === '' ? '' : String(row0[i]).trim();
      var b = row1[i] == null || row1[i] === '' ? '' : String(row1[i]).trim();
      if (!a) row0Blanks++;
      if (b) { row1NonBlank++; if (!a) fillsBlank++; }
    }
    var fillRatio = row1NonBlank ? fillsBlank / row1NonBlank : 0;
    var row1LooksLikeData = row1.some(function (c) { return looksLikeGSTIN(c) || looksLikeDate(c); });
    if (row0Blanks >= 2 && fillRatio >= 0.5 && !row1LooksLikeData) {
      var merged = [];
      for (var j = 0; j < len; j++) {
        var av = row0[j] ? String(row0[j]).trim() : '', bv = row1[j] ? String(row1[j]).trim() : '';
        // row1 is the more specific sub-header when both are present (row0
        // is usually just the merged-cell group label, e.g. "Invoice Details"
        // spanning "Invoice number"/"type"/"Date"/"Value" beneath it)
        merged.push(bv || av);
      }
      return { headers: merged, dataStart: headerIdx + 2 };
    }
    return { headers: row0.map(function (c) { return c == null ? '' : c; }), dataStart: headerIdx + 1 };
  }

  // Rebuilds array-of-objects keyed by header (what sheet_to_json's default
  // mode would produce, IF it had used the correct header row) so existing
  // functions like detectPRColumns/parsePRRows can consume it unmodified.
  function rowsToObjects(rawRows, headers, dataStartRow) {
    var out = [];
    for (var r = dataStartRow; r < rawRows.length; r++) {
      var row = rawRows[r] || [];
      var obj = {}, any = false;
      for (var c = 0; c < headers.length; c++) {
        var key = headers[c] || ('__col' + c);
        var val = row[c] == null ? '' : row[c];
        obj[key] = val;
        if (val !== '') any = true;
      }
      if (any) out.push(obj);
    }
    return out;
  }

  function readGSTSheet(rawRows) {
    var headerIdx = findHeaderRow(rawRows, 20);
    if (headerIdx === -1) headerIdx = 0;
    var merged = mergeIfSplitHeader(rawRows, headerIdx);
    var sampleRows = rawRows.slice(merged.dataStart, merged.dataStart + 15);
    var mapping = mapColumns(merged.headers, sampleRows);
    return { headerRowIndex: headerIdx, dataStartRow: merged.dataStart, headers: merged.headers, mapping: mapping };
  }

  // ---------------------------------------------------------------
  // 7. DATE NORMALIZATION  (self-contained; mirrors excelDateToString's
  //    output format so results stay display-compatible with fd())
  // ---------------------------------------------------------------
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  function normalizeDateStr(v) {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date) return pad2(v.getDate()) + '/' + pad2(v.getMonth() + 1) + '/' + v.getFullYear();
    var s = String(v).trim();
    if (!s) return '';
    var dmy = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(s);
    if (dmy) return pad2(dmy[1]) + '/' + pad2(dmy[2]) + '/' + dmy[3];
    var iso = /^(\d{4})[\/\-](\d{2})[\/\-](\d{2})/.exec(s);
    if (iso) return iso[3] + '/' + iso[2] + '/' + iso[1];
    var mon = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    var dmy2 = /^(\d{1,2})[\/\-\s]([A-Za-z]{3})[\/\-\s](\d{4})$/.exec(s);
    if (dmy2 && mon[dmy2[2]]) return pad2(dmy2[1]) + '/' + mon[dmy2[2]] + '/' + dmy2[3];
    var n = parseFloat(s);
    if (!isNaN(n) && n > 25000 && n < 60000) {
      var d = new Date(Math.round((n - 25569) * 86400 * 1000));
      return pad2(d.getUTCDate()) + '/' + pad2(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear();
    }
    return s;
  }

  // ---------------------------------------------------------------
  // 8. GENERIC ROW PARSER  (row-objects + mapping -> canonical invoice
  //    records, same shape as the existing parse2BSheet() output)
  // ---------------------------------------------------------------
  var SKIP_ROW_PATTERNS = [/^total/i, /^grand total/i, /^sub.?total/i, /^summary/i,
    /^s\.?no\.?$/i, /^sr\.?\s*no/i, /^note:/i, /^\*/];
  function looksLikeSkipRow(row) {
    var vals = Object.keys(row).slice(0, 5).map(function (k) { return String(row[k] || '').trim(); });
    for (var i = 0; i < vals.length; i++) {
      if (!vals[i]) continue;
      for (var p = 0; p < SKIP_ROW_PATTERNS.length; p++) if (SKIP_ROW_PATTERNS[p].test(vals[i])) return true;
    }
    return false;
  }

  function parseInvoiceRows(rowObjects, mapping, opts) {
    opts = opts || {};
    var out = [];
    function get(row, field) {
      var m = mapping[field];
      if (!m || !m.column) return '';
      var v = row[m.column];
      return v === undefined || v === null ? '' : v;
    }
    for (var i = 0; i < rowObjects.length; i++) {
      var row = rowObjects[i];
      if (looksLikeSkipRow(row)) continue; // Total / Grand Total / Subtotal / footer rows
      var gstin = String(get(row, 'supplierGSTIN') || '').trim().toUpperCase().replace(/\s/g, '');
      var invoice = String(get(row, 'invoiceNumber') || '').trim();
      var igst = toNumber(get(row, 'igst')), cgst = toNumber(get(row, 'cgst'));
      var sgst = toNumber(get(row, 'sgst')), cess = toNumber(get(row, 'cess'));
      if (!invoice && (igst + cgst + sgst + cess) === 0) continue; // skip blank rows
      var rcRaw = String(get(row, 'reverseCharge') || 'N').trim().toUpperCase();
      var taxable = toNumber(get(row, 'taxableValue'));
      var invoiceValue = toNumber(get(row, 'invoiceValue')) || (taxable + igst + cgst + sgst + cess);
      out.push({
        gstin: gstin, supplier: String(get(row, 'supplierName') || '').trim(), invoice: invoice,
        invType: String(get(row, 'documentType') || 'R').trim(),
        date: normalizeDateStr(get(row, 'invoiceDate')), invoiceValue: invoiceValue,
        placeOfSupply: String(get(row, 'placeOfSupply') || '').trim(),
        reverseCharge: rcRaw === 'Y' || rcRaw === 'YES' || rcRaw === 'TRUE',
        taxable: taxable, igst: igst, cgst: cgst, sgst: sgst, cess: cess,
        totalTax: igst + cgst + sgst + cess, itcAvailable: true,
        source: opts.source || 'THIRD_PARTY', sheet: opts.sheetLabel || 'B2B'
      });
    }
    return out;
  }

  // ---------------------------------------------------------------
  // 9. WORKBOOK-LEVEL ORCHESTRATION
  //    sheetsData = [{ name: 'b2b', rawRows: [[...],[...]] }, ...]
  //    (caller extracts rawRows via SheetJS header:1 mode — this stays
  //    dependency-free / Node-testable)
  // ---------------------------------------------------------------
  var IGNORE_SHEET_NAMES = /^(docs?|guide|instructions?|read.?me|help|isd|tds|tcs|summary|itc.*(available|not available|reversal|rejected))$/i;

  function detectWorkbookFormat(sheetNames) {
    var hasExactB2B = sheetNames.indexOf('B2B') !== -1; // official portal capitalizes exactly 'B2B'
    var hasReadMe = sheetNames.some(function (n) { return /^read\s*me$/i.test(String(n).trim()); });
    if (hasExactB2B || hasReadMe) return 'OFFICIAL_GST_PORTAL';
    var hasLowerB2B = sheetNames.some(function (n) { return /^b2b$/i.test(String(n).trim()); });
    var hasGstrLike = sheetNames.some(function (n) { return /gstr.?2a|gstr.?2b|cdnr|b2ba/i.test(String(n).trim()); });
    if (hasLowerB2B || hasGstrLike) return 'THIRD_PARTY_GST_SOFTWARE';
    return 'UNKNOWN';
  }

  function pickBestSheet(sheetsData) {
    var best = null, bestScore = -1;
    for (var i = 0; i < sheetsData.length; i++) {
      var sd = sheetsData[i];
      if (IGNORE_SHEET_NAMES.test(String(sd.name).trim())) continue;
      var info = readGSTSheet(sd.rawRows);
      var score = 0, names = Object.keys(FIELDS);
      for (var f = 0; f < names.length; f++) {
        if (FIELDS[names[f]].required && info.mapping[names[f]] && info.mapping[names[f]].autoApply) score += 25;
      }
      if (/^b2b$/i.test(String(sd.name).trim())) score += 10;
      if (score > bestScore) { bestScore = score; best = { name: sd.name, info: info, rawRows: sd.rawRows, score: score }; }
    }
    return best;
  }

  function extractMetadata(sheetsData) {
    var meta = {};
    for (var s = 0; s < sheetsData.length && !(meta.gstin && meta.name); s++) {
      var rows = sheetsData[s].rawRows.slice(0, 10);
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r] || [];
        for (var c = 0; c < row.length; c++) {
          var cell = row[c] == null ? '' : String(row[c]).trim();
          if (!cell) continue;
          var next = row[c + 1] == null ? '' : String(row[c + 1]).trim();
          if (!meta.gstin && /gstin/i.test(cell) && looksLikeGSTIN(next)) meta.gstin = next.toUpperCase();
          if (!meta.gstin && looksLikeGSTIN(cell)) meta.gstin = cell.toUpperCase();
          if (!meta.name && /^name\s*:?$/i.test(cell) && next) meta.name = next;
          if (!meta.period && /^year\s*:?$/i.test(cell) && next) meta.period = next;
        }
      }
    }
    return meta;
  }

  // Main entry point for Separate mode's File-1 slot: given sheetsData for
  // a NON-official workbook, produces {b2b, cdn, impg, meta} — the exact
  // shape parse2BWorkbook() already returns, so it's a drop-in alternative.
  function parseThirdPartyWorkbook(sheetsData) {
    var meta = extractMetadata(sheetsData);
    var best = pickBestSheet(sheetsData);
    var b2b = [];
    if (best) {
      var rows = rowsToObjects(best.rawRows, best.info.headers, best.info.dataStartRow);
      b2b = parseInvoiceRows(rows, best.info.mapping, { source: 'THIRD_PARTY', sheetLabel: best.name });
    }
    var cdn = [];
    var cdnSheet = sheetsData.filter(function (s) { return /cdnr?$/i.test(String(s.name).trim()); })[0];
    if (cdnSheet) {
      var cdnInfo = readGSTSheet(cdnSheet.rawRows);
      if (cdnInfo.mapping.invoiceNumber && cdnInfo.mapping.invoiceNumber.column) {
        var cdnRows = rowsToObjects(cdnSheet.rawRows, cdnInfo.headers, cdnInfo.dataStartRow);
        cdn = parseInvoiceRows(cdnRows, cdnInfo.mapping, { source: 'THIRD_PARTY', sheetLabel: cdnSheet.name });
      }
    }
    return { b2b: b2b, cdn: cdn, impg: [], meta: meta, matchedSheet: best ? best.name : null };
  }

  // =================================================================
  // 10. WHOLE-WORKFLOW ENTRY POINTS
  //     These are the ONLY two calls index.html needs to make. Each
  //     one does everything internally (reading sheets, mapping,
  //     confidence-check) using the global `XLSX` object that's
  //     already loaded on the page by the time these run.
  // =================================================================

  // Separate mode, File-1 slot. Replaces:  file2BData = parse2BWorkbook(wb);
  // with:                                   file2BData = TaxNestMapper.smartParse2BFile(wb, parse2BWorkbook);
  // parse2BWorkbook (yours, untouched) still runs whenever the official
  // portal format is detected — this only adds a second, additive path.
  function smartParse2BFile(wb, fallbackFn) {
    var format = detectWorkbookFormat(wb.SheetNames);
    if (format !== 'THIRD_PARTY_GST_SOFTWARE') return fallbackFn ? fallbackFn(wb) : { b2b: [], cdn: [], impg: [], meta: {} };
    var sheetsData = wb.SheetNames.map(function (name) {
      return { name: name, rawRows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false }) };
    });
    var result = parseThirdPartyWorkbook(sheetsData);
    if (!result.b2b.length) return fallbackFn ? fallbackFn(wb) : result; // safety net if nothing usable found
    return result;
  }

  // Field-key translation so the existing showColMappingUI() (built around
  // the short gstin/supplier/invoice/... keys) can still be reused as the
  // low-confidence fallback without any changes to it.
  var LONG_TO_SHORT = { supplierGSTIN: 'gstin', supplierName: 'supplier', invoiceNumber: 'invoice',
    invoiceDate: 'date', taxableValue: 'taxable', igst: 'igst', cgst: 'cgst', sgst: 'sgst', cess: 'cess' };
  function toShortMapping(longMapping) {
    var out = {};
    Object.keys(LONG_TO_SHORT).forEach(function (lk) {
      var m = longMapping[lk];
      out[LONG_TO_SHORT[lk]] = m && m.column ? { col: m.column, confidence: m.confidence } : { col: null, confidence: 'MISSING' };
    });
    return out;
  }
  function toLongMapping(shortMapping) {
    var out = {};
    Object.keys(LONG_TO_SHORT).forEach(function (lk) {
      var sk = LONG_TO_SHORT[lk], m = shortMapping[sk];
      out[lk] = m && m.col ? { column: m.col, score: 100, confidence: m.confidence || 'MANUAL', autoApply: true }
                            : { column: null, score: 0, confidence: 'MISSING', autoApply: false };
    });
    return out;
  }

  // Combined mode, both sheets. Replaces the entire sheet-reading /
  // mapping block in handleCombinedFile() with:
  //   const combined = await TaxNestMapper.handleCombinedWorkbook(wb, showColMappingUI);
  //   filePRData = combined.prRows;
  //   file2BData = combined.file2BData;
  // Falls back to your existing showColMappingUI() modal — untouched —
  // only when a sheet's required fields aren't confidently detected.
  async function handleCombinedWorkbook(wb, showColMappingUIFn) {
    var prSheetName = wb.SheetNames[0], g2aSheetName = wb.SheetNames[1];
    var prRaw = XLSX.utils.sheet_to_json(wb.Sheets[prSheetName], { header: 1, defval: '', raw: false });
    var g2aRaw = XLSX.utils.sheet_to_json(wb.Sheets[g2aSheetName], { header: 1, defval: '', raw: false });
    var prInfo = readGSTSheet(prRaw), g2aInfo = readGSTSheet(g2aRaw);

    var prMapping = prInfo.mapping;
    if (!allRequiredConfident(prMapping) && showColMappingUIFn) {
      var prShort = await showColMappingUIFn(prInfo.headers.filter(Boolean), toShortMapping(prMapping), 'Column Mapping — Purchase Register (Sheet 1)');
      prMapping = toLongMapping(prShort);
    }
    var prRows = rowsToObjects(prRaw, prInfo.headers, prInfo.dataStartRow);
    var prParsed = parseInvoiceRows(prRows, prMapping, { source: 'PR', sheetLabel: prSheetName });

    var g2aMapping = g2aInfo.mapping;
    if (!allRequiredConfident(g2aMapping) && showColMappingUIFn) {
      var g2aShort = await showColMappingUIFn(g2aInfo.headers.filter(Boolean), toShortMapping(g2aMapping), 'Column Mapping — GSTR-2A / 2B (Sheet 2)');
      g2aMapping = toLongMapping(g2aShort);
    }
    var g2aRows = rowsToObjects(g2aRaw, g2aInfo.headers, g2aInfo.dataStartRow);
    var g2aParsed = parseInvoiceRows(g2aRows, g2aMapping, { source: 'COMBINED', sheetLabel: g2aSheetName });

    return { prRows: prParsed, file2BData: { b2b: g2aParsed, cdn: [], impg: [], meta: {} } };
  }

  // =================================================================
  // 11. RECONCILIATION CONFIDENCE / MATHEMATICAL PROOF TABLE
  //     Input: recoData — the object performRecon() already returns.
  //     Base = Books. Bridges to the GSTR-2B total category by category,
  //     with the residual shown (not hidden) so a real problem still
  //     surfaces instead of being silently forced to zero.
  // =================================================================
  function buildReconciliationProof(recoData) {
    var s = recoData.summary || {};
    var creditOnly = 0, debitOnly = 0;
    (recoData.creditNotes || []).forEach(function (r) {
      if (String(r.noteType || '').toUpperCase() === 'D') debitOnly += (r.totalTax || 0);
      else creditOnly += (r.totalTax || 0);
    });
    var mismatchAdj = 0;
    (recoData.mismatch || []).forEach(function (m) {
      mismatchAdj += ((m.g2a && m.g2a.totalTax) || 0) - ((m.pr && m.pr.totalTax) || 0);
    });

    var booksTotal = s.totalPRTax || 0;
    var addNotInBooks = s.g2aOnlyTax || 0;
    var lessNotIn2B = s.prOnlyTax || 0;
    var beforeRoundoff = booksTotal + addNotInBooks - lessNotIn2B - creditOnly + debitOnly + mismatchAdj;
    var netGSTR2B = (s.totalG2ATax || 0) - creditOnly + debitOnly;
    var roundOff = netGSTR2B - beforeRoundoff;
    var adjustedBooks = beforeRoundoff + roundOff;

    var rows = [
      { label: 'Books Purchase Total (Purchase Register)', amount: booksTotal, kind: 'base' },
      { label: 'Add: Invoices in GSTR-2B, missing in Books', amount: addNotInBooks, kind: 'add' },
      { label: 'Less: Invoices in Books, missing in GSTR-2B', amount: -lessNotIn2B, kind: 'less' },
      { label: 'Less: Credit Notes (GSTR-2B)', amount: -creditOnly, kind: 'less' },
      { label: 'Add: Debit Notes (GSTR-2B)', amount: debitOnly, kind: 'add' },
      { label: 'Amount Mismatch Adjustment (Books \u2192 2B value)', amount: mismatchAdj, kind: mismatchAdj >= 0 ? 'add' : 'less' },
      { label: 'Round Off / Unexplained Residual', amount: roundOff, kind: Math.abs(roundOff) > 5 ? 'warn' : 'neutral' },
      { label: 'Adjusted Books Total', amount: adjustedBooks, kind: 'subtotal' },
      { label: 'Official GSTR-2B Total (net of Credit/Debit Notes)', amount: netGSTR2B, kind: 'target' },
      { label: 'Difference', amount: adjustedBooks - netGSTR2B, kind: 'result' }
    ];
    return { rows: rows, roundOff: roundOff, flagged: Math.abs(roundOff) > 5, adjustedBooks: adjustedBooks, netGSTR2B: netGSTR2B };
  }

  // For XLSX.utils.json_to_sheet() — one line to add a sheet to your export.
  function proofRowsToSheetData(rows) {
    return rows.map(function (r) { return { Particulars: r.label, 'Amount (\u20B9)': Math.round(r.amount * 100) / 100 }; });
  }

  // Ready-to-insert HTML string — one line: someEl.innerHTML = TaxNestMapper.renderProofTableHTML(proof.rows)
  function renderProofTableHTML(rows) {
    function fc(v) { var sign = v < 0 ? '-' : ''; return sign + '\u20B9' + Math.abs(Math.round(v)).toLocaleString('en-IN'); }
    var out = '<table class="tn-proof-table" style="width:100%;border-collapse:collapse;font-family:inherit">';
    rows.forEach(function (r) {
      var bold = (r.kind === 'subtotal' || r.kind === 'target' || r.kind === 'result') ? 'font-weight:700;' : '';
      var color = r.kind === 'warn' ? 'color:#d97706;' : r.kind === 'result' ? (Math.abs(r.amount) < 1 ? 'color:#16a34a;' : 'color:#dc2626;') : '';
      out += '<tr style="' + bold + '"><td style="padding:6px 10px;border-bottom:1px solid rgba(0,0,0,.08)">' + r.label +
        '</td><td style="padding:6px 10px;text-align:right;border-bottom:1px solid rgba(0,0,0,.08);' + color + '">' + fc(r.amount) + '</td></tr>';
    });
    return out + '</table>';
  }

  return {
    VERSION: VERSION, FIELDS: FIELDS, SYNONYMS: SYNONYMS,
    mapColumns: mapColumns, allRequiredConfident: allRequiredConfident,
    findHeaderRow: findHeaderRow, readGSTSheet: readGSTSheet, rowsToObjects: rowsToObjects,
    looksLikeGSTIN: looksLikeGSTIN, looksLikeDate: looksLikeDate,
    looksLikeAmount: looksLikeAmount, toNumber: toNumber, normalizeDateStr: normalizeDateStr,
    parseInvoiceRows: parseInvoiceRows, detectWorkbookFormat: detectWorkbookFormat,
    pickBestSheet: pickBestSheet, extractMetadata: extractMetadata,
    parseThirdPartyWorkbook: parseThirdPartyWorkbook,
    smartParse2BFile: smartParse2BFile, handleCombinedWorkbook: handleCombinedWorkbook,
    buildReconciliationProof: buildReconciliationProof,
    proofRowsToSheetData: proofRowsToSheetData, renderProofTableHTML: renderProofTableHTML
  };
});
