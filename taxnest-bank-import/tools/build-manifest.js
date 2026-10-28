/* build-manifest.js -- run after adding or changing a parser in bank-parsers/.
   Writes bank-parsers/manifest.json, the list the tool loads at start-up.
   Usage (from the project root):  node tools/build-manifest.js                         */
'use strict';
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'bank-parsers');
const files = fs.readdirSync(dir)
  .filter(f => /^parser-.*\.js$/.test(f))
  .sort();
const manifest = { generated: new Date().toISOString(), parsers: files };
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('manifest.json written with ' + files.length + ' parser(s):');
files.forEach(f => console.log('  ' + f));
