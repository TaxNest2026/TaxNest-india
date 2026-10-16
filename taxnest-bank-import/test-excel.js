const assert=require('assert');const X=require('./excel-import.js');let n=0;const t=(m,f)=>{f();n++;console.log('ok -',m)};
t('split Debit/Credit columns with a title block above the header',()=>{
 const r=X.parseRows([['ACME TRADERS'],['Account statement 01-04-2026 to 30-04-2026'],[],
  ['Transaction Date','Value Date','Particulars','Chq/Ref No','Debit','Credit','Balance'],
  ['01-04-2026','01-04-2026','UPI/RENT/SHARMA','UPI123','5,000.00','', '95,000.00'],
  ['02-04-2026','02-04-2026','NEFT FROM CLIENT A','N77','','25,000.00','1,20,000.00'],
  ['03-04-2026','03-04-2026','BANK CHARGES','', '118.00','','1,19,882.00']]);
 assert.equal(r.transactions.length,3);assert.equal(r.transactions[0].drCr,'D');assert.equal(r.transactions[1].drCr,'C');assert.equal(r.transactions[1].amount,25000);assert.equal(r.transactions[0].date,'20260401');assert.equal(r.transactions[0].refNo,'UPI123');});
t('Excel serial dates and numeric amounts',()=>{
 const r=X.parseRows([['Date','Narration','Withdrawal','Deposit','Balance'],[46113,'SALARY CREDIT',null,50000,50000],[46114,'ATM WDL',2000,null,48000]]);
 assert.equal(r.transactions[0].date,'20260401');assert.equal(r.transactions[0].drCr,'C');assert.equal(r.transactions[1].drCr,'D');assert.equal(r.transactions[1].amount,2000);});
t('single Amount column + Dr/Cr column (bank writes DR/CR next to the amount)',()=>{
 const r=X.parseRows([['Txn Date','Details','Amount','Dr/Cr','Closing Balance'],['05/05/2025','IMPS to vendor','1,500.00','DR','8,500.00'],['06/05/2025','Salary','10,000.00','CR','18,500.00']]);
 assert.equal(r.transactions[0].drCr,'D');assert.equal(r.transactions[1].drCr,'C');assert.equal(r.transactions[1].amount,10000);});
t('amount cell carries its own marker ("1,000.00 Dr")',()=>{
 const r=X.parseRows([['Date','Particulars','Amount'],['01-06-2025','CASH WDL','1,000.00 Dr'],['02-06-2025','DEPOSIT','500.00 Cr']]);
 assert.equal(r.transactions[0].drCr,'D');assert.equal(r.transactions[1].drCr,'C');assert.equal(r.transactions[0].amount,1000);});
t('balance chain corrects a wrong Dr/Cr column',()=>{
 const r=X.parseRows([['Date','Narration','Debit','Credit','Balance'],['01-07-2025','A',null,'100.00','1,000.00'],['02-07-2025','B','50.00',null,'1,050.00']]);
 assert.equal(r.transactions[1].drCr,'C');assert.equal(r.transactions[1].direction_from_balance,true);});
t('dd-Mon-yyyy dates and rows without a date are skipped, not guessed',()=>{
 const r=X.parseRows([['Date','Narration','Debit','Credit'],['12-Jan-2026','X','10','' ],['','Total','10','0'],['13-Jan-2026','Y','','5']]);
 assert.equal(r.transactions.length,2);assert.equal(r.transactions[0].date,'20260112');assert.ok(r.skipped.length>=1);});
t('no header -> clear message, nothing invented',()=>{
 const r=X.parseRows([['hello'],['world']]);assert.equal(r.transactions.length,0);assert.ok(/Could not find/.test(r.notes[0]));});
console.log(n+' excel tests passed');
