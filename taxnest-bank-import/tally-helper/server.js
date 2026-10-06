/* TaxNest Tally helper -- tiny local relay. Zero dependencies (Node >= 18).
     Web page  <->  http://127.0.0.1:<PORT>  <->  Tally at http://<TALLY_HOST>:<TALLY_PORT>
   Start:  node server.js        Env: PORT (default 9911), TALLY_HOST (127.0.0.1), TALLY_PORT (9000),
                                      ALLOWED_ORIGINS (comma list; default allows localhost + file:// pages)
   Privacy: listens on 127.0.0.1 only; nothing is written to disk or logged beyond counts. */
'use strict';
const http = require('http');
const T = require('./tally-requests');

const PORT = +(process.env.PORT || 9911);
const TALLY_HOST = process.env.TALLY_HOST || '127.0.0.1';
const TALLY_PORT = +(process.env.TALLY_PORT || 9000);
const MAX_BODY = 50 * 1024 * 1024;
const fs = require('fs'), path = require('path');
let fileOrigins = []; try { fileOrigins = fs.readFileSync(path.join(__dirname, 'allowed-origins.txt'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(l => l && l[0] !== '#'); } catch (e) {}
const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).concat(fileOrigins);

function originAllowed(o) {
  if (!o) return true;                                  // non-browser callers (curl)
  if (o === 'null') return true;                        // page opened from a local file
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return true;
  return extra.includes(o);
}

function callTally(xml) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(xml, 'utf8');
    const req = http.request({ host: TALLY_HOST, port: TALLY_PORT, method: 'POST', timeout: 60000,
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': buf.length } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const b = Buffer.concat(chunks);
        // Tally may answer in UTF-16LE depending on version/settings
        const text = (b.length > 1 && b[1] === 0) ? b.toString('utf16le') : b.toString('utf8');
        resolve(text.replace(/^\uFEFF/, ''));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Tally did not respond within 60 s')));
    req.on('error', reject); req.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject);
  });
}

function send(res, code, obj, origin) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin || '*', 'Vary': 'Origin' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (!originAllowed(origin)) return send(res, 403, { error: 'Origin not allowed. Set ALLOWED_ORIGINS to include ' + origin });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true', 'Vary': 'Origin' });
    return res.end();
  }
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/status') {
      try {
        const companies = T.parseCompanies(await callTally(T.companiesRequest()));
        return send(res, 200, { helper: true, version: '0.1.0', tally: { reachable: true, host: TALLY_HOST, port: TALLY_PORT, companies } }, origin);
      } catch (e) {
        return send(res, 200, { helper: true, version: '0.1.0', tally: { reachable: false, host: TALLY_HOST, port: TALLY_PORT, error: e.code || e.message } }, origin);
      }
    }
    if (req.method === 'GET' && url.pathname === '/ledgers') {
      const company = url.searchParams.get('company') || '';
      const xml = await callTally(T.ledgersRequest(company));
      const ledgers = T.parseLedgers(xml);
      return send(res, 200, { company: company || null, count: ledgers.length, ledgers,
        warning: ledgers.length ? undefined : 'Tally answered but no ledgers could be read. Use POST /raw to inspect the reply.' }, origin);
    }
    if (req.method === 'POST' && url.pathname === '/import') {
      const body = await readBody(req);
      if (!/<ENVELOPE>/.test(body) || !/Import Data/.test(body)) return send(res, 400, { error: 'Body must be a Tally import envelope.' }, origin);
      const reply = await callTally(T.withCompany(body, url.searchParams.get('company') || ''));
      const result = T.parseImportResponse(reply);
      return send(res, result.ok ? 200 : 422, result, origin);
    }
    if (req.method === 'POST' && url.pathname === '/raw') {          // debugging aid
      return send(res, 200, { reply: await callTally(await readBody(req)) }, origin);
    }
    send(res, 404, { error: 'Not found' }, origin);
  } catch (e) {
    send(res, 502, { error: 'Could not talk to Tally at ' + TALLY_HOST + ':' + TALLY_PORT + ' (' + (e.code || e.message) + ')' }, origin);
  }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => console.log('TaxNest Tally helper on http://127.0.0.1:' + PORT + '  ->  Tally ' + TALLY_HOST + ':' + TALLY_PORT));
}
module.exports = { server, callTally };
