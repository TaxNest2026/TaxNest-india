/* =========================================================
   tally-xml-builder.js
   Core, framework-free module for turning bank transactions into
   Tally-compatible import XML. Plain <script> include in the browser
   (attaches to window.TallyXML) — also runs under Node for testing
   (module.exports = TallyXML). No dependencies.

   SCHEMA CONFIDENCE:
   - VOUCHER structure below is verified byte-for-byte against a real,
     Tally-accepted export (tally.xml — 542 vouchers, a Kotak Mahindra
     statement mapped entirely to Suspense). Tag names, nesting, and the
     debit/credit sign convention all come directly from that file.
   - LEDGER master structure (buildLedgerMasterXML) is standard Tally
     schema but has NOT been checked against a real sample the same way.
     If Tally rejects it on import, export one ledger from your Tally as
     XML and send it over — it'll get the same treatment as the voucher
     schema did.
   ========================================================= */
(function (root) {
  'use strict';

  /* ---------- escaping ---------- */
  function esc(val) {
    if (val === null || val === undefined) return '';
    return String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(val) {
    return esc(val).replace(/"/g, '&quot;');
  }

  function formatAmount(n) {
    var num = typeof n === 'number' ? n : parseFloat(n);
    if (isNaN(num)) return '0';
    return String(Math.round((num + Number.EPSILON) * 100) / 100);
  }

  /* ---------- deterministic GUID ----------
     Same bank ledger + date + side + amount + narration always hashes to
     the same GUID. Re-run the tool on an updated or overlapping statement
     and Tally sees the *same* voucher objects instead of new duplicates. */
  function hashString(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function generateGUID(txn, bankLedgerName) {
    var key = [bankLedgerName, txn.date, txn.drCr, formatAmount(txn.amount), txn.narration, txn.refNo || ''].join('|');
    return 'taxnest-recon-' + hashString(key);
  }

  /* ---------- VOUCHER builder ----------
     Verified pattern:
       Receipt (money IN):  bank leg  ISDEEMEDPOSITIVE=Yes, AMOUNT=-amount
                             counter leg ISDEEMEDPOSITIVE=No,  AMOUNT=+amount
       Payment (money OUT): bank leg  ISDEEMEDPOSITIVE=No,  AMOUNT=+amount
                             counter leg ISDEEMEDPOSITIVE=Yes, AMOUNT=-amount
     txn = { date:'YYYYMMDD', narration, amount, drCr:'D'|'C', counterLedger, refNo? }
     BILLALLOCATIONS.LIST / CATEGORYALLOCATIONS.LIST / COSTCENTREALLOCATIONS.LIST
     are left empty exactly as in the verified sample (bank recon doesn't use
     bill-wise or cost-centre tracking). INSTRUMENTNUMBER is populated from
     refNo when we have it — a real field the sample leaves blank, so filling
     it in is additive, not a deviation. ALTERID is omitted: in the sample it
     was a constant placeholder identical on all 542 vouchers, and Tally
     assigns its own on ACTION="Create" regardless. */
  function buildVoucherXML(txn, bankLedgerName) {
    var isReceipt = txn.drCr === 'C';
    var vtype = isReceipt ? 'Receipt' : 'Payment';
    var guid = generateGUID(txn, bankLedgerName);
    var amt = formatAmount(txn.amount);

    var bankLeg = isReceipt ? { pos: 'Yes', amt: '-' + amt } : { pos: 'No', amt: amt };
    var counterLeg = isReceipt ? { pos: 'No', amt: amt } : { pos: 'Yes', amt: '-' + amt };
    var instrumentNumber = txn.refNo ? esc(txn.refNo) : '';

    return (
      '<TALLYMESSAGE xmlns:UDF="TallyUDF">' +
      '<VOUCHER REMOTEID="' + escAttr(guid) + '" VCHTYPE="' + vtype + '" ACTION="Create">' +
      '<DATE>' + esc(txn.date) + '</DATE>' +
      '<EFFECTIVEDATE>' + esc(txn.date) + '</EFFECTIVEDATE>' +
      '<VOUCHERTYPENAME>' + vtype + '</VOUCHERTYPENAME>' +
      '<VOUCHERNUMBER>0</VOUCHERNUMBER>' +
      '<NARRATION>' + esc(txn.narration) + '</NARRATION>' +
      '<GUID>' + esc(guid) + '</GUID>' +
      '<ALLLEDGERENTRIES.LIST>' +
        '<REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>' +
        '<ISDEEMEDPOSITIVE>' + counterLeg.pos + '</ISDEEMEDPOSITIVE>' +
        '<LEDGERNAME>' + esc(txn.counterLedger) + '</LEDGERNAME>' +
        '<AMOUNT>' + counterLeg.amt + '</AMOUNT>' +
        '<BILLALLOCATIONS.LIST><NAME></NAME><BILLTYPE></BILLTYPE><AMOUNT></AMOUNT></BILLALLOCATIONS.LIST>' +
        '<CATEGORYALLOCATIONS.LIST><CATEGORY></CATEGORY><ISDEEMEDPOSITIVE></ISDEEMEDPOSITIVE>' +
          '<COSTCENTREALLOCATIONS.LIST><NAME></NAME><AMOUNT></AMOUNT></COSTCENTREALLOCATIONS.LIST>' +
        '</CATEGORYALLOCATIONS.LIST>' +
      '</ALLLEDGERENTRIES.LIST>' +
      '<ALLLEDGERENTRIES.LIST>' +
        '<REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>' +
        '<ISDEEMEDPOSITIVE>' + bankLeg.pos + '</ISDEEMEDPOSITIVE>' +
        '<LEDGERNAME>' + esc(bankLedgerName) + '</LEDGERNAME>' +
        '<AMOUNT>' + bankLeg.amt + '</AMOUNT>' +
        '<BANKALLOCATIONS.LIST><TRANSACTIONTYPE></TRANSACTIONTYPE>' +
          '<INSTRUMENTNUMBER>' + instrumentNumber + '</INSTRUMENTNUMBER>' +
          '<AMOUNT></AMOUNT><INSTRUMENTDATE></INSTRUMENTDATE></BANKALLOCATIONS.LIST>' +
      '</ALLLEDGERENTRIES.LIST>' +
      '</VOUCHER>' +
      '</TALLYMESSAGE>'
    );
  }

  /* ---------- LEDGER master builder (unverified schema — see header note) ---------- */
  function buildLedgerMasterXML(ledgerName, parentGroup) {
    var group = parentGroup || 'Suspense Account';
    return (
      '<TALLYMESSAGE xmlns:UDF="TallyUDF">' +
      '<LEDGER NAME="' + escAttr(ledgerName) + '" ACTION="Create">' +
      '<NAME>' + esc(ledgerName) + '</NAME>' +
      '<PARENT>' + esc(group) + '</PARENT>' +
      '<ISBILLWISEON>No</ISBILLWISEON>' +
      '<AFFECTSSTOCK>No</AFFECTSSTOCK>' +
      '<OPENINGBALANCE>0</OPENINGBALANCE>' +
      '</LEDGER>' +
      '</TALLYMESSAGE>'
    );
  }

  var ENVELOPE_PREFIX =
    '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>' +
    '<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>' +
    '<STATICVARIABLES><SVCURRENTCOMPANY/></STATICVARIABLES></REQUESTDESC>' +
    '<REQUESTDATA>';
  var ENVELOPE_SUFFIX = '</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';

  /* ledgersToCreate: [{name, parent}]  — masters go first so vouchers below them resolve */
  function buildImportXML(opts) {
    opts = opts || {};
    var transactions = opts.transactions || [];
    var bankLedgerName = opts.bankLedgerName;
    var ledgersToCreate = opts.ledgersToCreate || [];
    if (!bankLedgerName) throw new Error('bankLedgerName is required');

    var body = '';
    for (var i = 0; i < ledgersToCreate.length; i++) {
      body += buildLedgerMasterXML(ledgersToCreate[i].name, ledgersToCreate[i].parent);
    }
    for (var j = 0; j < transactions.length; j++) {
      body += buildVoucherXML(transactions[j], bankLedgerName);
    }
    return ENVELOPE_PREFIX + body + ENVELOPE_SUFFIX;
  }

  /* Phase-2 convenience: map every transaction to Suspense, create it if needed */
  function buildSuspenseImportXML(transactions, bankLedgerName, suspenseLedgerName) {
    var sName = suspenseLedgerName || 'Suspense A/c';
    var txns = transactions.map(function (t) {
      var copy = {};
      for (var k in t) copy[k] = t[k];
      copy.counterLedger = sName;
      return copy;
    });
    return buildImportXML({
      transactions: txns,
      bankLedgerName: bankLedgerName,
      ledgersToCreate: [{ name: sName, parent: 'Suspense Account' }]
    });
  }

  var TallyXML = {
    buildVoucherXML: buildVoucherXML,
    buildLedgerMasterXML: buildLedgerMasterXML,
    buildImportXML: buildImportXML,
    buildSuspenseImportXML: buildSuspenseImportXML,
    generateGUID: generateGUID,
    esc: esc,
    escAttr: escAttr
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TallyXML;
  } else {
    root.TallyXML = TallyXML;
  }
})(typeof window !== 'undefined' ? window : this);
