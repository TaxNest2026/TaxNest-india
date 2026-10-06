/* ledger-import.js -- read ledger names out of files exported from Tally (XML or HTML), plus plain text/CSV.
   No DOM needed (works in Node and the browser). Returns { names:[], parents:{name:parent}, format, notes:[] }.

   VERIFICATION STATUS: written against the export shapes Tally is known to produce, NOT yet checked against
   a real file from this user's Tally. The UI always shows a preview ("found N ledgers: ...") before anything is used.
   Shapes handled:
     XML  <LEDGER NAME="Cash">...<PARENT>Cash-in-Hand</PARENT>   (masters / data-interchange export)
          <DSPACCNAME><DSPDISPNAME>Cash</DSPDISPNAME>             (display-report export, e.g. List of Ledgers)
          <NAME>Cash</NAME> inside <LEDGER> / <LEDGERNAME>
     HTML tables: the column that looks like names (non-numeric, mostly unique) is used; header/total rows dropped.
     TXT/CSV: first column, one per line.                                                                      */
(function (root) {
  'use strict';
  function unesc(s) {
    return String(s).replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); }).replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); }).replace(/&amp;/g, '&');
  }
  function clean(s) { return unesc(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
  var HEADER_WORDS = /^(particulars|name|ledger|ledgers|ledger name|list of ledgers|list of accounts|group|parent|under|total|grand total|debit|credit|closing balance|opening balance|s\.?\s*no\.?|sr\.?\s*no\.?|#|amount|balance|dr|cr)$/i;
  function looksNumeric(s) { return /^[\d.,\s()\-+₹]*(?:dr|cr)?$/i.test(s); }
  function decode(buf) {
    if (typeof buf === 'string') return buf;
    var b = buf; if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b); if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b);
    if (b.length > 1 && b[1] === 0) return new TextDecoder('utf-16le').decode(b); return new TextDecoder('utf-8').decode(b);
  }

  function fromXml(text) {
    var names = [], parents = {}, seen = {}, re, m;
    function add(n, p) { n = clean(n); if (!n || HEADER_WORDS.test(n) || seen[n.toLowerCase()]) return; seen[n.toLowerCase()] = 1; names.push(n); if (p) parents[n] = clean(p); }
    re = /<LEDGER\b([^>]*)>([\s\S]*?)<\/LEDGER>/gi;
    while ((m = re.exec(text))) {
      var a = m[1].match(/\bNAME\s*=\s*"([^"]*)"/i), inner = m[2].match(/<NAME>([^<]*)<\/NAME>/i), par = m[2].match(/<PARENT>([^<]*)<\/PARENT>/i);
      add((a && a[1]) || (inner && inner[1]) || '', par && par[1]);
    }
    if (!names.length) { re = /<DSPACCNAME>\s*<DSPDISPNAME>([^<]*)<\/DSPDISPNAME>/gi; while ((m = re.exec(text))) add(m[1]); }
    if (!names.length) { re = /<LEDGERNAME>([^<]*)<\/LEDGERNAME>/gi; while ((m = re.exec(text))) add(m[1]); }
    return { names: names, parents: parents };
  }

  function fromHtml(text) {
    var rows = [], re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, m;
    while ((m = re.exec(text))) {
      var cells = [], cre = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi, c;
      while ((c = cre.exec(m[1]))) cells.push(clean(c[1]));
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) { // not a table: list items / lines
      var li = [], lre = /<(?:li|p|div|span)\b[^>]*>([^<]{2,120})</gi, l; while ((l = lre.exec(text))) li.push([clean(l[1])]); rows = li;
    }
    // choose the best name column
    var maxCols = rows.reduce(function (a, r) { return Math.max(a, r.length); }, 0), best = -1, bestScore = -1;
    for (var col = 0; col < maxCols; col++) {
      var vals = rows.map(function (r) { return r[col]; }).filter(function (v) { return v && !HEADER_WORDS.test(v) && !looksNumeric(v); });
      var uniq = {}; vals.forEach(function (v) { uniq[v.toLowerCase()] = 1; });
      var score = Object.keys(uniq).length - (col * 0.01);                 // more distinct text values, earlier column wins ties
      if (score > bestScore) { bestScore = score; best = col; }
    }
    var names = [], parents = {}, seen = {};
    if (best >= 0) {
      var parentCol = -1; rows.forEach(function (r) { if (parentCol < 0 && r.some(function (x) { return /^(parent|under|group)$/i.test(x); })) parentCol = r.findIndex(function (x) { return /^(parent|under|group)$/i.test(x); }); });
      rows.forEach(function (r) {
        var v = r[best]; if (!v || HEADER_WORDS.test(v) || looksNumeric(v) || seen[v.toLowerCase()]) return;
        seen[v.toLowerCase()] = 1; names.push(v); if (parentCol >= 0 && r[parentCol] && !HEADER_WORDS.test(r[parentCol])) parents[v] = r[parentCol];
      });
    }
    return { names: names, parents: parents };
  }

  function fromText(text) {
    var names = [], seen = {};
    text.split(/\r?\n/).forEach(function (line) {
      var first = line.indexOf('\t') >= 0 ? line.split('\t')[0] : (/^"/.test(line) ? (line.match(/^"([^"]*)"/) || [, ''])[1] : line.split(',')[0]);
      first = first.trim(); if (!first || HEADER_WORDS.test(first) || seen[first.toLowerCase()]) return; seen[first.toLowerCase()] = 1; names.push(first);
    });
    return { names: names, parents: {} };
  }

  /* input: string or Uint8Array; fileName used as a hint only */
  function parseLedgerFile(input, fileName) {
    var text = decode(input).replace(/^\uFEFF/, ''), notes = [], res, format;
    var head = text.slice(0, 2000).toLowerCase();
    if (/<envelope|<tallymessage|<ledger\b|<dspaccname|<\?xml/.test(head) || /\.xml$/i.test(fileName || '') && /<\w+/.test(head)) { res = fromXml(text); format = 'xml'; if (!res.names.length && /<tr\b/i.test(text)) { res = fromHtml(text); format = 'html'; } }
    else if (/<html|<table|<tr\b|<body/.test(head) || /\.html?$/i.test(fileName || '')) { res = fromHtml(text); format = 'html'; }
    else { res = fromText(text); format = 'text'; }
    if (!res.names.length) notes.push('No ledger names could be recognised in this file.');
    else if (format === 'html') notes.push('HTML exports can include group names or other lists. Check the preview and untick anything that is not a ledger.');
    return { names: res.names, parents: res.parents, format: format, notes: notes };
  }
  var LedgerImport = { parseLedgerFile: parseLedgerFile };
  if (typeof module !== 'undefined' && module.exports) module.exports = LedgerImport; else root.LedgerImport = LedgerImport;
})(typeof window !== 'undefined' ? window : this);
