# TaxNest Bank Import - v7

## Added in this version
- Excel / CSV statement upload (.xlsx, .xls, .csv, .tsv). Column headers are detected (date, particulars, debit/credit,
  single amount with Dr/Cr column, balance, reference). Verified on a real .xlsx file and in the browser.
- "＋ New ledger" popup (Tally bar and bulk bar): name plus Tally group head. New ledgers are created in Tally before the
  vouchers are pushed; leading/trailing spaces removed; duplicates refused.
- Recurring payments panel in Quick clean-up: same amount in 3+ months, once a month (rent, EMI, SIP, salary).
- AI Mapping "By account" tab: groups pending suggestions by account, with "Map all N → account" per group.
- Push popup and progress screen show the supplied animation (fallback to the nest drawing).
- Magnetic cursor: logo-printed coins and dust are pulled in and absorbed. Always on (no off switch).
- Animated round favicon from the supplied frames.
- Glass-morphism styling across panels, modals and the Tally bar.
- Sound cues (extract, assign, push, done, error) with a mute button.
- Tally ledger names keep trailing spaces exactly as Tally stores them.

## Verified
- ICICI statement (239 pages): 1,879 rows, all serial numbers present, balance chain consistent. No opening/closing totals are printed,
  so the check reports "chain consistent" (not "passed").
- Unit tests: validator, Kotak serial layout, engine, universal parser, smart mapping, ledger import, layouts (12), Excel (7),
  features (5), helper (10).
- Browser: offline 29/29, connected 38/38, missing-Suspense 31/31; spreadsheet upload reaches review with 4 correct transactions.

## Not done (honest)
- TDL: Repotic-TDL.tcp is a compiled binary Tally package. Its name/contact cannot be safely replaced, so no TDL download
  button was added. A plain-text .tdl can be written but must be tested inside Tally first.
- Image-only sample banks (BOB, IndusInd, Federal, Central, IDFC, Axis, South Indian, KVB, SBI, UCO, Indian Bank): tested only on
  reconstructed text, not their real PDFs.
- Glass effects and magnetic coins: checked by screenshot of the review screen; not reviewed on a phone.
