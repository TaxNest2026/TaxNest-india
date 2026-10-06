/* XML request builders + response parsers for Tally's XML-over-HTTP server.

   VERIFICATION STATUS -- read before trusting:
   - Import envelope / response counters (CREATED, ALTERED, ERRORS...) follow
     the standard Tally import contract and the envelope in your working tally.xml.
   - The LEDGER / COMPANY *collection export* requests below use Tally's
     documented TDL collection mechanism but have NOT been run against a real
     Tally Prime / ERP 9 by me (no Tally in my environment). Run
     `GET /status` and `GET /ledgers` once on your machine; if either returns
     empty/odd results, call `POST /raw` with the same XML and send me the raw
     reply -- the parsers here are written defensively and are easy to adjust. */
'use strict';

function unesc(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function collectionRequest(collName, type, fetch, company) {
  return '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>' +
    '<ID>' + collName + '</ID></HEADER><BODY><DESC><STATICVARIABLES>' +
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
    (company ? '<SVCURRENTCOMPANY>' + esc(company) + '</SVCURRENTCOMPANY>' : '') +
    '</STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="' + collName + '" ISMODIFY="No"><TYPE>' + type +
    '</TYPE><FETCH>' + fetch + '</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
}
const ledgersRequest = (company) => collectionRequest('TaxNestLedgers', 'Ledger', 'Name,Parent', company);
const companiesRequest = () => collectionRequest('TaxNestCompanies', 'Company', 'Name', null);

function parseLedgers(xml) {
  const out = [], seen = new Set();
  const re = /<LEDGER\b([^>]*)>([\s\S]*?)<\/LEDGER>/g; let m;
  while ((m = re.exec(xml))) {
    const attr = m[1].match(/\bNAME="([^"]*)"/);
    const inner = m[2].match(/<NAME>([^<]*)<\/NAME>/);
    const name = unesc((attr && attr[1]) || (inner && inner[1]) || '').trim();
    const parent = m[2].match(/<PARENT>([^<]*)<\/PARENT>/);
    if (name && !seen.has(name)) { seen.add(name); out.push({ name, parent: parent ? unesc(parent[1]).trim() : '' }); }
  }
  return out;
}
function parseCompanies(xml) {
  const out = [], seen = new Set();
  const re = /<COMPANY\b([^>]*)>([\s\S]*?)<\/COMPANY>/g; let m;
  while ((m = re.exec(xml))) {
    const attr = m[1].match(/\bNAME="([^"]*)"/);
    const inner = m[2].match(/<NAME>([^<]*)<\/NAME>/);
    const name = unesc((attr && attr[1]) || (inner && inner[1]) || '').trim();
    if (name && !seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

/* Tally's import reply: <RESPONSE><CREATED>n</CREATED><ALTERED>n</ALTERED><ERRORS>n</ERRORS>... plus
   optional <LINEERROR> text. Anything unparseable is reported as an error, never as success. */
function parseImportResponse(xml) {
  const num = (tag) => { const m = xml.match(new RegExp('<' + tag + '>\\s*(\\d+)\\s*</' + tag + '>')); return m ? +m[1] : 0; };
  const lineErrors = []; const re = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/g; let m;
  while ((m = re.exec(xml))) lineErrors.push(unesc(m[1]).trim());
  const exception = (xml.match(/<EXCEPTIONS>\s*(\d+)\s*<\/EXCEPTIONS>/) || [])[1];
  const recognised = /<RESPONSE>/.test(xml);
  const r = { created: num('CREATED'), altered: num('ALTERED'), ignored: num('IGNORED'), cancelled: num('CANCELLED'),
    errors: num('ERRORS'), exceptions: exception ? +exception : 0, line_errors: lineErrors, recognised };
  r.ok = recognised && r.errors === 0 && r.exceptions === 0 && lineErrors.length === 0;
  return r;
}

function withCompany(importXml, company) {
  if (!company) return importXml;
  return importXml.replace('<SVCURRENTCOMPANY/>', '<SVCURRENTCOMPANY>' + esc(company) + '</SVCURRENTCOMPANY>');
}

module.exports = { ledgersRequest, companiesRequest, parseLedgers, parseCompanies, parseImportResponse, withCompany, esc, unesc };
