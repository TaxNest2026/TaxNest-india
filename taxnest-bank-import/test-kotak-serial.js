// Synthetic fixture shaped like the real Kotak "serial-number" layout (no real client data).
const assert=require('assert');const kotak=require('./parser-kotak-mahindra.js');const V=require('./balance-validator.js');
const txt=`Account Statement
01 Oct 2025 - 31 Oct 2025
TEST TRADERS Account No. 1234567890
Current Account Transactions
# Date Description Chq/Ref. No. Withdrawal (Dr.) Deposit (Cr.) Balance
- - Opening Balance - - - 1,000.00
1 01 Oct 2025 Recd:IMPS/1/ABC IMPS-111 2,50,000.00 2,51,000.00
CO LTD/KKBK
2 02 Oct 2025 NACH-10-DR-BANKX- NACHDB0710251219 1,00,000.00 1,51,000.00
123456 00
3 03 Oct 2025 CASH WITHDRAWAL BY SELF AT BRANCH 1368 51,000.00 1,00,000.00
Statement Generated on 02 Mar 2026, 15:22 Page 1 of 2
TEST TRADERS Account No. 1234567890
Current Account Transactions
# Date Description Chq/Ref. No. Withdrawal (Dr.) Deposit (Cr.) Balance
4 04 Oct 2025 Chrg: ECS Return on 20251004 590.00 99,410.00
Account Summary
Particulars Opening Balance Closing Balance
Current Account (CA): 1,000.00 99,410.00`;
const r=kotak(txt),t=r.transactions;
assert.equal(t.length,4);assert.equal(t[0].drCr,'C');assert.equal(t[1].drCr,'D');
assert.equal(t[1].refNo,'NACHDB071025121900');assert.equal(t[1].narration,'NACH-10-DR-BANKX-123456');
assert.equal(t[2].refNo,'1368');assert.equal(t[3].refNo,'');assert.equal(t[0].narration,'Recd:IMPS/1/ABC CO LTD/KKBK');
assert.equal(r.statement.opening_balance,1000);assert.equal(r.statement.closing_balance,99410);assert.equal(r.statement.serial_gaps.length,0);
const v=V.validateStatement(t,{opening:1000,closing:99410});assert.equal(v.status,'passed');
// a dropped row must be caught two ways: serial gap and balance chain
const drop=kotak(txt.replace(/^2 02 Oct.*\n123456 00\n/m,''));
assert.equal(drop.statement.serial_gaps.length,1);
assert.equal(V.validateStatement(drop.transactions,{opening:1000,closing:99410}).status,'failed');
console.log('kotak serial-layout tests passed; dropped-row case ->',V.validateStatement(drop.transactions,{opening:1000,closing:99410}).status,'gaps',JSON.stringify(drop.statement.serial_gaps));
