/* =========================================================
   mapping-engine.js -- all review/mapping logic, no DOM. Plain <script> (window.MappingEngine) or Node.
   Works on "entries": a parsed transaction + mapping fields:
     { reference_no, date:'YYYYMMDD', narration, amount, drCr:'D'|'C', refNo, balance?,
       ledger_name, ledger_source, mapping_confidence, mapping_note, mapping_locked, flags:[] }
   ledger_source: default | manual | bulk_manual | ai | imported_ai | tally
   ========================================================= */
(function (root) {
  'use strict';
  var SUSPENSE = 'Suspense A/c';
  var AI_VERSION = '1.0';

  function now() { return new Date().toISOString(); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------- state ---------- */
  function createState(entries, opts) {
    opts = opts || {};
    return {
      entries: entries, suspense: opts.suspense || SUSPENSE,
      ledgers: [],                 // available ledger names (from Tally or typed list); never invented
      ledgersSource: 'none',       // 'tally' | 'manual' | 'none'
      audit: [],                   // [{ref, from, to, source, confidence, at}]
      aiThreshold: { high: 0.9, review: 0.7 }
    };
  }
  function byRef(state) { var m = {}; state.entries.forEach(function (e) { m[e.reference_no] = e; }); return m; }

  function setLedgers(state, names, source) {
    var seen = {}, out = [];
    (names || []).forEach(function (n) { n = String(n).trim(); if (n && !seen[n.toLowerCase()]) { seen[n.toLowerCase()] = 1; out.push(n); } });
    if (!seen[state.suspense.toLowerCase()]) out.push(state.suspense);   // Suspense is always available as the fallback
    state.ledgers = out.sort(function (a, b) { return a.localeCompare(b); });
    state.ledgersSource = source || 'manual';
    return state.ledgers.length;
  }
  function ledgerExists(state, name) {
    var l = String(name || '').trim().toLowerCase();
    return state.ledgers.some(function (x) { return x.toLowerCase() === l; });
  }
  function canonicalLedger(state, name) {
    var l = String(name || '').trim().toLowerCase();
    for (var i = 0; i < state.ledgers.length; i++) if (state.ledgers[i].toLowerCase() === l) return state.ledgers[i];
    return null;
  }
  /* Ledger autocomplete: prefix matches first, then substring; case-insensitive. */
  function searchLedgers(state, q, limit) {
    q = String(q || '').trim().toLowerCase(); limit = limit || 12;
    if (!q) return state.ledgers.slice(0, limit);
    var starts = [], has = [];
    state.ledgers.forEach(function (n) {
      var l = n.toLowerCase();
      if (l.indexOf(q) === 0) starts.push(n); else if (l.indexOf(q) !== -1) has.push(n);
    });
    return starts.concat(has).slice(0, limit);
  }

  /* ---------- filters ----------
     filter: { field:'narration'|'date'|'debit'|'credit'|'balance'|'ledger'|'source'|'ref'|'refNo',
               op:'contains'|'not_contains'|'starts_with'|'exact'|'gt'|'lt'|'between'|'is_suspense'|'unmapped',
               value, value2 } */
  function fieldText(state, e, field) {
    switch (field) {
      case 'narration': return e.narration;
      case 'ref': return e.reference_no;
      case 'refNo': return e.refNo || '';
      case 'date': return e.date.slice(6, 8) + '-' + e.date.slice(4, 6) + '-' + e.date.slice(0, 4);
      case 'debit': return e.drCr === 'D' ? String(e.amount) : '';
      case 'credit': return e.drCr === 'C' ? String(e.amount) : '';
      case 'balance': return typeof e.balance === 'number' ? String(e.balance) : '';
      case 'ledger': return e.ledger_name;
      case 'source': return e.ledger_source;
      default: return '';
    }
  }
  function matchOne(state, e, f) {
    var v = String(f.value == null ? '' : f.value).trim().toLowerCase();
    if (f.op === 'is_suspense') return e.ledger_name === state.suspense;
    if (f.op === 'unmapped') return e.ledger_source === 'default';
    if (f.op === 'duplicates') return (e.flags || []).indexOf('possible_duplicate') !== -1;
    if (f.op === 'excluded') return !!e.excluded;
    if (f.op === 'locked') return !!e.mapping_locked;
    if (f.op === 'reconstructed') return !!e.reconstructed;
    if (f.op === 'refs') return !!(f.refs && f.refs[e.reference_no]);
    if (f.op === 'gt' || f.op === 'lt' || f.op === 'between') {
      var n = f.field === 'debit' ? (e.drCr === 'D' ? e.amount : null) :
              f.field === 'credit' ? (e.drCr === 'C' ? e.amount : null) :
              f.field === 'balance' ? (typeof e.balance === 'number' ? e.balance : null) : null;
      if (n === null) return false;
      var a = parseFloat(String(f.value).replace(/,/g, '')), b = parseFloat(String(f.value2).replace(/,/g, ''));
      if (f.op === 'gt') return !isNaN(a) && n > a;
      if (f.op === 'lt') return !isNaN(a) && n < a;
      return !isNaN(a) && !isNaN(b) && n >= a && n <= b;
    }
    if (f.field === 'datefrom' || f.field === 'dateto') return true; // handled by dateRange below
    if (v === '') return true;                                         // empty filter = no filter
    var t = fieldText(state, e, f.field).toLowerCase();
    switch (f.op) {
      case 'not_contains': return t.indexOf(v) === -1;
      case 'starts_with': return t.indexOf(v) === 0;
      case 'exact': return t === v;
      default: return t.indexOf(v) !== -1;                              // contains
    }
  }
  function applyFilters(state, filters, dateRange) {
    var out = [];
    state.entries.forEach(function (e) {
      for (var i = 0; i < filters.length; i++) if (!matchOne(state, e, filters[i])) return;
      if (dateRange) {
        if (dateRange.from && e.date < dateRange.from) return;
        if (dateRange.to && e.date > dateRange.to) return;
      }
      out.push(e);
    });
    return out;
  }

  /* ---------- mapping ---------- */
  function logChange(state, e, to, source, conf) {
    state.audit.push({ ref: e.reference_no, from: e.ledger_name, to: to, source: source, confidence: conf == null ? null : conf, at: now() });
  }
  /* Manual / bulk assignment. Locks the entries (user intent beats later AI imports). */
  function assignLedger(state, refs, ledgerName, source) {
    var canon = canonicalLedger(state, ledgerName);
    if (!canon) return { ok: false, error: 'Ledger "' + ledgerName + '" is not in the available ledger list.', changed: 0 };
    var map = byRef(state), changed = 0;
    refs.forEach(function (r) {
      var e = map[r]; if (!e) return;
      if (e.ledger_name !== canon || e.ledger_source === 'default') {
        logChange(state, e, canon, source || 'manual', null); changed++;
      }
      e.ledger_name = canon; e.ledger_source = source || 'manual';
      e.mapping_locked = canon !== state.suspense ? true : false;
      e.mapping_confidence = null; e.mapping_note = '';
    });
    return { ok: true, changed: changed, ledger: canon };
  }
  function resetToSuspense(state, refs) {
    var map = byRef(state);
    refs.forEach(function (r) {
      var e = map[r]; if (!e) return;
      logChange(state, e, state.suspense, 'manual', null);
      e.ledger_name = state.suspense; e.ledger_source = 'default'; e.mapping_locked = false; e.mapping_confidence = null; e.mapping_note = '';
    });
  }

  /* ---------- AI package ---------- */
  var PROMPT_RULES =
    'You are an accounting ledger-mapping assistant.\n\n' +
    'Your task is to map each bank transaction to the most appropriate Tally ledger from the "available_tally_ledgers" list in the attached JSON.\n\n' +
    'Rules:\n' +
    '1. Use only ledger names that appear in "available_tally_ledgers", spelled exactly as listed.\n' +
    '2. Never invent a ledger.\n' +
    '3. Never modify transaction amounts, dates, narrations or reference numbers.\n' +
    '4. Analyze the narration carefully (UPI/NEFT/IMPS party names, charges, GST, interest, salary, rent, etc.).\n' +
    '5. Use direction as supporting context: "credit" = money received into the bank; "debit" = money paid out of the bank.\n' +
    '6. If the correct ledger cannot be determined with reasonable confidence, use "' + SUSPENSE + '". Do not force a low-confidence mapping.\n' +
    '7. Give a confidence between 0 and 1 and a short reason for every mapping.\n' +
    '8. Return EVERY reference_no exactly once, preserving it exactly.\n' +
    '9. Return ONLY valid JSON (no markdown fences, no commentary) in exactly this shape:\n' +
    '{"version":"' + AI_VERSION + '","mappings":[{"reference_no":"TXN-000001","ledger_name":"...","confidence":0.95,"reason":"..."}]}\n';

  function buildAiInput(state, statementInfo, refs) {
    var set = refs ? {} : null; if (refs) refs.forEach(function (r) { set[r] = 1; });
    var list = state.entries.filter(function (e) { return !e.excluded && (!set || set[e.reference_no]); });
    return {
      version: AI_VERSION,
      statement: statementInfo || {},
      available_tally_ledgers: state.ledgers.slice(),
      transactions: list.map(function (e) {
        return {
          reference_no: e.reference_no, date: e.date.slice(0, 4) + '-' + e.date.slice(4, 6) + '-' + e.date.slice(6, 8),
          narration: e.narration, bank_reference: e.refNo || '',
          debit: e.drCr === 'D' ? e.amount : 0, credit: e.drCr === 'C' ? e.amount : 0,
          balance: typeof e.balance === 'number' ? e.balance : null, current_ledger: e.ledger_name
        };
      })
    };
  }
  function buildAiPromptText() { return PROMPT_RULES; }

  /* ---------- AI result validation ----------
     Returns { valid:[{ref, ledger, confidence, reason}], issues:[{ref, severity, code, message}], fatal?:string, summary }
     Nothing is applied here. */
  function validateAiResult(state, resultText, opts) {
    opts = opts || {};
    var res = { valid: [], issues: [], fatal: null, summary: null };
    var data;
    try { data = typeof resultText === 'string' ? JSON.parse(resultText.replace(/^\uFEFF/, '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) : resultText; }
    catch (err) { res.fatal = 'The file is not valid JSON (' + err.message + ').'; return res; }
    if (!data || typeof data !== 'object' || !Array.isArray(data.mappings)) { res.fatal = 'Missing a "mappings" array.'; return res; }
    if (String(data.version) !== AI_VERSION) { res.fatal = 'Unsupported version "' + data.version + '" (expected ' + AI_VERSION + ').'; return res; }
    var map = byRef(state), seen = {}, rejected = 0, suspenseForced = 0;
    data.mappings.forEach(function (m) {
      var ref = m && m.reference_no;
      if (!ref || !map[ref]) { res.issues.push({ ref: ref || '(none)', severity: 'rejected', code: 'unknown_reference', message: 'Reference does not exist in this statement.' }); rejected++; return; }
      if (seen[ref]) { res.issues.push({ ref: ref, severity: 'rejected', code: 'duplicate_reference', message: 'Reference appears more than once; later occurrence ignored.' }); rejected++; return; }
      seen[ref] = 1;
      var conf = typeof m.confidence === 'number' && isFinite(m.confidence) ? Math.max(0, Math.min(1, m.confidence)) : null;
      if (conf === null) res.issues.push({ ref: ref, severity: 'review', code: 'bad_confidence', message: 'Confidence missing or not numeric; treated as 0.' });
      ['amount', 'debit', 'credit', 'date', 'narration'].forEach(function (k) {
        if (m[k] !== undefined) {
          var e = map[ref], orig = { amount: e.amount, debit: e.drCr === 'D' ? e.amount : 0, credit: e.drCr === 'C' ? e.amount : 0,
            date: e.date.slice(0, 4) + '-' + e.date.slice(4, 6) + '-' + e.date.slice(6, 8), narration: e.narration }[k];
          if (String(m[k]) !== String(orig)) res.issues.push({ ref: ref, severity: 'rejected', code: 'field_modified', message: 'AI changed "' + k + '"; mapping rejected.' });
        }
      });
      if (res.issues.some(function (i) { return i.ref === ref && i.code === 'field_modified'; })) { rejected++; return; }
      var canon = canonicalLedger(state, m.ledger_name);
      if (!canon) {
        res.issues.push({ ref: ref, severity: 'forced_suspense', code: 'unknown_ledger', message: '"' + m.ledger_name + '" is not an available ledger; set to ' + state.suspense + ' for review.' });
        suspenseForced++;
        res.valid.push({ ref: ref, ledger: state.suspense, confidence: 0, reason: 'AI suggested unknown ledger "' + m.ledger_name + '"', forced: true });
        return;
      }
      res.valid.push({ ref: ref, ledger: canon, confidence: conf === null ? 0 : conf, reason: String(m.reason || '') });
    });
    var missing = state.entries.filter(function (e) { return !seen[e.reference_no]; }).map(function (e) { return e.reference_no; });
    if (missing.length && !opts.allowMissing) res.issues.push({ ref: '(multiple)', severity: 'warning', code: 'missing_transactions', message: missing.length + ' transaction(s) were not returned; they keep their current ledger.', refs: missing });
    var t = state.aiThreshold;
    var high = res.valid.filter(function (v) { return v.ledger !== state.suspense && v.confidence >= t.high; }).length;
    var review = res.valid.filter(function (v) { return v.ledger !== state.suspense && v.confidence >= t.review && v.confidence < t.high; }).length;
    res.summary = { total_in_statement: state.entries.length, returned: data.mappings.length, usable: res.valid.length, high_confidence: high,
      needs_review: review,
      suspense: res.valid.filter(function (v) { return v.ledger === state.suspense; }).length, rejected: rejected, forced_suspense: suspenseForced, missing: missing.length };
    return res;
  }

  /* Stage validated suggestions on the entries (not yet "accepted"): suggestion fields only. */
  function stageAiSuggestions(state, validated) {
    var map = byRef(state);
    validated.valid.forEach(function (v) {
      var e = map[v.ref];
      e.ai_suggestion = { ledger: v.ledger, confidence: v.confidence, reason: v.reason, forced: !!v.forced, status: 'pending' };
    });
  }
  /* Accept one suggestion. Returns false (and does nothing) if locked and !force. */
  function acceptSuggestion(state, ref, opts) {
    opts = opts || {};
    var e = byRef(state)[ref]; if (!e || !e.ai_suggestion || e.ai_suggestion.status !== 'pending') return { ok: false, reason: 'no_pending_suggestion' };
    if (e.mapping_locked && !opts.force) return { ok: false, reason: 'locked' };
    var s = e.ai_suggestion;
    logChange(state, e, s.ledger, 'imported_ai', s.confidence);
    e.ledger_name = s.ledger; e.ledger_source = s.ledger === state.suspense ? 'default' : 'imported_ai';
    e.mapping_confidence = s.confidence; e.mapping_note = s.reason;
    e.mapping_locked = opts.lock === true && s.ledger !== state.suspense;
    s.status = 'accepted';
    return { ok: true };
  }
  function rejectSuggestion(state, ref) {
    var e = byRef(state)[ref]; if (e && e.ai_suggestion) e.ai_suggestion.status = 'kept_suspense';
  }
  /* Bulk accept: only suggestions with confidence >= minConfidence, never locked entries, never forced-suspense. */
  function acceptAllValid(state, minConfidence) {
    var applied = 0, skippedLocked = 0, skippedLow = 0;
    state.entries.forEach(function (e) {
      var s = e.ai_suggestion; if (!s || s.status !== 'pending') return;
      if (s.forced || s.ledger === state.suspense || s.confidence < minConfidence) { skippedLow++; return; }
      var r = acceptSuggestion(state, e.reference_no);
      if (r.ok) applied++; else if (r.reason === 'locked') skippedLocked++;
    });
    return { applied: applied, skippedLocked: skippedLocked, skippedLow: skippedLow };
  }
  function previewAcceptAll(state, minConfidence) {
    var apply = 0, locked = 0, remain = 0;
    state.entries.forEach(function (e) {
      var s = e.ai_suggestion; if (!s || s.status !== 'pending') return;
      if (s.forced || s.ledger === state.suspense || s.confidence < minConfidence) remain++;
      else if (e.mapping_locked) locked++; else apply++;
    });
    return { apply: apply, lockedSkipped: locked, remainSuspenseOrReview: remain };
  }

  /* ---------- summaries + final validation ---------- */
  function mappingSummary(state) {
    var groups = {};
    state.entries.forEach(function (e) {
      var g = groups[e.ledger_name] || (groups[e.ledger_name] = { ledger: e.ledger_name, count: 0, debit: 0, credit: 0, sources: {} });
      g.count++; if (e.drCr === 'D') g.debit += e.amount; else g.credit += e.amount; g.sources[e.ledger_source] = 1;
    });
    return Object.keys(groups).map(function (k) {
      var g = groups[k]; g.debit = Math.round(g.debit * 100) / 100; g.credit = Math.round(g.credit * 100) / 100; g.sources = Object.keys(g.sources).join(', '); return g;
    }).sort(function (a, b) { return b.count - a.count; });
  }
  function counts(state) {
    var sus = state.entries.filter(function (e) { return e.ledger_name === state.suspense; }).length;
    return { total: state.entries.length, suspense: sus, mapped: state.entries.length - sus,
      locked: state.entries.filter(function (e) { return e.mapping_locked; }).length,
      excluded: state.entries.filter(function (e) { return e.excluded; }).length,
      duplicates: state.entries.filter(function (e) { return (e.flags || []).indexOf('possible_duplicate') !== -1; }).length,
      rebuilt: state.entries.filter(function (e) { return e.reconstructed; }).length };
  }
  /* Spec section 39 -- run before any export. Returns { ok, errors:[], warnings:[] }. */
  function finalValidation(state, validation) {
    var errors = [], warnings = [], refs = {};
    state.entries.forEach(function (e) {
      if (!e.reference_no) errors.push('A transaction has no reference number.');
      else if (refs[e.reference_no]) errors.push('Duplicate reference ' + e.reference_no + '.'); else refs[e.reference_no] = 1;
      if (!/^\d{8}$/.test(e.date || '')) errors.push(e.reference_no + ': invalid date "' + e.date + '".');
      if (typeof e.amount !== 'number' || !isFinite(e.amount) || e.amount <= 0) errors.push(e.reference_no + ': invalid amount.');
      if (e.drCr !== 'D' && e.drCr !== 'C') errors.push(e.reference_no + ': direction (Debit/Credit) missing.');
      if (!e.ledger_name) errors.push(e.reference_no + ': no ledger.');
      else if (state.ledgersSource === 'tally' && !ledgerExists(state, e.ledger_name)) errors.push(e.reference_no + ': ledger "' + e.ledger_name + '" is not in the connected Tally.');
    });
    if (validation) {
      if (validation.status === 'failed') warnings.push('Balance validation FAILED (difference ' + validation.difference + '). Review before importing into Tally.');
      else if (validation.status === 'not_available') warnings.push('Balance validation not available for this statement.');
      else if (validation.status === 'chain_ok') warnings.push('Rows are consistent with each other, but opening/closing balances were not independently confirmed.');
    }
    var rec = state.entries.filter(function (e) { return e.reconstructed && !e.excluded; }).length;
    if (rec) warnings.push(rec + ' entr' + (rec === 1 ? 'y was' : 'ies were') + ' rebuilt from balance changes (amount and direction exact, narration missing) — review before importing.');
    var exc = state.entries.filter(function (e) { return e.excluded; }).length;
    if (exc) warnings.push(exc + ' row(s) are excluded from the export (balance check still covers all extracted rows).');
    var dups = state.entries.filter(function (e) { return (e.flags || []).indexOf('possible_duplicate') !== -1; }).length;
    if (dups) warnings.push(dups + ' possible duplicate row(s) flagged -- confirm they are genuine.');
    return { ok: errors.length === 0, errors: errors.slice(0, 20), errorCount: errors.length, warnings: warnings };
  }

  /* Entries -> TallyXML transactions. Direction is the bank statement's: Credit = money IN = Receipt. */
  function toTallyTransactions(state) {
    return state.entries.filter(function (e) { return !e.excluded; }).map(function (e) {
      return { date: e.date, narration: e.narration, amount: e.amount, drCr: e.drCr, refNo: e.refNo, counterLedger: e.ledger_name };
    });
  }

  var Engine = {
    SUSPENSE: SUSPENSE, AI_VERSION: AI_VERSION, createState: createState, setLedgers: setLedgers, ledgerExists: ledgerExists,
    canonicalLedger: canonicalLedger, searchLedgers: searchLedgers, applyFilters: applyFilters, assignLedger: assignLedger,
    resetToSuspense: resetToSuspense, buildAiInput: buildAiInput, buildAiPromptText: buildAiPromptText, validateAiResult: validateAiResult,
    stageAiSuggestions: stageAiSuggestions, acceptSuggestion: acceptSuggestion, rejectSuggestion: rejectSuggestion,
    acceptAllValid: acceptAllValid, previewAcceptAll: previewAcceptAll, mappingSummary: mappingSummary, counts: counts,
    finalValidation: finalValidation, toTallyTransactions: toTallyTransactions
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine; else root.MappingEngine = Engine;
})(typeof window !== 'undefined' ? window : this);
