/* smart-mapping.js -- "Quick groups" for clearing Suspense in bulk + suggestion sources (learned / party / rules).
   Pure logic on MappingEngine state (no DOM). Plain <script> (window.SmartMapping) or Node.
   NOTHING here applies a ledger by itself: it only proposes. The user confirms each group.
   Suggestions only ever name ledgers that exist in the available list; a rule that matches several ledgers is skipped
   as ambiguous rather than guessed. */
(function (root) {
  'use strict';
  var Engine = (typeof module !== 'undefined' && module.exports) ? require('./mapping-engine.js') : root.MappingEngine;

  var NOISE = {}; ('IMPS NEFT NEFTINW RTGS UPI SENTIMPS SENT RECD RECEIVED MB REV KKBK IBKL IBKLX BKID BKIDX SBIN SBINX HDFC HDFCX HDFCH UBIN ICIC ICICX UTIB YESB PUNB KARB BARB BARBX CSBK CSBKX CSBKH INDB INDBX KKBKTRANS TRANS TRANSFER FROM TO PAYMENT PAID PAYT PHONE THE AND FOR NA CHQ DEBIT CREDIT INWARD OUTWARD ONLINE AXNGG KPG OSRATNBKCC')
    .split(' ').forEach(function (w) { NOISE[w] = 1; });
  function isChannelWord(w) { return NOISE[w] || /^(IMPS|NEFT|RTGS|SENTIMPS)/.test(w); }
  function tokens(narr) {
    return String(narr).toUpperCase().split(/[^A-Z]+/).filter(function (w) { return w.length >= 3 && !isChannelWord(w); });
  }
  /* Same payee / same kind of entry -> same key. Digits (reference numbers) and channel words are ignored. */
  function groupKey(e) { var t = tokens(e.narration).slice(0, 5); return (e.drCr === 'D' ? 'D:' : 'C:') + (t.length ? t.join(' ') : '(NO TEXT)'); }

  /* ---------- rules ---------- */
  var RULES = [
    { id: 'bank_charges', label: 'Bank charges', dir: 'D', re: /\b(CHRG|CHARGES?|CHGS?|SMS\s*ALERT|ECS\s*RETURN|ANNUAL\s*FEE|MIN(IMUM)?\s*BAL|PENAL|CHQ\s*BOOK|PROCESSING\s*FEE|DEBIT\s*CARD\s*FEE|AMC\s*CHARGE|GST\s*ON)\b/i, hints: [/bank\s*charge/i, /bank\s*(fee|expense)/i] },
    { id: 'interest_received', label: 'Interest received', dir: 'C', re: /\bINT\.?\s*(PD|PAID|CREDIT)\b|\bINTEREST\s*(PAID|CREDIT|CR)\b|CREDIT\s*INTEREST|\bSB\s*INT/i, hints: [/interest\s*(income|received|earned)/i, /bank\s*interest/i] },
    { id: 'interest_paid', label: 'Interest paid', dir: 'D', re: /\bINT(EREST)?\s*(DEBIT|CHARGED|ON\s*(LOAN|OD|CC))\b/i, hints: [/interest\s*(paid|expense|on\s*loan)/i, /^interest$/i] },
    { id: 'loan_emi', label: 'Loan EMI', dir: 'D', re: /\bEMI\b|\bLOAN\b|\bINSTALMENT\b|NACH.*(FIN|FINANCE|LOAN|CAPITAL|HOUSING)|ECS.*(EMI|LOAN)/i, hints: [/loan/i, /\bemi\b/i] },
    { id: 'electricity', label: 'Electricity', dir: 'D', re: /ELECTRIC|MSEB|MSEDCL|TORRENT\s*POWER|UGVCL|DGVCL|MGVCL|PGVCL|BESCOM|TATA\s*POWER|ADANI\s*ELEC|\bBSES\b|\bCESC\b/i, hints: [/electric/i, /\bpower\b/i] },
    { id: 'rent', label: 'Rent', dir: 'D', re: /\bRENT(AL)?\b|\bLEASE\b/i, hints: [/\brent/i] },
    { id: 'freight', label: 'Freight / transport', dir: 'D', re: /FREIGHT|TRANSPORT|LOGISTIC|CARGO|CARRIER|COURIER|\bDTDC\b|BLUE\s*DART|DELHIVERY|\bTRUCK\b|\bTEMPO\b/i, hints: [/freight/i, /transport/i, /carriage/i, /courier/i] },
    { id: 'salary', label: 'Salary / wages', dir: 'D', re: /SALARY|\bSAL\b|\bSALRY\b|\bWAGES?\b/i, hints: [/salar/i, /wages/i] },
    { id: 'cash_withdrawal', label: 'Cash', dir: 'D', re: /CASH\s*WITHDRAW|ATM\s*(WDL|WITHDRAW|CASH)|\bATW\b|\bATL\b/i, hints: [/^cash(\s*in\s*hand|\s*a\/c|\s*account)?$/i] },
    { id: 'cash_deposit', label: 'Cash', dir: 'C', re: /CASH\s*DEP(OSIT)?\b|\bCDM\b/i, hints: [/^cash(\s*in\s*hand|\s*a\/c|\s*account)?$/i] },
    { id: 'telephone', label: 'Telephone / internet', dir: 'D', re: /AIRTEL|\bJIO\b|VODAFONE|\bBSNL\b|BROADBAND|RECHARGE|TELEPHONE/i, hints: [/telephone|mobile|internet|communication|phone/i] },
    { id: 'fuel', label: 'Fuel', dir: 'D', re: /PETROL|DIESEL|\bFUEL\b|\bHPCL\b|\bBPCL\b|\bIOCL\b|INDIAN\s*OIL/i, hints: [/fuel|petrol|diesel/i] },
    { id: 'insurance', label: 'Insurance', dir: 'D', re: /INSURANCE|\bLIC\b|\bPREMIUM\b|HDFC\s*LIFE|ICICI\s*PRU/i, hints: [/insurance/i] },
    { id: 'tax', label: 'GST / TDS / tax', dir: 'D', re: /\bGST\b|\bGSTN\b|\bCBIC\b|\bTDS\b|\bCBDT\b|INCOME\s*TAX|ADVANCE\s*TAX|\bCHALLAN\b/i, hints: [/gst|tds|income\s*tax|advance\s*tax/i] }
  ];
  function matchRule(state, narration, dir) {
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i]; if (r.dir && r.dir !== dir) continue; if (!r.re.test(narration)) continue;
      var found = [];
      state.ledgers.forEach(function (n) { if (n === state.suspense) return; if (r.hints.some(function (h) { return h.test(n); })) found.push(n); });
      if (found.length === 1) return { ledger: found[0], source: 'rule', reason: r.label + ' pattern in narration' };
      if (found.length > 1) return { ambiguous: found.slice(0, 5), source: 'rule', reason: r.label + ': several matching ledgers' };
    }
    return null;
  }

  /* ---------- party-name match against real ledger names ---------- */
  var LEDGER_NOISE = /^(PVT|LTD|LIMITED|PRIVATE|CO|COMPANY|THE|AND|OF|MS|SHRI|SMT|SRI|ACCOUNT|AC|INDIA)$/;
  function ledgerTokens(name) { return String(name).toUpperCase().split(/[^A-Z]+/).filter(function (w) { return w.length >= 2 && !LEDGER_NOISE.test(w); }); }
  function tokMatch(n, l) { return n === l || (n.length >= 4 && l.indexOf(n) === 0) || (l.length >= 4 && n.indexOf(l) === 0); }
  function partyMatch(state, narration) {
    var nt = tokens(narration).filter(function (w, i, a) { return a.indexOf(w) === i; }); if (!nt.length) return null;
    var scored = [];
    state.ledgers.forEach(function (name) {
      if (name === state.suspense) return;
      var lt = ledgerTokens(name); if (!lt.length) return;
      var matched = nt.filter(function (n) { return lt.some(function (l) { return tokMatch(n, l); }); }).length;
      var coverL = lt.filter(function (l) { return nt.some(function (n) { return tokMatch(n, l); }); }).length;
      var ok = (matched >= 2 && matched / nt.length >= 0.5 && coverL / lt.length >= 0.5) || (matched === 1 && nt.length === 1 && lt.length === 1 && nt[0].length >= 6);
      if (ok) scored.push({ name: name, score: matched / nt.length + coverL / lt.length });
    });
    if (!scored.length) return null;
    scored.sort(function (a, b) { return b.score - a.score; });
    if (scored.length > 1 && scored[0].score - scored[1].score < 0.15) return { ambiguous: scored.slice(0, 4).map(function (s) { return s.name; }), source: 'party', reason: 'party name matches several ledgers' };
    return { ledger: scored[0].name, source: 'party', reason: 'narration matches ledger name' };
  }

  /* ---------- groups ---------- */
  function suggestFor(state, key, sample, dir, learned) {
    if (learned && learned[key] && Engine.canonicalLedger(state, learned[key])) return { ledger: Engine.canonicalLedger(state, learned[key]), source: 'learned', reason: 'you mapped this before' };
    var p = partyMatch(state, sample); if (p && p.ledger) return p;
    var r = matchRule(state, sample, dir); if (r && r.ledger) return r;
    return p && p.ambiguous ? p : (r && r.ambiguous ? r : null);
  }
  function groupEntries(state, opts) {
    opts = opts || {}; var learned = opts.learned || {}, map = {}, order = [];
    state.entries.forEach(function (e) {
      if (e.excluded || e.mapping_locked) return;
      if (opts.onlySuspense !== false && e.ledger_name !== state.suspense) return;
      var k = groupKey(e), g = map[k];
      if (!g) { g = map[k] = { key: k, dir: e.drCr, label: tokens(e.narration).slice(0, 5).join(' ') || '(no text)', refs: [], count: 0, debit: 0, credit: 0, samples: [], first: e.date, last: e.date }; order.push(g); }
      g.refs.push(e.reference_no); g.count++; if (e.drCr === 'D') g.debit += e.amount; else g.credit += e.amount;
      if (g.samples.length < 3 && g.samples.indexOf(e.narration) < 0) g.samples.push(e.narration);
      if (e.date < g.first) g.first = e.date; if (e.date > g.last) g.last = e.date;
    });
    var groups = order.map(function (g) {
      g.debit = Math.round(g.debit * 100) / 100; g.credit = Math.round(g.credit * 100) / 100; g.amount = Math.round((g.debit + g.credit) * 100) / 100;
      g.suggestion = suggestFor(state, g.key, g.samples[0], g.dir, learned); return g;
    });
    groups.sort(function (a, b) { return b.count - a.count || b.amount - a.amount; });
    return groups;
  }
  function learn(learned, key, ledger) { learned[key] = ledger; return learned; }

  var SmartMapping = { groupKey: groupKey, tokens: tokens, groupEntries: groupEntries, matchRule: matchRule, partyMatch: partyMatch, learn: learn, RULES: RULES };
  if (typeof module !== 'undefined' && module.exports) module.exports = SmartMapping; else root.SmartMapping = SmartMapping;
})(typeof window !== 'undefined' ? window : this);
