# TaxNest Bank Import — update 3 (complete working tool)

## Run it
1. Open a terminal in this folder:  `python -m http.server 8000`  (or any static server) → http://localhost:8000/bank-recon-landing.html
   (opening the HTML file directly also works, but a local server is more reliable)
2. Optional live Tally:  `cd tally-helper && node server.js`   (Tally open, XML/ODBC server on port 9000)
   In the tool: "Connect to Tally" → choose company → "Load ledgers".
Needs internet for pdf.js and SheetJS (cdnjs), same as before.

## Flow
Pick bank → upload PDF → progress stages → validation card → filter / select / bulk-assign ledgers →
(optional) AI package → upload AI result → review → Excel / Tally XML (or push to Tally).

## Files
Changed:  bank-recon-landing.html (new Step 2 shell + scripts), bank-recon-extract.js (rewritten),
          bank-parser-core.js, parser-kotak-mahindra.js (2nd Kotak layout + bug fix), parser-bandhan-bank.js
New:      balance-validator.js, mapping-engine.js, bank-recon-review.js, bank-recon-review.css, tally-helper/
Unchanged (your originals, included so the folder runs as-is): bank-recon-landing.js/.css, bank-list.js, tally-xml-builder.js

## Tests (no browser needed)
node test-validator.js · node test-kotak-serial.js · node test-engine.js · cd tally-helper && node test.js

## Adding a bank parser later
1. parser-<bank>.js → `BankParserCore.registerParser('<key>', fn)`; fn(text) returns { transactions, skipped, statement?, directionFromMarker? }
   (statement.opening_balance / closing_balance, when printed on the PDF, upgrade validation from "rows consistent" to "passed").
2. One line in bank-recon-extract.js: BANK_ID_TO_PARSER_KEY['<id from bank-list.js>'] = '<key>'
3. Script tag in the HTML. Banks without a parser use the universal parser automatically.
