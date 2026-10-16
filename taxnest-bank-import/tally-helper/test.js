'use strict';
process.env.TALLY_PORT = '19000';
const assert = require('assert'), http = require('http');
const { makeMock } = require('./mock-tally'); const { server } = require('./server');
const TallyXML = require('../tally-xml-builder.js');
const call = (method, path, body, origin) => new Promise((ok, bad) => {
  const r = http.request({ host: '127.0.0.1', port: 19911, path, method, headers: origin ? { Origin: origin } : {} }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => ok({ code: res.statusCode, json: d ? JSON.parse(d) : null }));
  }); r.on('error', bad); r.end(body);
});
(async () => {
  await new Promise(r => server.listen(19911, '127.0.0.1', r));
  let n = 0; const ok = (m) => { n++; console.log('ok -', m); };

  // --- Tally down ---
  let s = await call('GET', '/status'); assert.equal(s.json.tally.reachable, false); ok('status reports Tally unreachable (not an error page)');
  s = await call('GET', '/ledgers'); assert.equal(s.code, 502); ok('ledgers -> 502 with clear message when Tally is down');

  const mock = await makeMock(19000);
  s = await call('GET', '/status'); assert.equal(s.json.tally.reachable, true); assert.deepEqual(s.json.tally.companies, ['ABC Traders & Co']); ok('status lists companies, unescaped');
  s = await call('GET', '/ledgers'); assert.equal(s.json.count, 5); assert.ok(s.json.ledgers.some(l => l.name === 'R & D Exp')); ok('ledgers parsed, entities unescaped');

  const xml = TallyXML.buildSuspenseImportXML([
    { date: '20260401', narration: 'UPI ABC', amount: 5000, drCr: 'D', refNo: 'UPI1' },
    { date: '20260402', narration: 'NEFT IN', amount: 25000, drCr: 'C', refNo: '' }], 'Kotak Mahindra Bank', 'Suspense A/c');
  s = await call('POST', '/import?company=' + encodeURIComponent('ABC Traders & Co'), xml);
  assert.equal(s.code, 200); assert.equal(s.json.ok, true); assert.equal(s.json.created, 3); ok('import: 1 ledger + 2 vouchers reported created');
  assert.ok(mock.imported[0].xml.includes('<SVCURRENTCOMPANY>ABC Traders &amp; Co</SVCURRENTCOMPANY>')); ok('target company injected into import envelope');

  s = await call('POST', '/import', xml.replace('UPI ABC', 'FORCE_ERROR')); assert.equal(s.code, 422); assert.equal(s.json.ok, false);
  assert.match(s.json.line_errors[0], /does not exist/); ok('Tally errors surfaced, never reported as success');
  s = await call('POST', '/import', '<hello/>'); assert.equal(s.code, 400); ok('non-import body rejected');
  s = await call('GET', '/status', null, 'https://evil.example'); assert.equal(s.code, 403); ok('foreign web origin blocked');
  s = await call('GET', '/status', null, 'http://localhost:5500'); assert.equal(s.code, 200); ok('localhost origin allowed');

  console.log(n + ' tests passed'); mock.close(); server.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
