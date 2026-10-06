/* bank-recon-review.js -- Step 2 UI: validation card, filters, virtualised table, bulk mapping,
   Tally panel, AI mapping, export. All logic lives in MappingEngine / BalanceValidator / TallyXML;
   this file only renders and wires events. Entry: BankReconReview.open(session) / .showError(info) /
   .showProgress(stages) / .resumeInfo() */
(function () {
  'use strict';
  var E = window.MappingEngine, V = window.BalanceValidator;
  var root = document.getElementById('rv-root');
  var STORE_KEY = 'taxnest_bank_import_v1';
  var ROW_H = 40;

  var S = null;            // session
  var st = null;           // engine state (S.state)
  var ui = null;           // transient UI state
  var saveTimer = null;

  /* ---------- tiny DOM helper ---------- */
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined) return; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function inr(n) { return typeof n === 'number' ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }
  function dmy(d) { return d && d.length === 8 ? d.slice(6, 8) + '-' + d.slice(4, 6) + '-' + d.slice(0, 4) : (d || ''); }
  function longDate(d) { if (!d || d.length !== 8) return ''; return d.slice(6, 8) + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+d.slice(4, 6) - 1] + ' ' + d.slice(0, 4); }
  function safeName(s) { return String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Bank'; }
  function download(name, mime, data) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    var a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  /* ---------- dialogs ---------- */
  function dialog(title, bodyNodes, buttons) {
    return new Promise(function (resolve) {
      var ov = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' });
      function close(v) { document.removeEventListener('keydown', onKey); ov.remove(); resolve(v); }
      function onKey(e) { if (e.key === 'Escape') close(false); }
      var btns = h('div', { class: 'btns' }, buttons.map(function (b) {
        return h('button', { type: 'button', class: b.primary ? 'btn-p' : 'btn-s', text: b.label, onclick: function () { close(b.value); } });
      }));
      ov.appendChild(h('div', { class: 'dialog' }, [h('h3', { text: title })].concat(bodyNodes, [btns])));
      document.body.appendChild(ov); document.addEventListener('keydown', onKey);
      var p = ov.querySelector('.btn-p'); if (p) p.focus();
    });
  }
  function confirmDialog(title, lines, okLabel) {
    return dialog(title, lines.map(function (l) { return typeof l === 'string' ? h('p', { text: l }) : l; }),
      [{ label: 'Cancel', value: false }, { label: okLabel || 'Apply', value: true, primary: true }]);
  }

  /* ---------- ledger picker (searchable, never accepts unknown ledgers) ---------- */
  function ledgerPicker(opts) {
    var wrap = h('div', { class: 'picker' });
    var input = h('input', { type: 'text', class: 'rv-input', placeholder: opts.placeholder || 'Search ledger…', autocomplete: 'off', 'aria-label': 'Ledger' });
    var list = h('ul', { class: 'picker-list', role: 'listbox', hidden: true });
    var idx = -1, items = [];
    function render() {
      items = E.searchLedgers(st, input.value, 30); list.innerHTML = ''; idx = items.length ? 0 : -1;
      if (!items.length) list.appendChild(h('li', { class: 'none', text: st.ledgersSource === 'none' ? 'No ledger list yet — connect Tally or paste ledger names' : 'No matching ledger' }));
      items.forEach(function (n, i) {
        list.appendChild(h('li', { role: 'option', class: i === idx ? 'on' : '', text: n, onmousedown: function (ev) { ev.preventDefault(); pick(n); } }));
      });
      list.hidden = false;
    }
    function mark() { Array.prototype.forEach.call(list.children, function (li, i) { li.classList.toggle('on', i === idx); }); }
    function pick(n) { list.hidden = true; input.value = n; if (opts.onPick) opts.onPick(n); }
    input.addEventListener('input', render);
    input.addEventListener('focus', render);
    input.addEventListener('blur', function () { setTimeout(function () { list.hidden = true; }, 120); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) render(); idx = Math.min(idx + 1, items.length - 1); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); mark(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (idx >= 0 && items[idx]) pick(items[idx]); else if (E.canonicalLedger(st, input.value)) pick(E.canonicalLedger(st, input.value)); }
      else if (e.key === 'Escape') { list.hidden = true; if (opts.onCancel) opts.onCancel(); }
    });
    wrap.appendChild(input); wrap.appendChild(list);
    wrap.input = input; return wrap;
  }

  /* ---------- persistence (own browser only; user can clear) ---------- */
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        var snap = { v: 1, savedAt: new Date().toISOString(), bank: S.bank, fileName: S.fileName, parserMode: S.parserMode, parserKey: S.parserKey,
          statement: S.statement, vopts: S.vopts, bankLedger: S.bankLedger, extraction: S.extraction,
          state: { entries: st.entries, suspense: st.suspense, ledgers: st.ledgers, ledgersSource: st.ledgersSource, audit: st.audit.slice(-5000), aiThreshold: st.aiThreshold } };
        localStorage.setItem(STORE_KEY, JSON.stringify(snap));
      } catch (err) { /* storage full or blocked: work continues, just not resumable */ }
    }, 400);
  }
  function resumeInfo() {
    try {
      var raw = localStorage.getItem(STORE_KEY); if (!raw) return null;
      var s = JSON.parse(raw); if (!s || s.v !== 1 || !s.state) return null;
      return { bank: s.bank && s.bank.name, count: s.state.entries.length, savedAt: s.savedAt, snapshot: s };
    } catch (e) { return null; }
  }
  function clearSaved() { try { localStorage.removeItem(STORE_KEY); } catch (e) {} }

  /* ---------- progress + error screens ---------- */
  function showProgress(stages) {
    root.innerHTML = '';
    var ul = h('ul', { class: 'prog', 'aria-live': 'polite' });
    stages.forEach(function (s, i) { ul.appendChild(h('li', { 'data-i': i }, [h('span', { class: 'dot' }), s])); });
    root.appendChild(h('h1', { text: 'Reading your statement' }));
    root.appendChild(h('p', { class: 'lede', text: 'Each step below runs for real; nothing is skipped or faked.' }));
    root.appendChild(ul);
    return { set: function (n) { Array.prototype.forEach.call(ul.children, function (li, i) { li.className = i < n ? 'done' : (i === n ? 'cur' : ''); }); } };
  }
  function showError(info, onBack) {
    root.innerHTML = '';
    var ul = h('ul', null, (info.solutions || []).map(function (s) { return h('li', { text: s }); }));
    root.appendChild(h('h1', { text: info.title || 'We could not extract this statement' }));
    root.appendChild(h('div', { class: 'errbox', role: 'alert' }, [h('h3', { text: info.reason }), info.detail ? h('p', { text: info.detail }) : null,
      h('strong', { text: 'Possible solutions' }), ul]));
    var rowBtns = [h('button', { type: 'button', class: 'btn-s', text: 'Back', onclick: function () { if (onBack) onBack(); } })];
    if (info.rawText) rowBtns.push(h('button', { type: 'button', class: 'btn-s', text: 'Download extracted text (debug)', onclick: function () { download('extracted-text.txt', 'text/plain', info.rawText); } }));
    root.appendChild(h('div', { class: 'rv-row' }, rowBtns));
  }

  /* ---------- validation ---------- */
  function revalidate() {
    S.validation = V.validateStatement(st.entries, { opening: S.vopts.opening, closing: S.vopts.closing, directionFromMarker: !!S.vopts.directionFromMarker });
    return S.validation;
  }
  function extractionConfidence() {
    var n = st.entries.length, low = st.entries.filter(function (e) { return e.parse_confidence === 'low'; }).length;
    var v = S.validation.status;
    if (v === 'failed' || low > Math.max(2, n * 0.05)) return 'Low';
    if (v === 'passed' && low === 0) return 'High';
    return 'Medium';
  }

  /* ---------- modal windows ---------- */
  function openModal(o) {
    if (ui.modal) { ui.modal.el.remove(); ui.modal = null; }
    var ov = h('div', { class: 'modal-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title });
    var modal = h('div', { class: 'modal ' + (o.size || '') });
    var closed = false, api = { el: ov, name: o.name };
    function close() {
      if (closed) return; closed = true; document.removeEventListener('keydown', onKey); ov.classList.add('closing');
      setTimeout(function () { ov.remove(); }, 170); if (ui.modal === api) ui.modal = null; if (o.onClose) o.onClose();
    }
    function onKey(e) { if (e.key === 'Escape' && !document.querySelector('.overlay') && !o.sticky) close(); }
    modal.appendChild(h('div', { class: 'modal-hd' }, [h('span', { class: 'mi', text: o.icon || '' }), h('div', null, [h('h3', { text: o.title }), o.subtitle ? h('p', { text: o.subtitle }) : null]),
      o.sticky ? null : h('button', { type: 'button', class: 'modal-x', 'aria-label': 'Close', text: '✕', onclick: close })]));
    api.body = h('div', { class: 'modal-bd' }); modal.appendChild(api.body);
    ov.appendChild(modal); document.body.appendChild(ov); api.close = close; api.modal = modal;
    document.addEventListener('keydown', onKey);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov && !o.sticky) close(); });
    ui.modal = api; return api;
  }
  function modalIs(name) { return ui && ui.modal && ui.modal.name === name; }

  /* ---------- render root ---------- */
  function open(session) {
    S = session; st = S.state;
    var prevUrl = ui && ui.helperUrl;
    if (ui && ui.modal) ui.modal.el.remove();
    ui = { filters: { narrOp: 'contains', narr: '', debitGt: '', creditGt: '', from: '', to: '', ledger: '', suspenseOnly: false, unmapped: false, dups: false, excludedOnly: false, rebuilt: false },
      selected: {}, filtered: [], page: 0, pageSize: 100, refFilter: null, refLabel: '', aiTab: 'high', aiShown: 100, aiConsent: false, aiScope: 'all',
      conn: null, company: '', syncedFor: null, helperUrl: prevUrl || '', remember: true, quickShown: 20, modal: null, parents: {}, statPrev: {}, vPrev: {} };
    revalidate();
    root.innerHTML = '';
    var head = h('div', { class: 'rv-head' }, [h('button', { type: 'button', class: 'btn-s', text: '← New statement', onclick: function () { stopPolling(); if (ui.modal) ui.modal.close(); if (window.BankReconReview.onBack) window.BankReconReview.onBack(); } }), h('h1', { text: 'Bank Statement Review' }),
      h('span', { class: 'badge-pill gold', text: S.parserMode === 'bank_specific' ? 'Bank-specific parser' : 'Universal parser' }),
      h('span', { class: 'badge-pill', id: 'rv-conf' })]);
    var period = S.statement && S.statement.period_start ? longDate(S.statement.period_start) + ' – ' + longDate(S.statement.period_end) : periodFromEntries();
    var acct = S.statement && S.statement.account_number_masked ? ' · ' + S.statement.account_number_masked : '';
    root.appendChild(head);
    root.appendChild(h('p', { class: 'rv-sub', text: S.bank.name + ' · ' + period + acct + ' · ' + S.fileName }));
    root.appendChild(tallyBar());                  // ledgers come first: they are needed before mapping
    root.appendChild(h('div', { id: 'rv-validation' }));
    root.appendChild(h('div', { class: 'actions', id: 'rv-actions' }));
    root.appendChild(h('div', { class: 'rv-stats', id: 'rv-stats' }));
    root.appendChild(filterPanel());               // filters sit directly above the bank data
    root.appendChild(tableBlock());
    if (/[?&]debug=1/.test(location.search)) root.appendChild(debugPanel());   // developer info is hidden from normal users
    renderValidation(); renderActions(); renderStats(); applyFilterState(true); renderLight(); startPolling();
  }
  function periodFromEntries() {
    if (!st.entries.length) return '';
    var ds = st.entries.map(function (e) { return e.date; }).sort(); return longDate(ds[0]) + ' – ' + longDate(ds[ds.length - 1]);
  }
  function refreshAll() { renderValidation(); renderActions(); renderStats(); applyFilterState(false); renderQuick(); renderAiResults(); renderExport(); persist(); }

  /* ---------- validation card (short and plain: internal notes stay out of sight) ---------- */
  var V_TITLE = {
    passed: '✓ Balance validated', chain_ok: '◐ Entries are consistent with each other',
    failed: '⚠ Balance mismatch detected. Please review the extracted transactions before continuing.', not_available: 'Balance check not available for this statement'
  };
  function renderValidation() {
    var box = document.getElementById('rv-validation'); var v = S.validation; box.innerHTML = '';
    var card = h('div', { class: 'vcard s-' + v.status, id: 'vcard' });
    card.appendChild(h('h2', { text: 'Validation' }));
    card.appendChild(h('p', { class: 'v-title', text: V_TITLE[v.status] }));
    var cells = [['Opening', v.opening_balance], ['Debits', v.total_debit], ['Credits', v.total_credit], ['Expected closing', v.calculated_closing_balance], ['Statement closing', v.statement_closing_balance], ['Difference', v.difference]];
    card.appendChild(h('div', { class: 'v-grid' }, cells.map(function (c, i) {
      var b = h('b', { text: c[1] === null ? '—' : '₹' + inr(c[1]) });
      if (c[1] !== null && window.FX) { b._fxv = ui.vPrev[i] === undefined ? 0 : ui.vPrev[i]; FX.countUp(b, c[1], { decimals: 2, prefix: '₹' }); ui.vPrev[i] = c[1]; }
      return h('div', { class: 'v-cell' }, [h('small', { text: c[0] }), b]);
    })));
    var items = [];
    ((S.statement && S.statement.serial_gaps) || []).slice(0, 3).forEach(function (g) { items.push(h('li', { text: 'Row numbering jumps from ' + (g.expected - 1) + ' to ' + g.found + ' — a row may have been lost.' })); });
    v.failures.slice(0, 3).forEach(function (f) {
      items.push(h('li', null, [f.ref + ' (' + dmy(f.date) + '): ' + f.message + ' ', h('button', { type: 'button', class: 'ico', text: 'Go to row', onclick: function () { jumpTo(f.ref); } })]));
    });
    if (v.failures.length > 3) items.push(h('li', { text: '…and ' + (v.failures.length - 3) + ' more row(s) that do not reconcile.' }));
    var rb = st.entries.filter(function (e) { return e.reconstructed; }).length;
    if (rb) items.push(h('li', null, [rb + ' entr' + (rb === 1 ? 'y was' : 'ies were') + ' rebuilt from the balance (amount and Dr/Cr exact, narration missing). ',
      h('button', { type: 'button', class: 'ico', text: 'Show them', onclick: function () { ui.filters.rebuilt = true; var old = document.getElementById('rv-filters'); old.replaceWith(filterPanel()); applyFilterState(true); document.getElementById('rv-filters').scrollIntoView({ behavior: 'smooth', block: 'start' }); } })]));
    if (items.length) card.appendChild(h('ul', { class: 'v-list' }, items));
    if (v.status !== 'passed') {            // only when the check could not be completed from the statement itself
      var op = h('input', { type: 'text', class: 'rv-input', id: 'v-open', inputmode: 'decimal', style: 'width:130px', placeholder: 'Opening ₹', value: S.vopts.opening != null ? String(S.vopts.opening) : '' });
      var cl = h('input', { type: 'text', class: 'rv-input', id: 'v-close', inputmode: 'decimal', style: 'width:130px', placeholder: 'Closing ₹', value: S.vopts.closing != null ? String(S.vopts.closing) : '' });
      card.appendChild(h('div', { class: 'v-inputs' }, [
        h('div', null, [h('label', { text: 'Opening balance printed on statement' }), op]), h('div', null, [h('label', { text: 'Closing balance printed on statement' }), cl]),
        h('button', { type: 'button', class: 'btn-s', text: 'Re-check', onclick: function () {
          var o = parseFloat(String(op.value).replace(/,/g, '')), c = parseFloat(String(cl.value).replace(/,/g, ''));
          S.vopts.opening = isFinite(o) ? o : null; S.vopts.closing = isFinite(c) ? c : null; revalidate(); refreshAll();
        } })]));
      if (S.parserMode === 'bank_specific' && S.rawText && v.status === 'failed' && window.BankReconExtract && BankReconExtract.rerunUniversal)
        card.appendChild(h('div', { class: 'rv-row', style: 'margin-top:10px' }, [h('button', { type: 'button', class: 'btn-s', text: 'Try the universal parser instead', onclick: function () { stopPolling(); BankReconExtract.rerunUniversal(S); } })]));
    }
    box.appendChild(card);
    var cf = document.getElementById('rv-conf'); if (cf) cf.textContent = 'Extraction confidence: ' + extractionConfidence();
  }
  function renderStats() {
    var c = E.counts(st), box = document.getElementById('rv-stats'); box.innerHTML = '';
    [['Transactions', c.total], ['In Suspense', c.suspense], ['Mapped', c.mapped], ['Locked', c.locked], ['Possible duplicates', c.duplicates]].forEach(function (x) {
      var b = h('b', { text: String(x[1]) }); if (window.FX) { b._fxv = ui.statPrev[x[0]] === undefined ? 0 : ui.statPrev[x[0]]; FX.countUp(b, x[1]); ui.statPrev[x[0]] = x[1]; }
      box.appendChild(h('div', { class: 'stat' }, [b, h('small', { text: x[0] })]));
    });
  }
  /* ---------- the four main actions ---------- */
  function computeGroups() { return SmartMapping.groupEntries(st, { learned: loadLearned() }); }
  function renderActions() {
    var box = document.getElementById('rv-actions'); if (!box) return; box.innerHTML = '';
    var groups = computeGroups(), withSug = groups.filter(function (g) { return g.suggestion && g.suggestion.ledger; }).length, pend = pendingSuggestions().length;
    function btn(cls, id, icon, title, sub, count, fn, extra) {
      return h('button', { type: 'button', class: 'abtn ' + cls + (extra || ''), id: id, onclick: fn }, [h('span', { class: 'ic', text: icon }), h('span', null, [h('b', { text: title }), h('small', { text: sub })]), h('span', { class: 'cnt', text: count ? String(count) : '' })]);
    }
    box.appendChild(btn('', 'btn-quick', '⚡', 'Quick clean-up', groups.length ? groups.length + ' groups · clear Suspense in bulk' : 'Nothing left in Suspense', groups.length, openQuick, withSug ? ' pulse' : ''));
    box.appendChild(btn('', 'btn-ai', '✨', 'AI Mapping', 'Let an AI suggest ledgers (optional)', pend, openAi));
    box.appendChild(btn('', 'btn-export', '⬇', 'Export', 'Download Tally XML or Excel', 0, openExport));
    box.appendChild(btn('gold', 'btn-push', '🚀', 'Push to Tally', ui.conn && ui.conn.tally ? 'One click — straight into ' + (ui.company || 'Tally') : 'Needs the Tally connector', 0, pushFlow));
  }

  /* ---------- Tally connection: status light + automatic ledger sync ---------- */
  var HELPER_DEFAULT = 'http://127.0.0.1:9911';
  var pollTimer = null;
  function helperBase() { return (ui.helperUrl || HELPER_DEFAULT).replace(/\/+$/, ''); }
  function fetchJson(path, opts, ms) {
    var ctl = new AbortController(); var t = setTimeout(function () { ctl.abort(); }, ms || 6000);
    return fetch(helperBase() + path, Object.assign({ signal: ctl.signal }, opts || {})).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); }).finally(function () { clearTimeout(t); });
  }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
  function startPolling() { stopPolling(); pollTally(); pollTimer = setInterval(function () { if (!document.hidden) pollTally(); }, 5000); }
  function tallyBar() {
    var p = h('section', { class: 'tbar', id: 'rv-tally' });
    var sel = h('select', { class: 'rv-select', id: 'tally-company', style: 'display:none', 'aria-label': 'Tally company', onchange: function () { ui.company = sel.value; ui.syncedFor = null; renderLight(); syncLedgers(); } });
    p.appendChild(h('div', { class: 'tl' }, [h('span', { class: 'tlight wait', id: 'tlight' }), h('div', null, [h('small', { id: 'tally-status', text: '' })])]));
    p.appendChild(h('div', { class: 'grow' }));
    p.appendChild(h('div', { id: 'tally-company-wrap', style: 'display:none' }, [h('label', { text: 'Company' }), sel]));
    p.appendChild(h('div', null, [h('label', { text: 'Ledgers' }), h('span', null, [h('button', { type: 'button', class: 'btn-s', id: 'tally-sync', text: '↻ Sync', disabled: true, onclick: function () { syncLedgers(); } }), ' ',
      h('button', { type: 'button', class: 'btn-s', id: 'tally-file', text: 'Load from file…', onclick: openLedgerFile })])]));
    var pk = ledgerPicker({ placeholder: 'Bank account ledger…', onPick: function (n) { S.bankLedger = n; markBank(); persist(); renderExport(); } });
    pk.input.id = 'bank-ledger'; pk.input.value = S.bankLedger || '';
    pk.input.addEventListener('input', function () { S.bankLedger = pk.input.value.trim(); markBank(); persist(); renderExport(); });
    p.appendChild(h('div', null, [h('label', { text: 'Bank account in Tally' }), pk]));
    p.appendChild(h('div', { id: 'tally-help', style: 'flex:1 1 100%' }));
    setTimeout(markBank, 0);
    return p;
  }
  function bankLedgerOk() { var b = (S.bankLedger || '').trim(); if (!b) return false; return st.ledgersSource === 'tally' ? E.ledgerExists(st, b) : true; }
  function markBank() { var i = document.getElementById('bank-ledger'); if (i) i.style.outline = (S.bankLedger && !bankLedgerOk()) ? '2px solid #E5533D' : ''; }
  function autoPickBank() {
    if (st.ledgersSource !== 'tally' || bankLedgerOk()) { markBank(); return; }
    var stop = { BANK: 1, LTD: 1, LIMITED: 1, THE: 1, CO: 1, OF: 1, AND: 1, INDIA: 1, CORPORATION: 1, PRIVATE: 1, PVT: 1 };
    function toks(s) { return String(s).toUpperCase().split(/[^A-Z]+/).filter(function (w) { return w.length >= 3 && !stop[w]; }); }
    var bt = toks(S.bank.name), bankish = st.ledgers.filter(function (n) { return /bank/i.test(ui.parents[n] || ''); });
    var named = bankish.filter(function (n) { return toks(n).some(function (t) { return bt.indexOf(t) >= 0; }); });
    var pick = named.length === 1 ? named[0] : (named.length === 0 && bankish.length === 1 ? bankish[0] : null);
    if (pick) { S.bankLedger = pick; var i = document.getElementById('bank-ledger'); if (i) i.value = pick; persist(); }
    markBank();
  }
  function setStatus(msg, kind) { var el = document.getElementById('tally-status'); if (el) el.textContent = msg || ''; ui.statusKind = kind || ''; }
  function renderLight() {
    var el = document.getElementById('tlight'); if (!el) return;
    var c = ui.conn, cls = 'tlight off', label = 'Tally not connected', help = null;
    if (!c) { cls = 'tlight wait'; label = 'Checking Tally…'; }
    else if (c.tally) { cls = 'tlight on'; label = 'Tally connected' + (ui.company ? ' — ' + ui.company : ''); }
    else if (c.connector) { label = 'Tally not reachable'; help = 'The connector is running, but Tally is not answering. Open Tally, open your company, and make sure the XML/ODBC server is on (port 9000).'; }
    el.className = cls; el.innerHTML = ''; el.appendChild(h('span', { class: 'dot' })); el.appendChild(document.createTextNode(label));
    var hb = document.getElementById('tally-help'); if (hb) {
      hb.innerHTML = '';
      if (c && !c.connector) hb.appendChild(h('div', { class: 'resume' }, [h('span', { text: 'To sync ledgers from Tally automatically and push entries in one click, download the small TaxNest connector, open it, and leave it running.' }),
        h('a', { class: 'btn-s', href: 'connector/TaxNest-Tally-Connector.zip', download: 'TaxNest-Tally-Connector.zip', text: '⬇ Download connector (Windows)' })]));
      else if (help) hb.appendChild(h('p', { class: 'rv-note', text: help }));
    }
    var sb = document.getElementById('tally-sync'); if (sb) sb.disabled = !(c && c.tally);
    if (!c) { setStatus('', ''); return; }
    if (c.tally) setStatus(st.ledgersSource === 'tally' ? st.ledgers.length + ' ledgers synced' : 'Syncing ledgers…', 'ok');
    else if (st.ledgersSource === 'none') setStatus('Not connected — you can keep working with ' + st.suspense + ' or load ledgers from a file.', '');
    else setStatus(st.ledgers.length + ' ledgers available (' + (st.ledgersSource === 'tally' ? 'last synced from Tally' : 'from your file') + ')', 'ok');
    renderActions();
  }
  function updateCompanySelect() {
    var sel = document.getElementById('tally-company'), wrap = document.getElementById('tally-company-wrap'); if (!sel || !ui.conn) return; var cs = ui.conn.companies || [];
    sel.innerHTML = ''; cs.forEach(function (c) { sel.appendChild(h('option', { value: c, text: c })); });
    if (wrap) wrap.style.display = cs.length > 1 ? '' : 'none'; if (ui.company) sel.value = ui.company;
  }
  function pollTally() {
    return fetchJson('/status', null, 4000).then(function (r) {
      var b = r.body || {}, t = b.tally || {}, was = ui.conn && ui.conn.tally;
      ui.conn = { connector: true, tally: !!t.reachable, companies: t.companies || [], error: t.error };
      if (ui.conn.tally && (!ui.company || ui.conn.companies.indexOf(ui.company) < 0) && ui.conn.companies.length) { ui.company = ui.conn.companies[0]; ui.syncedFor = null; }
      updateCompanySelect(); renderLight();
      if (ui.conn.tally && ui.syncedFor !== (ui.company || '*')) syncLedgers();
      if (ui.conn.tally && !was && window.FX) FX.burst(14);
    }).catch(function () { ui.conn = { connector: false, tally: false, companies: [] }; renderLight(); });
  }
  function syncLedgers() {
    var co = ui.company || ''; ui.syncedFor = co || '*'; setStatus('Syncing ledgers…', '');
    return fetchJson('/ledgers' + (co ? '?company=' + encodeURIComponent(co) : ''), null, 30000).then(function (r) {
      if (r.status !== 200 || !r.body.count) { setStatus((r.body && (r.body.warning || r.body.error)) || 'Tally returned no ledgers. Is a company open?', 'err'); return; }
      ui.parents = {}; r.body.ledgers.forEach(function (l) { ui.parents[l.name] = l.parent || ''; });
      ui.suspenseSeen = r.body.ledgers.some(function (l) { return String(l.name).toLowerCase() === st.suspense.toLowerCase(); });   // does Suspense really exist in Tally?
      E.setLedgers(st, r.body.ledgers.map(function (l) { return l.name; }), 'tally'); autoPickBank();
      setStatus(r.body.count + ' ledgers synced', 'ok'); persist(); renderLight(); renderAiGate(); renderExport(); renderQuick();
    }).catch(function (e) { setStatus('Could not sync ledgers: ' + e.message, 'err'); });
  }
  function useLedgerNames(names, source, what) {
    var n = E.setLedgers(st, names, source);
    setStatus(n + ' ledgers loaded ' + what + ' (not checked against Tally)', 'ok'); persist(); renderLight(); renderAiGate(); renderExport(); renderQuick();
  }
  function openLedgerFile() {
    var m = openModal({ name: 'ledgerfile', icon: '📂', title: 'Load ledgers from a file', subtitle: 'Use this when the connector is not running', size: 'sm' });
    m.body.appendChild(h('p', { class: 'rv-note', text: 'In Tally: Gateway of Tally › Display More Reports › List of Accounts › Ledgers, then Alt+E (Export) and choose XML or HTML. Upload that file here — you will see a preview before anything is used.' }));
    var file = h('input', { type: 'file', accept: '.xml,.html,.htm,.txt,.csv', hidden: true, onchange: function () { var f = file.files[0]; file.value = ''; if (f) { importLedgerFile(f, m); } } });
    m.body.appendChild(h('div', { class: 'rv-row' }, [h('button', { type: 'button', class: 'btn-p', text: 'Choose Tally export (XML / HTML)', onclick: function () { file.click(); } }), file]));
    var ta = h('textarea', { class: 'rv-input', id: 'ledger-paste', rows: '4', style: 'width:100%;margin-top:14px', placeholder: 'Or paste ledger names, one per line' }); m.body.appendChild(ta);
    m.body.appendChild(h('div', { class: 'rv-row', style: 'margin-top:8px' }, [h('button', { type: 'button', class: 'btn-s', text: 'Use pasted names', onclick: function () {
      var names = ta.value.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean); if (!names.length) return; useLedgerNames(names, 'manual', 'from your list'); m.close();
    } })]));
  }
  function importLedgerFile(file, parentModal) {
    file.arrayBuffer().then(function (buf) {
      var res = LedgerImport.parseLedgerFile(new Uint8Array(buf), file.name);
      var ta = h('textarea', { class: 'rv-input', rows: '10', style: 'width:100%;font-family:var(--mono);font-size:.8rem' }); ta.value = res.names.join('\n');
      var body = [h('p', { text: res.names.length ? 'Found ' + res.names.length + ' ledger name(s) in this ' + res.format.toUpperCase() + ' file. Delete any line that is not a ledger, then continue.' : 'No ledger names could be recognised in this file.' })]
        .concat(res.notes.map(function (n) { return h('p', { class: 'rv-note', text: n }); }), [ta]);
      dialog('Ledgers found in ' + file.name, body, [{ label: 'Cancel', value: false }, { label: 'Use these ledgers', value: true, primary: true }]).then(function (ok) {
        if (!ok) return; var names = ta.value.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
        if (!names.length) return; useLedgerNames(names, 'file', 'from ' + file.name); if (parentModal) parentModal.close();
      });
    }).catch(function (e) { setStatus('Could not read that file: ' + e.message, 'err'); });
  }

  /* ---------- filters ---------- */
  function filterPanel() {
    var f = ui.filters, p = h('section', { class: 'rv-panel', id: 'rv-filters' });
    p.appendChild(h('h2', { text: 'Filter transactions' }));
    function bind(el, key, isCheck) { el.addEventListener(isCheck ? 'change' : 'input', function () { f[key] = isCheck ? el.checked : el.value; applyFilterState(true); }); return el; }
    var op = h('select', { class: 'rv-select', 'aria-label': 'Narration match type' }, [['contains', 'Narration contains'], ['not_contains', 'Does not contain'], ['starts_with', 'Starts with'], ['exact', 'Exact match']].map(function (o) { return h('option', { value: o[0], text: o[1], selected: f.narrOp === o[0] }); }));
    op.addEventListener('change', function () { f.narrOp = op.value; applyFilterState(true); });
    p.appendChild(h('div', { class: 'rv-row' }, [
      h('div', null, [h('label', { class: 'rv-lbl', text: 'Match' }), op]),
      h('div', { class: 'grow' }, [h('label', { class: 'rv-lbl', text: 'Text (not case-sensitive)' }), bind(h('input', { type: 'text', class: 'rv-input', id: 'f-narr', style: 'width:100%', placeholder: 'e.g. charges', value: f.narr }), 'narr')]),
      h('div', null, [h('label', { class: 'rv-lbl', text: 'Debit >' }), bind(h('input', { type: 'text', class: 'rv-input', style: 'width:100px', inputmode: 'decimal', value: f.debitGt }), 'debitGt')]),
      h('div', null, [h('label', { class: 'rv-lbl', text: 'Credit >' }), bind(h('input', { type: 'text', class: 'rv-input', style: 'width:100px', inputmode: 'decimal', value: f.creditGt }), 'creditGt')]),
      h('div', null, [h('label', { class: 'rv-lbl', text: 'From' }), bind(h('input', { type: 'date', class: 'rv-input', value: f.from }), 'from')]),
      h('div', null, [h('label', { class: 'rv-lbl', text: 'To' }), bind(h('input', { type: 'date', class: 'rv-input', value: f.to }), 'to')]),
      h('div', null, [h('label', { class: 'rv-lbl', text: 'Ledger contains' }), bind(h('input', { type: 'text', class: 'rv-input', style: 'width:140px', value: f.ledger }), 'ledger')])]));
    function chk(key, label) { return h('label', null, [bind(h('input', { type: 'checkbox', checked: f[key] }), key, true), label]); }
    p.appendChild(h('div', { class: 'rv-chips' }, [chk('suspenseOnly', 'Suspense only'), chk('unmapped', 'Not yet mapped'), chk('dups', 'Possible duplicates'), chk('rebuilt', 'Rebuilt from balance'), chk('excludedOnly', 'Excluded rows'),
      h('span', { id: 'ref-chip' }),
      h('button', { type: 'button', class: 'btn-s', text: 'Clear filters', onclick: function () { clearFilters(); } })]));
    return p;
  }
  function clearFilters() {
    var f = ui.filters; Object.keys(f).forEach(function (k) { f[k] = typeof f[k] === 'boolean' ? false : (k === 'narrOp' ? 'contains' : ''); }); ui.refFilter = null; ui.refLabel = '';
    var old = document.getElementById('rv-filters'); old.replaceWith(filterPanel()); applyFilterState(true);
  }
  function buildFilterList() {
    var f = ui.filters, list = [];
    if (f.narr.trim()) list.push({ field: 'narration', op: f.narrOp, value: f.narr });
    if (f.debitGt.trim()) list.push({ field: 'debit', op: 'gt', value: f.debitGt });
    if (f.creditGt.trim()) list.push({ field: 'credit', op: 'gt', value: f.creditGt });
    if (f.ledger.trim()) list.push({ field: 'ledger', op: 'contains', value: f.ledger });
    if (f.suspenseOnly) list.push({ field: 'ledger', op: 'is_suspense' });
    if (f.unmapped) list.push({ field: 'ledger', op: 'unmapped' });
    if (f.dups) list.push({ field: 'ledger', op: 'duplicates' });
    if (f.rebuilt) list.push({ field: 'ledger', op: 'reconstructed' });
    if (f.excludedOnly) list.push({ field: 'ledger', op: 'excluded' });
    if (ui.refFilter) list.push({ field: 'ledger', op: 'refs', refs: ui.refFilter });
    var range = null; if (f.from || f.to) range = { from: f.from.replace(/-/g, ''), to: f.to.replace(/-/g, '') };
    return { list: list, range: range };
  }
  function applyFilterState(resetPage) {
    var b = buildFilterList(); ui.filtered = E.applyFilters(st, b.list, b.range);
    if (resetPage) ui.page = 0;
    renderTable(); renderBulk(); renderRefChip();
  }
  function renderRefChip() {
    var c = document.getElementById('ref-chip'); if (!c) return; c.innerHTML = '';
    if (ui.refFilter) c.appendChild(h('span', { class: 'badge-pill gold' }, ['Showing group: ' + ui.refLabel + ' ', h('button', { type: 'button', class: 'ico', text: '✕', onclick: function () { ui.refFilter = null; ui.refLabel = ''; applyFilterState(true); } })]));
  }

  /* ---------- table (paged, full narration visible) ---------- */
  function tableBlock() {
    var wrap = h('div', { id: 'rv-table' });
    wrap.appendChild(h('div', { class: 'bulkbar', id: 'bulkbar' }));
    var box = h('div', { class: 'vt-wrap' });
    box.appendChild(h('div', { class: 'pager', id: 'pager-top' }));
    box.appendChild(h('div', { class: 'vt-head' }, [h('span', null, [h('input', { type: 'checkbox', id: 'vt-all', title: 'Select / unselect every filtered row', 'aria-label': 'Select all filtered rows', onchange: function (ev) {
      ui.filtered.forEach(function (e) { if (ev.target.checked) ui.selected[e.reference_no] = 1; else delete ui.selected[e.reference_no]; }); renderTable(); renderBulk();
    } })]), h('span', { text: 'Ref' }), h('span', { text: 'Date' }), h('span', { text: 'Narration' }), h('span', { style: 'text-align:right', text: 'Debit' }), h('span', { style: 'text-align:right', text: 'Credit' }),
      h('span', { style: 'text-align:right', text: 'Balance' }), h('span', { text: 'Tally ledger' }), h('span', { text: 'Source' })]));
    box.appendChild(h('div', { id: 'vt-list' }));
    box.appendChild(h('div', { class: 'vt-empty', id: 'vt-empty', hidden: true }));
    box.appendChild(h('div', { class: 'pager', id: 'pager-bottom' }));
    wrap.appendChild(box); return wrap;
  }
  var SRC_LABEL = { default: 'default', manual: 'manual', bulk_manual: 'bulk', tally: 'tally', ai: 'ai', imported_ai: 'AI import' };
  function rowEl(e) {
    var sus = e.ledger_name === st.suspense;
    var cb = h('input', { type: 'checkbox', checked: !!ui.selected[e.reference_no], 'aria-label': 'Select ' + e.reference_no, onchange: function (ev) { if (ev.target.checked) ui.selected[e.reference_no] = 1; else delete ui.selected[e.reference_no]; renderBulk(); } });
    var isDup = (e.flags || []).indexOf('possible_duplicate') !== -1;
    var kids = [e.narration];
    if (e.reconstructed) kids.push(h('span', { class: 'rb-badge', title: e.reconstructed_reason || 'Amount and direction were rebuilt from the balance change', text: 'rebuilt from balance' }));
    if (e.no_balance_effect) kids.push(h('span', { class: 'dup-badge', title: 'The balance did not change on this row', text: 'no balance change' }));
    if (isDup) kids.push(h('span', { class: 'dup-badge', text: 'possible duplicate' }));
    if (e.refNo) kids.push(h('small', { text: e.refNo }));
    var narr = h('span', { class: 'narr' }, kids);
    var ledgerCell = h('span', { class: 'ledger' + (sus ? ' sus' : ''), title: 'Click to change ledger', text: e.ledger_name, onclick: function () { editLedger(ledgerCell, e); } });
    var acts = [h('span', { class: 'src', text: (e.mapping_locked ? '🔒 ' : '') + (SRC_LABEL[e.ledger_source] || e.ledger_source) }),
      h('button', { type: 'button', class: 'ico', title: 'Swap Debit/Credit for this row', text: '⇄', onclick: function () { e.drCr = e.drCr === 'D' ? 'C' : 'D'; revalidate(); refreshAll(); } }),
      h('button', { type: 'button', class: 'ico', title: e.excluded ? 'Include in export' : 'Exclude from export', text: e.excluded ? '+' : '×', onclick: function () { e.excluded = !e.excluded; refreshAll(); } })];
    if (isDup) acts.push(h('button', { type: 'button', class: 'ico', title: 'Not a duplicate', text: '✓', onclick: function () { e.flags = (e.flags || []).filter(function (f) { return f !== 'possible_duplicate'; }); refreshAll(); } }));
    return h('div', { class: 'vt-row' + (e.excluded ? ' excluded' : '') + (e.reconstructed ? ' rebuilt' : ''), 'data-ref': e.reference_no }, [
      h('span', null, [cb]), h('span', { class: 'ref', text: e.reference_no }), h('span', { text: dmy(e.date) }), narr,
      h('span', { class: 'num', text: e.drCr === 'D' ? inr(e.amount) : '' }), h('span', { class: 'num', text: e.drCr === 'C' ? inr(e.amount) : '' }),
      h('span', { class: 'num', text: typeof e.balance === 'number' ? inr(e.balance) : '' }), ledgerCell, h('span', { class: 'act' }, acts)]);
  }
  function editLedger(cell, e) {
    var pk = ledgerPicker({ placeholder: 'Search ledger…', onPick: function (n) {
      var r = E.assignLedger(st, [e.reference_no], n, 'manual'); if (!r.ok) { alert(r.error); return; } flash([e.reference_no]); refreshAll();
    }, onCancel: function () { renderTable(); } });
    cell.replaceWith(pk); pk.input.focus();
  }
  function flash(refs) { ui.flashRefs = {}; refs.slice(0, 500).forEach(function (r) { ui.flashRefs[r] = 1; }); setTimeout(function () { ui.flashRefs = null; Array.prototype.forEach.call(document.querySelectorAll('.vt-row.flash'), function (r) { r.classList.remove('flash'); }); }, 900); }
  function renderPager() {
    var n = ui.filtered.length, pages = Math.max(1, Math.ceil(n / ui.pageSize)), from = n ? ui.page * ui.pageSize + 1 : 0, to = Math.min(n, (ui.page + 1) * ui.pageSize);
    ['pager-top', 'pager-bottom'].forEach(function (id) {
      var el = document.getElementById(id); if (!el) return; el.innerHTML = '';
      var size = h('select', { class: 'rv-select', 'aria-label': 'Rows per page', onchange: function (ev) { ui.pageSize = +ev.target.value; ui.page = 0; renderTable(); } }, [50, 100, 250, 500].map(function (v) { return h('option', { value: String(v), text: v + ' per page', selected: ui.pageSize === v }); }));
      function go(p) { return function () { ui.page = Math.max(0, Math.min(pages - 1, p)); renderTable(); if (id === 'pager-bottom') document.getElementById('rv-table').scrollIntoView({ block: 'start' }); }; }
      el.appendChild(h('span', { text: n ? 'Rows ' + from + '–' + to + ' of ' + n + (n !== st.entries.length ? ' (filtered from ' + st.entries.length + ')' : '') : 'No rows' }));
      el.appendChild(h('span', { class: 'pg' }, [size, h('button', { type: 'button', class: 'btn-s', text: '«', disabled: ui.page === 0, onclick: go(0) }), h('button', { type: 'button', class: 'btn-s', text: '‹', disabled: ui.page === 0, onclick: go(ui.page - 1) }),
        h('span', { text: 'Page ' + (ui.page + 1) + ' / ' + pages }), h('button', { type: 'button', class: 'btn-s', text: '›', disabled: ui.page >= pages - 1, onclick: go(ui.page + 1) }), h('button', { type: 'button', class: 'btn-s', text: '»', disabled: ui.page >= pages - 1, onclick: go(pages - 1) })]));
    });
  }
  function renderTable() {
    var list = ui.filtered, box = document.getElementById('vt-list'); if (!box) return;
    var pages = Math.max(1, Math.ceil(list.length / ui.pageSize)); if (ui.page > pages - 1) ui.page = pages - 1;
    var slice = list.slice(ui.page * ui.pageSize, (ui.page + 1) * ui.pageSize), frag = document.createDocumentFragment();
    slice.forEach(function (e) { var r = rowEl(e); if (ui.flashRefs && ui.flashRefs[e.reference_no]) r.classList.add('flash'); if (ui.jumpRef === e.reference_no) r.classList.add('jump'); frag.appendChild(r); });
    box.innerHTML = ''; box.appendChild(frag);
    var empty = document.getElementById('vt-empty');
    if (!list.length) { empty.hidden = false; empty.textContent = st.entries.length ? 'No transactions match the current filters.' : 'No transactions found.'; } else empty.hidden = true;
    var all = document.getElementById('vt-all'); if (all) all.checked = list.length > 0 && list.every(function (e) { return ui.selected[e.reference_no]; });
    renderPager();
  }
  function jumpTo(ref) {
    var f = ui.filters; Object.keys(f).forEach(function (k) { f[k] = typeof f[k] === 'boolean' ? false : (k === 'narrOp' ? 'contains' : ''); }); ui.refFilter = null;
    document.getElementById('rv-filters').replaceWith(filterPanel()); applyFilterState(true);
    var idx = ui.filtered.findIndex(function (e) { return e.reference_no === ref; }); if (idx < 0) return;
    ui.page = Math.floor(idx / ui.pageSize); ui.jumpRef = ref; renderTable();
    var row = document.querySelector('.vt-row[data-ref="' + ref + '"]'); if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(function () { ui.jumpRef = null; var r = document.querySelector('.vt-row.jump'); if (r) r.classList.remove('jump'); }, 2500);
  }

  /* ---------- quick clean-up (popup): same-narration groups ---------- */
  var LEARN_KEY = 'taxnest_learned_v1';
  function loadLearned() { try { return JSON.parse(localStorage.getItem(LEARN_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function saveLearned(o) { try { localStorage.setItem(LEARN_KEY, JSON.stringify(o)); } catch (e) {} }
  function openQuick() {
    var m = openModal({ name: 'quick', icon: '⚡', title: 'Quick clean-up', subtitle: 'Transactions with the same payee are grouped — assign a whole group in one click' });
    m.body.appendChild(h('div', { id: 'quick-body' })); renderQuick();
  }
  function renderQuick() {
    var body = document.getElementById('quick-body'); if (!body || !modalIs('quick')) { renderActions(); return; } body.innerHTML = '';
    var groups = computeGroups();
    // groups that already have a suggested ledger come first: they are the one-click wins
    groups = groups.filter(function (g) { return g.suggestion && g.suggestion.ledger; }).concat(groups.filter(function (g) { return !(g.suggestion && g.suggestion.ledger); })); ui.groups = groups;
    var locked = st.entries.filter(function (e) { return e.mapping_locked; }).length;
    var total = groups.reduce(function (a, g) { return a + g.count; }, 0), withSug = groups.filter(function (g) { return g.suggestion && g.suggestion.ledger; });
    var sugCount = withSug.reduce(function (a, g) { return a + g.count; }, 0);
    if (!groups.length) { body.appendChild(h('p', { class: 'rv-note ok', text: 'Nothing left in ' + st.suspense + ' to group. 🎉' })); }
    else {
      body.appendChild(h('div', { class: 'qhead' }, [h('span', { class: 'rv-note', text: groups.length + ' groups · ' + total + ' transactions still in ' + st.suspense + (locked ? '  ·  🔒 ' + locked + ' you mapped manually are locked and never changed here' : '') }),
        h('label', { class: 'rv-chips', style: 'margin:0' }, [h('input', { type: 'checkbox', checked: ui.remember, onchange: function (ev) { ui.remember = ev.target.checked; } }), 'Remember my choices']),
        h('button', { type: 'button', class: 'btn-p btn-gold', style: 'margin-left:auto', text: 'Apply all suggestions (' + withSug.length + ' groups · ' + sugCount + ')', disabled: !withSug.length, onclick: function () { applySuggestions(withSug); } })]));
      if (st.ledgersSource === 'none') body.appendChild(h('p', { class: 'rv-note err', text: 'Load your Tally ledgers first (connect Tally, or "Load from file…" at the top) — groups can only be assigned to ledgers that exist.' }));
      groups.slice(0, ui.quickShown).forEach(function (g) { body.appendChild(groupRow(g)); });
      if (groups.length > ui.quickShown) body.appendChild(h('button', { type: 'button', class: 'btn-s', style: 'margin-top:12px', text: 'Show more groups (' + (groups.length - ui.quickShown) + ' left)', onclick: function () { ui.quickShown += 30; renderQuick(); } }));
    }
    renderActions();
  }
  function groupRow(g) {
    var chosen = '';
    var pk = ledgerPicker({ placeholder: 'Choose ledger…', onPick: function (n) { chosen = n; } });
    var sug = g.suggestion, chip = null;
    if (sug && sug.ledger) chip = h('button', { type: 'button', class: 'sugchip', title: sug.reason, text: '💡 ' + sug.ledger + ' (' + sug.source + ')', onclick: function () { chosen = sug.ledger; pk.input.value = sug.ledger; } });
    else if (sug && sug.ambiguous) chip = h('span', { class: 'sugchip amb', title: sug.ambiguous.join(', '), text: '💡 several possible: ' + sug.ambiguous.slice(0, 2).join(', ') + '…' });
    var btn = h('button', { type: 'button', class: 'btn-p btn-gold', text: 'Assign ' + g.count, onclick: function () {
      var name = E.canonicalLedger(st, pk.input.value || chosen); if (!name) { alert('Pick a ledger from the list — only ledgers that exist can be used.'); return; }
      assignGroup(g, name);
    } });
    var view = h('button', { type: 'button', class: 'btn-s', text: 'View', title: 'Show these rows in the table', onclick: function () {
      ui.refFilter = {}; g.refs.forEach(function (r) { ui.refFilter[r] = 1; }); ui.refLabel = g.label; ui.selected = {}; if (ui.modal) ui.modal.close(); applyFilterState(true); setTimeout(function () { document.getElementById('rv-filters').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 200);
    } });
    // five fixed columns: count | description (wraps freely) | ledger | assign | view  -> buttons never move
    return h('div', { class: 'grp' }, [
      h('div', { class: 'cnt' }, [String(g.count), h('small', { text: 'entries' })]),
      h('div', null, [h('div', { class: 'lbl' }, [h('span', { class: 'dirb ' + g.dir, text: g.dir === 'D' ? 'Dr' : 'Cr' }), g.label]),
        h('div', { class: 'smp', text: g.samples.join('  ·  ') }), h('div', { class: 'tot', text: (g.dir === 'D' ? '₹' + inr(g.debit) + ' paid' : '₹' + inr(g.credit) + ' received') + ' · ' + dmy(g.first) + (g.first !== g.last ? ' → ' + dmy(g.last) : '') }),
        chip ? h('div', { class: 'sugrow' }, [chip]) : null]),
      pk, btn, view]);
  }
  function assignGroup(g, name) {
    confirmDialog('Assign group', [h('p', null, [h('strong', { text: g.count + ' transactions' }), ' — ' + g.label]), h('p', null, ['Assign ledger: ', h('strong', { text: name })])]).then(function (ok) {
      if (!ok) return; E.assignLedger(st, g.refs, name, 'bulk_manual'); if (ui.remember) { var l = loadLearned(); SmartMapping.learn(l, g.key, name); saveLearned(l); } flash(g.refs); refreshAll();
    });
  }
  function applySuggestions(groups) {
    var n = groups.reduce(function (a, g) { return a + g.count; }, 0);
    var lines = groups.slice(0, 12).map(function (g) { return h('li', { text: g.count + ' × ' + g.label.slice(0, 40) + '  →  ' + g.suggestion.ledger + ' (' + g.suggestion.source + ')' }); });
    confirmDialog('Apply all suggestions', [h('p', null, [h('strong', { text: groups.length + ' groups / ' + n + ' transactions' }), ' will be assigned as suggested:']), h('ul', null, lines),
      groups.length > 12 ? h('p', { class: 'rv-note', text: '…and ' + (groups.length - 12) + ' more groups. You can still change any entry afterwards.' }) : null], 'Apply').then(function (ok) {
      if (!ok) return; var l = loadLearned();
      groups.forEach(function (g) { E.assignLedger(st, g.refs, g.suggestion.ledger, 'bulk_manual'); if (ui.remember) SmartMapping.learn(l, g.key, g.suggestion.ledger); });
      if (ui.remember) saveLearned(l); refreshAll();
    });
  }

  /* ---------- bulk bar ---------- */
  function effectiveSelection() { return ui.filtered.filter(function (e) { return ui.selected[e.reference_no]; }); }
  function renderBulk() {
    var bar = document.getElementById('bulkbar'); if (!bar) return; bar.innerHTML = '';
    var sel = effectiveSelection(), nF = ui.filtered.length;
    bar.appendChild(h('span', { class: 'cnt', text: sel.length + ' selected' }));
    bar.appendChild(h('span', { text: 'of ' + nF + ' shown' }));
    bar.appendChild(h('button', { type: 'button', class: 'btn-s', text: 'Select all shown', onclick: function () { ui.filtered.forEach(function (e) { ui.selected[e.reference_no] = 1; }); renderTable(); renderBulk(); } }));
    bar.appendChild(h('button', { type: 'button', class: 'btn-s', text: 'Clear', onclick: function () { ui.selected = {}; renderTable(); renderBulk(); } }));
    var pk = ledgerPicker({ placeholder: 'Assign ledger…', onPick: function (n) { ui.bulkLedger = n; } });
    if (ui.bulkLedger) pk.input.value = ui.bulkLedger;
    bar.appendChild(pk);
    bar.appendChild(h('button', { type: 'button', class: 'btn-p btn-gold', text: 'Assign', disabled: !sel.length, onclick: function () {
      var name = E.canonicalLedger(st, pk.input.value); if (!name) { alert('Pick a ledger from the list — only ledgers that exist can be used.'); return; }
      var locked = sel.filter(function (e) { return e.mapping_locked && e.ledger_name !== name; }).length;
      confirmDialog('Assign ledger', [h('p', null, [h('strong', { text: sel.length + ' transactions' }), ' selected.']), h('p', null, ['Assign ledger: ', h('strong', { text: name })]),
        locked ? h('p', { class: 'rv-note', text: locked + ' of them were already mapped manually and will be overwritten.' }) : null]).then(function (ok) {
        if (!ok) return; var refs = sel.map(function (e) { return e.reference_no; }); E.assignLedger(st, refs, name, refs.length > 1 ? 'bulk_manual' : 'manual'); flash(refs); ui.bulkLedger = ''; refreshAll();
      });
    } }));
    bar.appendChild(h('button', { type: 'button', class: 'btn-s', text: 'Back to Suspense', disabled: !sel.length, onclick: function () {
      confirmDialog('Reset to Suspense', [sel.length + ' transactions will go back to ' + st.suspense + ' and be unlocked.'], 'Reset').then(function (ok) { if (ok) { E.resetToSuspense(st, sel.map(function (e) { return e.reference_no; })); refreshAll(); } });
    } }));
  }

  /* ---------- AI mapping (popup) ---------- */
  function openAi() {
    var m = openModal({ name: 'ai', icon: '✨', title: 'AI Mapping Assistant', subtitle: 'Optional — you stay in control: nothing is applied until you accept it' });
    var p = m.body;
    p.appendChild(h('p', { class: 'rv-note', text: 'AI Mapping will use your transaction data to generate ledger suggestions. This tool never sends anything itself: you download a file and give it to an AI of your choice (a local one if you prefer). Review that service\'s data policy first.' }));
    var consent = h('input', { type: 'checkbox', id: 'ai-consent', checked: ui.aiConsent, onchange: function () { ui.aiConsent = consent.checked; renderAiGate(); } });
    p.appendChild(h('label', { class: 'rv-chips' }, [consent, 'I understand and want to create the AI mapping package.']));
    var scope = h('select', { class: 'rv-select', id: 'ai-scope', onchange: function () { ui.aiScope = scope.value; } }, [['all', 'All transactions'], ['suspense', 'Only transactions still in Suspense'], ['shown', 'Only the transactions currently shown in the table']].map(function (o) { return h('option', { value: o[0], text: o[1], selected: ui.aiScope === o[0] }); }));
    p.appendChild(h('div', { class: 'rv-row', style: 'margin-top:10px' }, [h('div', null, [h('label', { class: 'rv-lbl', text: 'Include' }), scope]),
      h('button', { type: 'button', class: 'btn-p', id: 'ai-dl', text: '⬇ Download AI input (.json) + prompt (.txt)', onclick: downloadAiPackage }),
      h('button', { type: 'button', class: 'btn-s', id: 'ai-copy', text: 'Copy prompt', onclick: function () { navigator.clipboard && navigator.clipboard.writeText(E.buildAiPromptText()).then(function () { aiNote('Prompt copied.', 'ok'); }); } })]));
    p.appendChild(h('p', { class: 'rv-note', id: 'ai-note' }));
    var up = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: function () { var f = up.files[0]; up.value = ''; if (f) f.text().then(importAiResult); } });
    p.appendChild(h('div', { class: 'rv-row', style: 'margin-top:8px' }, [h('button', { type: 'button', class: 'btn-s', id: 'ai-up', text: '⬆ Upload AI result (.json)', onclick: function () { up.click(); } }), up]));
    p.appendChild(h('div', { id: 'ai-results' }));
    renderAiGate(); renderAiResults();
  }
  function aiNote(msg, kind) { var n = document.getElementById('ai-note'); if (n) { n.textContent = msg; n.className = 'rv-note ' + (kind || ''); } }
  function renderAiGate() {
    var dl = document.getElementById('ai-dl'), cp = document.getElementById('ai-copy'); if (!dl) return;
    var hasLedgers = st.ledgersSource !== 'none' && st.ledgers.length > 1;
    dl.disabled = !(ui.aiConsent && hasLedgers); cp.disabled = !ui.aiConsent;
    if (!hasLedgers) aiNote('Load your Tally ledgers first (connect Tally or paste names) — the AI may only choose ledgers that really exist.', ''); else if (!ui.aiConsent) aiNote('Tick the box above to enable the download.', ''); else aiNote('', '');
  }
  function aiRefs() {
    var live = st.entries.filter(function (e) { return !e.excluded; });
    if (ui.aiScope === 'suspense') live = live.filter(function (e) { return e.ledger_name === st.suspense; });
    else if (ui.aiScope === 'shown') { var shown = {}; ui.filtered.forEach(function (e) { shown[e.reference_no] = 1; }); live = live.filter(function (e) { return shown[e.reference_no]; }); }
    return live.map(function (e) { return e.reference_no; });
  }
  function exportStem() {
    var ds = st.entries.map(function (e) { return e.date; }).sort(); var mon = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var a = (S.statement && S.statement.period_start) || ds[0] || '', b = (S.statement && S.statement.period_end) || ds[ds.length - 1] || '';
    var label = !a ? 'Statement' : (a.slice(0, 6) === b.slice(0, 6) ? mon[+a.slice(4, 6) - 1] + '_' + a.slice(0, 4) : mon[+a.slice(4, 6) - 1].slice(0, 3) + '_' + a.slice(0, 4) + '_to_' + mon[+b.slice(4, 6) - 1].slice(0, 3) + '_' + b.slice(0, 4));
    return safeName(S.bank.name) + '_' + label;
  }
  function downloadAiPackage() {
    var refs = aiRefs(); if (!refs.length) { aiNote('Nothing to include with that scope.', 'err'); return; }
    var info = { bank: S.bank.name, period_start: S.statement && S.statement.period_start || null, period_end: S.statement && S.statement.period_end || null, bank_ledger: S.bankLedger || null };
    var pkg = E.buildAiInput(st, info, refs); var stem = safeName(S.bank.name) + '_' + exportStem().replace(safeName(S.bank.name) + '_', '');
    download('taxnest_ai_mapping_input_' + stem + '.json', 'application/json', JSON.stringify(pkg, null, 2));
    download('taxnest_ai_mapping_prompt_' + stem + '.txt', 'text/plain', E.buildAiPromptText() + '\nAttach the JSON file "taxnest_ai_mapping_input_' + stem + '.json" and reply with the result JSON only. Save your reply as taxnest_ai_mapping_result_' + stem + '.json.\n');
    aiNote(pkg.transactions.length + ' transactions packaged. Give both files to your AI, save its JSON reply, then upload it here.', 'ok');
  }
  function importAiResult(text) {
    var v = E.validateAiResult(st, text); ui.aiValidation = v;
    if (v.fatal) { aiNote('AI result rejected: ' + v.fatal, 'err'); renderAiResults(); return; }
    E.stageAiSuggestions(st, v); ui.aiTab = 'high'; ui.aiShown = 100; aiNote('AI result imported and validated. Nothing is applied until you accept it.', 'ok'); refreshAll();
  }
  function pendingSuggestions() { return st.entries.filter(function (e) { return e.ai_suggestion && e.ai_suggestion.status === 'pending'; }); }
  function tabOf(e) {
    var s = e.ai_suggestion, t = st.aiThreshold;
    if (s.forced || s.ledger === st.suspense) return 'low'; if (s.confidence >= t.high) return 'high'; if (s.confidence >= t.review) return 'review'; return 'low';
  }
  function renderAiResults() {
    var box = document.getElementById('ai-results'); if (!box) return; box.innerHTML = '';
    var v = ui.aiValidation; var pend = pendingSuggestions();
    if (!v && !pend.length) return;
    var t = st.aiThreshold, sum = v && v.summary;
    box.appendChild(h('h2', { style: 'margin-top:16px', text: 'AI mapping imported' }));
    if (sum) box.appendChild(h('div', { class: 'rv-stats' }, [['Total transactions', sum.total_in_statement], ['Usable', sum.usable], ['High confidence', sum.high_confidence], ['Needs review', sum.needs_review], ['Suspense', sum.suspense], ['Invalid/rejected', sum.rejected], ['Not returned', sum.missing]].map(function (x) {
      return h('div', { class: 'stat' }, [h('b', { text: String(x[1]) }), h('small', { text: x[0] })]); })));
    // thresholds
    function thr(label, key) { var i = h('input', { type: 'number', class: 'rv-input', style: 'width:70px', min: '0', max: '1', step: '0.05', value: String(t[key]), onchange: function () { var n = parseFloat(i.value); if (isFinite(n)) { t[key] = Math.max(0, Math.min(1, n)); refreshAll(); } } }); return h('div', null, [h('label', { class: 'rv-lbl', text: label }), i]); }
    box.appendChild(h('div', { class: 'rv-row' }, [thr('High confidence ≥', 'high'), thr('Review recommended ≥', 'review'),
      h('button', { type: 'button', class: 'btn-p', text: 'Accept all valid mappings', disabled: !pend.length, onclick: acceptAllFlow }),
      h('button', { type: 'button', class: 'btn-s', text: 'Review one by one', disabled: !pend.length, onclick: oneByOne })]));
    box.appendChild(h('p', { class: 'rv-note', text: 'Confidence bands are workflow thresholds, not calibrated probabilities. Confidence below the review level stays in Suspense/manual review.' }));
    var groups = { high: [], review: [], low: [] }; pend.forEach(function (e) { groups[tabOf(e)].push(e); });
    var issues = v ? v.issues : [];
    var tabs = h('div', { class: 'tabs' }, [['high', 'High (' + groups.high.length + ')'], ['review', 'Review (' + groups.review.length + ')'], ['low', 'Low / Suspense (' + groups.low.length + ')'], ['issues', 'Issues (' + issues.length + ')']].map(function (x) {
      return h('button', { type: 'button', class: 'tab' + (ui.aiTab === x[0] ? ' on' : ''), text: x[1], onclick: function () { ui.aiTab = x[0]; ui.aiShown = 100; renderAiResults(); } }); }));
    box.appendChild(tabs);
    if (ui.aiTab === 'issues') {
      if (!issues.length) box.appendChild(h('p', { class: 'rv-note', text: 'No issues.' }));
      issues.slice(0, 200).forEach(function (i) { box.appendChild(h('p', { class: 'rv-note ' + (i.severity === 'rejected' ? 'err' : ''), text: i.ref + ' — ' + i.message })); });
      return;
    }
    var list = groups[ui.aiTab]; if (!list.length) { box.appendChild(h('p', { class: 'rv-note', text: 'Nothing in this group.' })); return; }
    list.slice(0, ui.aiShown).forEach(function (e) { box.appendChild(sugRow(e)); });
    if (list.length > ui.aiShown) box.appendChild(h('button', { type: 'button', class: 'btn-s', text: 'Show more (' + (list.length - ui.aiShown) + ' left)', onclick: function () { ui.aiShown += 200; renderAiResults(); } }));
  }
  function sugRow(e) {
    var s = e.ai_suggestion, locked = e.mapping_locked;
    return h('div', { class: 'sug' }, [h('span', { class: 'ref', text: e.reference_no }), h('span', { title: e.narration, text: e.narration.slice(0, 70) + ' · ' + (e.drCr === 'D' ? '−' : '+') + inr(e.amount) }),
      h('span', { text: s.ledger + (s.forced ? ' ⚑' : '') }), h('span', { text: Math.round(s.confidence * 100) + '%' }), h('span', { class: 'reason', text: (locked ? '🔒 Manually locked. ' : '') + s.reason }),
      h('span', { class: 'act' }, [
        h('button', { type: 'button', class: 'ico', text: 'Accept', onclick: function () { var r = E.acceptSuggestion(st, e.reference_no); if (!r.ok && r.reason === 'locked') { confirmDialog('Overwrite manual mapping?', ['This transaction was mapped manually (currently ' + e.ledger_name + '). Replace it with ' + s.ledger + '?'], 'Overwrite').then(function (ok) { if (ok) { E.acceptSuggestion(st, e.reference_no, { force: true }); refreshAll(); } }); } else refreshAll(); } }),
        h('button', { type: 'button', class: 'ico', text: 'Change', onclick: function (ev) { var cell = ev.target.parentNode; var pk = ledgerPicker({ onPick: function (n) { E.assignLedger(st, [e.reference_no], n, 'manual'); e.ai_suggestion.status = 'changed'; refreshAll(); } }); cell.replaceWith(pk); pk.input.focus(); } }),
        h('button', { type: 'button', class: 'ico', text: 'Keep Suspense', onclick: function () { E.rejectSuggestion(st, e.reference_no); refreshAll(); } })])]);
  }
  function acceptAllFlow() {
    var thr = st.aiThreshold.high, pv = E.previewAcceptAll(st, thr);
    confirmDialog('Accept all valid mappings', [h('p', null, [h('strong', { text: pv.apply + ' mappings' }), ' with confidence ≥ ' + Math.round(thr * 100) + '% will be applied.']),
      h('p', { text: pv.remainSuspenseOrReview + ' suggestion(s) stay pending (low confidence or Suspense).' }), pv.lockedSkipped ? h('p', { class: 'rv-note', text: pv.lockedSkipped + ' manually locked mapping(s) will NOT be overwritten.' }) : null], 'Proceed').then(function (ok) {
      if (!ok) return; var r = E.acceptAllValid(st, thr); aiNote(r.applied + ' AI mappings applied.', 'ok'); refreshAll();
    });
  }
  function oneByOne() {
    var queue = pendingSuggestions().map(function (e) { return e.reference_no; }), i = 0, total = queue.length;
    var ov = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' }); var card = h('div', { class: 'dialog' }); ov.appendChild(card); document.body.appendChild(ov);
    function done() { document.removeEventListener('keydown', key); ov.remove(); refreshAll(); }
    function cur() { return st.entries.find(function (e) { return e.reference_no === queue[i]; }); }
    function next() { i++; draw(); }
    function act(kind) {
      var e = cur(); if (!e) return;
      if (kind === 'a') { var r = E.acceptSuggestion(st, e.reference_no); if (!r.ok && r.reason === 'locked') { aiNote('Skipped a manually locked transaction.', ''); } }
      else if (kind === 'k') E.rejectSuggestion(st, e.reference_no);
      next();
    }
    function key(ev) { if (ev.target.tagName === 'INPUT') return; var k = ev.key.toLowerCase(); if (k === 'a' || k === 'k' || k === 's') act(k); else if (k === 'escape') done(); }
    function draw() {
      card.innerHTML = ''; var e = cur(); if (!e) { card.appendChild(h('h3', { text: 'All done' })); card.appendChild(h('div', { class: 'btns' }, [h('button', { class: 'btn-p', text: 'Close', onclick: done })])); return; }
      var s = e.ai_suggestion; card.appendChild(h('h3', { text: 'Transaction ' + (i + 1) + ' / ' + total }));
      card.appendChild(h('p', { text: e.narration })); card.appendChild(h('p', { text: (e.drCr === 'D' ? 'Debit: ' : 'Credit: ') + '₹' + inr(e.amount) + ' · ' + dmy(e.date) }));
      card.appendChild(h('p', null, ['Current suggestion: ', h('strong', { text: s.ledger }), ' — confidence ' + Math.round(s.confidence * 100) + '%']));
      card.appendChild(h('p', { class: 'rv-note', text: 'Reason: ' + s.reason })); if (e.mapping_locked) card.appendChild(h('p', { class: 'rv-note err', text: '🔒 Manually locked — Accept will not overwrite it.' }));
      var pk = ledgerPicker({ placeholder: 'Change ledger…', onPick: function (n) { E.assignLedger(st, [e.reference_no], n, 'manual'); e.ai_suggestion.status = 'changed'; next(); } });
      card.appendChild(pk);
      card.appendChild(h('div', { class: 'btns' }, [h('button', { class: 'btn-p', text: 'Accept (A)', onclick: function () { act('a'); } }), h('button', { class: 'btn-s', text: 'Keep Suspense (K)', onclick: function () { act('k'); } }), h('button', { class: 'btn-s', text: 'Skip (S)', onclick: function () { act('s'); } }), h('button', { class: 'btn-s', text: 'Close', onclick: done })]));
    }
    document.addEventListener('keydown', key); draw();
  }

  /* ---------- export (popup) and push to Tally (one click) ---------- */
  function expNote(msg, kind) { var n = document.getElementById('exp-note'); if (n) { n.textContent = msg; n.className = 'rv-note ' + (kind || ''); } }
  function finalCheck() {
    var fv = E.finalValidation(st, S.validation); var bank = (S.bankLedger || '').trim();
    if (!bank) fv.errors.unshift('Choose the bank account ledger (top of the page, "Bank account in Tally").');
    else if (st.ledgersSource === 'tally' && !E.ledgerExists(st, bank)) fv.errors.unshift('The bank ledger "' + bank + '" does not exist in the connected Tally. Choose it from the list at the top of the page.');
    fv.ok = fv.errors.length === 0; return fv;
  }
  function buildXml() {
    var txns = E.toTallyTransactions(st), bank = S.bankLedger.trim();
    var needSus = txns.some(function (t) { return t.counterLedger === st.suspense; }) && !(st.ledgersSource === 'tally' && ui.suspenseSeen);
    return { xml: TallyXML.buildImportXML({ transactions: txns, bankLedgerName: bank, ledgersToCreate: needSus ? [{ name: st.suspense, parent: 'Suspense A/c' }] : [] }), count: txns.length };
  }
  function openExport() {
    openModal({ name: 'export', icon: '⬇', title: 'Export', subtitle: 'Choose the format you need', size: 'md' }); renderExport();
  }
  function renderExport() {
    if (!modalIs('export')) return; var body = ui.modal.body; body.innerHTML = '';
    var fv = finalCheck(), c = E.counts(st), live = c.total - c.excluded;
    body.appendChild(h('div', { class: 'rv-stats' }, [['Entries to export', live], [st.suspense, c.suspense], ['Mapped to ledgers', c.mapped]].map(function (x) { return h('div', { class: 'stat' }, [h('b', { text: String(x[1]) }), h('small', { text: x[0] })]); })));
    fv.errors.slice(0, 4).forEach(function (m) { body.appendChild(h('p', { class: 'rv-note err', text: '⛔ ' + m })); });
    fv.warnings.forEach(function (m) { body.appendChild(h('p', { class: 'rv-note', style: 'color:#8a5d00', text: '⚠ ' + m })); });
    if (st.ledgersSource !== 'tally') body.appendChild(h('p', { class: 'rv-note', text: 'Ledger names were not checked against Tally. Every ledger used must already exist there (' + st.suspense + ' is created automatically).' }));
    body.appendChild(h('div', { class: 'fmt' }, [
      h('button', { type: 'button', id: 'exp-xml', disabled: !fv.ok, onclick: function () { var b = buildXml(); download(exportStem() + '.xml', 'application/xml', b.xml); expNote(b.count + ' entries saved as Tally XML. In Tally: Gateway of Tally › Import Data.', 'ok'); if (window.FX) FX.burst(18); } }, [h('span', { class: 'ic', text: '🧾' }), h('span', null, [h('b', { text: 'Tally XML' }), h('small', { text: 'Import into Tally from a file' })])]),
      h('button', { type: 'button', id: 'exp-xlsx', disabled: !fv.ok, onclick: exportExcel }, [h('span', { class: 'ic', text: '📊' }), h('span', null, [h('b', { text: 'Excel (.xlsx)' }), h('small', { text: 'Transactions, summary, ledger totals, audit log' })])])]));
    body.appendChild(h('p', { class: 'rv-note', id: 'exp-note' }));
  }
  function ensureBankLedger() {
    return new Promise(function (resolve) {
      if (bankLedgerOk()) return resolve(S.bankLedger.trim());
      var pk = ledgerPicker({ placeholder: 'Search your bank account ledger…', onPick: function () {} });
      dialog('Which bank account is this?', [h('p', { text: 'Choose the Tally ledger of the bank account these entries belong to.' }), pk], [{ label: 'Cancel', value: false }, { label: 'Continue', value: true, primary: true }]).then(function (ok) {
        if (!ok) return resolve(null); var v = pk.input.value.trim(), canon = st.ledgersSource === 'tally' ? E.canonicalLedger(st, v) : v;
        if (!canon) { alert('That ledger does not exist in Tally. Pick one from the list.'); return resolve(null); }
        S.bankLedger = canon; var i = document.getElementById('bank-ledger'); if (i) i.value = canon; markBank(); persist(); resolve(canon);
      });
      setTimeout(function () { pk.input.focus(); }, 60);
    });
  }
  function nestSvg() {
    var d = document.createElement('div'); d.className = 'nestwrap';
    d.innerHTML = '<svg class="nestsvg" viewBox="0 0 230 190" aria-hidden="true"><defs><radialGradient id="cg" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="#FFE9A6"/><stop offset=".55" stop-color="#D4A12A"/><stop offset="1" stop-color="#8F6410"/></radialGradient></defs>' +
      '<g class="coins"><g class="coin"><circle cx="85" cy="40" r="15" fill="url(#cg)" stroke="#fff3c4" stroke-width="2"/><text x="85" y="46" text-anchor="middle" font-size="16" font-weight="700" fill="#6b4600">\u20B9</text></g>' +
      '<g class="coin"><circle cx="118" cy="30" r="15" fill="url(#cg)" stroke="#fff3c4" stroke-width="2"/><text x="118" y="36" text-anchor="middle" font-size="16" font-weight="700" fill="#6b4600">\u20B9</text></g>' +
      '<g class="coin"><circle cx="150" cy="42" r="15" fill="url(#cg)" stroke="#fff3c4" stroke-width="2"/><text x="150" y="48" text-anchor="middle" font-size="16" font-weight="700" fill="#6b4600">\u20B9</text></g></g>' +
      '<g fill="none" stroke="#0B2A66" stroke-linecap="round"><path d="M28 118 Q115 205 202 118" stroke-width="9"/><path d="M36 128 Q115 190 194 126" stroke-width="6" stroke="#123A82"/><path d="M22 108 Q60 150 108 156" stroke-width="5" stroke="#1d4f9f"/><path d="M208 110 Q170 150 122 156" stroke-width="5" stroke="#1d4f9f"/><path d="M30 112 Q115 140 200 112" stroke-width="7"/></g>' +
      '<g><circle cx="102" cy="122" r="13" fill="url(#cg)" stroke="#fff3c4" stroke-width="2"/><circle cx="128" cy="124" r="13" fill="url(#cg)" stroke="#fff3c4" stroke-width="2"/></g></svg>';
    return d;
  }
  function pushFlow() {
    if (!(ui.conn && ui.conn.tally)) {
      dialog('Tally is not connected', [h('p', { text: 'Pushing needs the TaxNest connector running on this computer, with Tally open and a company loaded.' }), h('p', { class: 'rv-note', text: 'The light at the top turns green when everything is ready. You can also use Export to download a file and import it in Tally.' })],
        [{ label: 'OK', value: true, primary: true }]); return;
    }
    ensureBankLedger().then(function (bank) {
      if (!bank) return; var fv = finalCheck();
      if (!fv.ok) { dialog('Fix this before pushing', fv.errors.slice(0, 5).map(function (m) { return h('p', { class: 'rv-note err', text: '⛔ ' + m }); }), [{ label: 'OK', value: true, primary: true }]); return; }
      var warn = fv.warnings.filter(function (w) { return /FAILED|rebuilt|duplicate/i.test(w); });
      if (warn.length) {
        confirmDialog('Please check before pushing', warn.map(function (w) { return h('p', { text: '⚠ ' + w }); }).concat([h('p', { class: 'rv-note', text: 'Pushing posts entries into your live Tally books.' })]), 'Push anyway').then(function (ok) { if (ok) runPush(bank); });
      } else runPush(bank);
    });
  }
  function runPush(bank) {
    var txns = E.toTallyTransactions(st), n = txns.length, CH = 300, chunks = Math.ceil(n / CH);
    var needSus = txns.some(function (t) { return t.counterLedger === st.suspense; }) && !ui.suspenseSeen;
    var names = ['Preparing ' + n + ' entries']; if (needSus) names.push('Creating ledger "' + st.suspense + '" (under group "Suspense A/c")'); names.push('Sending entries to Tally' + (chunks > 1 ? ' (' + chunks + ' batches)' : '')); names.push('Tally confirmation');
    var m = openModal({ name: 'push', icon: '🚀', title: 'Pushing to Tally', subtitle: ui.company || '', size: 'sm', sticky: true });
    var box = h('div', { class: 'pushbox' }); var ul = h('ul', { class: 'pstages' }), bar = h('i'), msg = h('p', { class: 'rv-note', style: 'min-height:1.4em' });
    names.forEach(function (s) { ul.appendChild(h('li', null, [h('span', { class: 'dot' }), s])); });
    box.appendChild(nestSvg()); box.appendChild(h('div', { class: 'pbar' }, [bar])); box.appendChild(ul); box.appendChild(msg); m.body.appendChild(box);
    function stage(i, state) { var li = ul.children[i]; if (li) li.className = state; var done = Array.prototype.filter.call(ul.children, function (x) { return x.className === 'done'; }).length; bar.style.width = Math.round(done / names.length * 100) + '%'; }
    function fail(i, text, lines) {
      stage(i, 'bad'); box.classList.add('err'); msg.className = 'rv-note err'; msg.textContent = text; (lines || []).slice(0, 4).forEach(function (l) { box.appendChild(h('p', { class: 'rv-note err', text: l })); });
      box.appendChild(h('div', { class: 'rv-row', style: 'justify-content:center;margin-top:12px' }, [h('button', { type: 'button', class: 'btn-s', text: 'Close', onclick: function () { m.close(); } })]));
    }
    function post(xml) { return fetchJson('/import' + (ui.company ? '?company=' + encodeURIComponent(ui.company) : ''), { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: xml }, 180000); }
    var wait = function (ms) { return new Promise(function (r) { setTimeout(r, window.FX && FX.isOn() ? ms : 0); }); };
    var idx = 0, created = 0, altered = 0;
    stage(0, 'cur');
    wait(450).then(function () {
      stage(0, 'done'); idx = 1;
      if (!needSus) return null;
      stage(1, 'cur');
      return post(TallyXML.buildImportXML({ transactions: [], ledgersToCreate: [{ name: st.suspense, parent: 'Suspense A/c' }], reportName: 'All Masters' })).then(function (r) {
        if (!(r.status === 200 && r.body.ok)) throw { at: 1, text: 'Tally could not create the ledger "' + st.suspense + '".', lines: (r.body && r.body.line_errors) || [r.body && r.body.error].filter(Boolean) };
        ui.suspenseSeen = true; E.setLedgers(st, st.ledgers.concat([st.suspense]), 'tally'); stage(1, 'done'); idx = 2; return wait(300);
      });
    }).then(function () {
      var si = needSus ? 2 : 1; idx = si; stage(si, 'cur'); var p = Promise.resolve();
      for (var c = 0; c < chunks; c++) (function (c) {
        p = p.then(function () {
          msg.textContent = chunks > 1 ? 'Batch ' + (c + 1) + ' of ' + chunks + '…' : '';
          return post(TallyXML.buildImportXML({ transactions: txns.slice(c * CH, (c + 1) * CH), bankLedgerName: bank })).then(function (r) {
            var b = r.body || {}; if (!(r.status === 200 && b.ok)) throw { at: si, text: 'Tally reported a problem' + (chunks > 1 ? ' in batch ' + (c + 1) : '') + ' (' + created + ' entries were accepted before it).', lines: (b.line_errors && b.line_errors.length ? b.line_errors : [b.error || ('errors: ' + b.errors)]) };
            created += b.created || 0; altered += b.altered || 0; bar.style.width = Math.round(((si) + (c + 1) / chunks) / names.length * 100) + '%';
          });
        });
      })(c);
      return p.then(function () { stage(si, 'done'); stage(si + 1, 'cur'); return wait(450); });
    }).then(function () {
      stage(names.length - 1, 'done'); bar.style.width = '100%'; box.classList.add('done'); msg.className = 'rv-note ok';
      box.insertBefore(h('div', { class: 'bigcheck', text: '✅' }), box.firstChild.nextSibling);
      msg.textContent = 'Tally accepted ' + created + ' entr' + (created === 1 ? 'y' : 'ies') + (needSus ? ' and created "' + st.suspense + '"' : '') + '.';
      box.appendChild(h('div', { class: 'rv-row', style: 'justify-content:center;margin-top:12px' }, [h('button', { type: 'button', class: 'btn-p btn-gold', text: 'Done', onclick: function () { m.close(); } })]));
      if (window.FX) FX.burst(70); ui.syncedFor = null; syncLedgers(); persist();
    }).catch(function (e) {
      if (e && e.at !== undefined) fail(e.at, e.text, e.lines); else fail(idx, 'Could not reach the connector: ' + (e && e.message ? e.message : e));
    });
  }
  function exportExcel() {
    if (typeof XLSX === 'undefined') { expNote('The Excel library (SheetJS) did not load — check your internet connection and reload.', 'err'); return; }
    var v = S.validation, wb = XLSX.utils.book_new();
    var tx = [['Reference No', 'Date', 'Value Date', 'Narration', 'Bank Reference', 'Cheque No', 'Debit', 'Credit', 'Balance', 'Tally Ledger', 'Mapping Source', 'Mapping Confidence', 'Mapping Note']];
    st.entries.filter(function (e) { return !e.excluded; }).forEach(function (e) {
      tx.push([e.reference_no, dmy(e.date), e.value_date ? dmy(e.value_date) : '', e.narration, e.refNo || '', e.cheque_no || '', e.drCr === 'D' ? e.amount : 0, e.drCr === 'C' ? e.amount : 0, typeof e.balance === 'number' ? e.balance : '', e.ledger_name, e.ledger_source, e.mapping_confidence == null ? '' : e.mapping_confidence, e.mapping_note || '']);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tx), 'Transactions');
    var sm = [['Bank', S.bank.name], ['Account', (S.statement && S.statement.account_number_masked) || ''], ['Statement Period', S.statement && S.statement.period_start ? longDate(S.statement.period_start) + ' – ' + longDate(S.statement.period_end) : periodFromEntries()],
      ['Opening Balance', v.opening_balance], ['Opening source', v.opening_source], ['Total Debit', v.total_debit], ['Total Credit', v.total_credit], ['Calculated Closing', v.calculated_closing_balance], ['Statement Closing', v.statement_closing_balance], ['Closing source', v.closing_source], ['Difference', v.difference], ['Validation Status', v.status.toUpperCase()], ['Parser', S.parserMode === 'bank_specific' ? 'Bank-specific' : 'Universal']];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sm), 'Statement Summary');
    var mp = [['Ledger', 'Number of Transactions', 'Total Debit', 'Total Credit', 'Mapping Source']]; E.mappingSummary(st).forEach(function (g) { mp.push([g.ledger, g.count, g.debit, g.credit, g.sources]); });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mp), 'Mapping Summary');
    var au = [['Reference', 'From', 'To', 'Source', 'Confidence', 'Time']]; st.audit.forEach(function (a) { au.push([a.ref, a.from, a.to, a.source, a.confidence == null ? '' : a.confidence, a.at]); });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(au), 'Audit Log');
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    download(exportStem() + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', new Blob([out], { type: 'application/octet-stream' }));
    expNote('Excel file downloaded.', 'ok');
  }

  /* ---------- debug ---------- */
  function debugPanel() {
    var d = h('details', { class: 'dbg' }); d.appendChild(h('summary', { text: 'Advanced / parser debug' }));
    var info = { parser_mode: S.parserMode, parser_key: S.parserKey || null, layout: S.extraction && S.extraction.layout, pages: S.extraction && S.extraction.pages, text_chars: S.extraction && S.extraction.chars,
      rows: st.entries.length, skipped_lines: S.extraction && S.extraction.skippedCount, low_confidence_rows: st.entries.filter(function (e) { return e.parse_confidence === 'low'; }).length,
      possible_duplicates: E.counts(st).duplicates, validation: { status: S.validation.status, opening: S.validation.opening_balance, debit: S.validation.total_debit, credit: S.validation.total_credit, calc_closing: S.validation.calculated_closing_balance, stmt_closing: S.validation.statement_closing_balance, difference: S.validation.difference }, warnings: S.validation.notes, repair: S.repair || null };
    d.appendChild(h('pre', { text: JSON.stringify(info, null, 2) }));
    if (S.extraction && S.extraction.skippedSample && S.extraction.skippedSample.length) d.appendChild(h('pre', { text: 'Skipped lines (first ' + S.extraction.skippedSample.length + '):\n' + S.extraction.skippedSample.join('\n') }));
    if (S.rawText) d.appendChild(h('button', { type: 'button', class: 'btn-s', text: 'Download raw extracted text', onclick: function () { download('raw-extracted-text.txt', 'text/plain', S.rawText); } }));
    return d;
  }

  window.BankReconReview = { stop: stopPolling, open: open, showError: showError, showProgress: showProgress, resumeInfo: resumeInfo, clearSaved: clearSaved, persist: function () { persist(); },
    _debug: function () { return { S: S, st: st, ui: ui }; } };
})();
