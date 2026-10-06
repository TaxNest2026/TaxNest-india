/* Stand-in for Tally's XML server, for testing the helper without Tally. NOT a substitute
   for testing against real Tally -- it only mimics the reply shapes assumed in tally-requests.js. */
'use strict';
const http = require('http');
function makeMock(port) {
  const imported = [];
  const base = ['Cash|Cash-in-Hand', 'Kotak Mahindra Bank|Bank Accounts', 'Bank Charges|Indirect Expenses', 'R &amp; D Exp|Indirect Expenses'];
  const ledgers = process.env.MOCK_NO_SUSPENSE ? base.slice() : base.concat(['Suspense A/c|Suspense A/c']);
  const s = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/__imports') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(imported)); }
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      if (/<ID>TaxNestCompanies<\/ID>/.test(b))
        return res.end('<ENVELOPE><BODY><DATA><COLLECTION><COMPANY NAME="ABC Traders &amp; Co"><NAME>ABC Traders &amp; Co</NAME></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>');
      if (/<ID>TaxNestLedgers<\/ID>/.test(b))
        return res.end('<ENVELOPE><BODY><DATA><COLLECTION>' + ledgers.map(x => { const [n, p] = x.split('|'); return '<LEDGER NAME="' + n + '"><NAME>' + n + '</NAME><PARENT>' + p + '</PARENT></LEDGER>'; }).join('') + '</COLLECTION></DATA></BODY></ENVELOPE>');
      if (/Import Data/.test(b)) {
        imported.push({ reportName: (b.match(/<REPORTNAME>([^<]*)</) || [])[1], ledgers: (b.match(/<LEDGER NAME="[^"]*"/g) || []), parents: (b.match(/<PARENT>[^<]*<\/PARENT>/g) || []), vouchers: (b.match(/<VOUCHER /g) || []).length, xml: b.length < 4000 ? b : undefined });
        const vch = (b.match(/<VOUCHER /g) || []).length, led = (b.match(/<LEDGER /g) || []).length;
        (b.match(/<LEDGER NAME="[^"]*" ACTION="Create">[\s\S]*?<PARENT>[^<]*<\/PARENT>/g) || []).forEach(m => { const n = m.match(/NAME="([^"]*)"/)[1], p = m.match(/<PARENT>([^<]*)<\/PARENT>/)[1]; ledgers.push(n + '|' + p); });
        if (/FORCE_BAD_LEDGER/.test(process.env.MOCK_FAIL || '') && led) return res.end('<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Group does not exist</LINEERROR></RESPONSE>');
        if (/FORCE_ERROR/.test(b)) return res.end('<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Ledger &apos;X&apos; does not exist</LINEERROR></RESPONSE>');
        return res.end('<RESPONSE><CREATED>' + (vch + led) + '</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS></RESPONSE>');
      }
      res.end('<RESPONSE>unknown</RESPONSE>');
    });
  });
  return new Promise(r => s.listen(port, '127.0.0.1', () => r({ close: () => s.close(), imported })));
}
module.exports = { makeMock };
