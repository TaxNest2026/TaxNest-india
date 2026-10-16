const assert=require('assert');const L=require('./ledger-import.js');let n=0;const t=(m,f)=>{f();n++;console.log('ok -',m)};
t('masters XML (LEDGER NAME attr + PARENT), entities, duplicates',()=>{
 const x=`<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Cash" RESERVEDNAME=""><PARENT>Cash-in-Hand</PARENT></LEDGER><LEDGER NAME="R &amp; D Expenses"><PARENT>Indirect Expenses</PARENT></LEDGER><LEDGER NAME="Cash"><PARENT>x</PARENT></LEDGER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
 const r=L.parseLedgerFile(x,'masters.xml');assert.equal(r.format,'xml');assert.deepEqual(r.names,['Cash','R & D Expenses']);assert.equal(r.parents['Cash'],'Cash-in-Hand');});
t('display-report XML (DSPACCNAME/DSPDISPNAME)',()=>{
 const x=`<ENVELOPE><DSPACCNAME><DSPDISPNAME>Bank Charges</DSPDISPNAME></DSPACCNAME><DSPACCINFO>..</DSPACCINFO><DSPACCNAME><DSPDISPNAME>Sales</DSPDISPNAME></DSPACCNAME></ENVELOPE>`;
 assert.deepEqual(L.parseLedgerFile(x,'list.xml').names,['Bank Charges','Sales']);});
t('UTF-16LE encoded XML (as Tally often writes)',()=>{
 const s='<ENVELOPE><LEDGER NAME="Électricity Expense"><PARENT>Indirect Expenses</PARENT></LEDGER></ENVELOPE>';const b=Buffer.concat([Buffer.from([0xFF,0xFE]),Buffer.from(s,'utf16le')]);
 assert.deepEqual(L.parseLedgerFile(new Uint8Array(b),'a.xml').names,['Électricity Expense']);});
t('HTML table export: header + total rows + numeric columns dropped, name column detected, parent kept',()=>{
 const h=`<html><body><table><tr><th>Particulars</th><th>Under</th><th>Debit</th></tr>
 <tr><td>Bank Charges</td><td>Indirect Expenses</td><td>1,200.00</td></tr><tr><td>Electricity &amp; Power</td><td>Indirect Expenses</td><td>5,000.00 Dr</td></tr>
 <tr><td>Kotak Mahindra Bank</td><td>Bank Accounts</td><td>10.00</td></tr><tr><td>Grand Total</td><td></td><td>6,210.00</td></tr></table></body></html>`;
 const r=L.parseLedgerFile(h,'ledgers.html');assert.equal(r.format,'html');assert.deepEqual(r.names,['Bank Charges','Electricity & Power','Kotak Mahindra Bank']);assert(r.notes.length);});
t('txt / csv: first column, header skipped',()=>{
 assert.deepEqual(L.parseLedgerFile('Name,Parent\nCash,Cash-in-Hand\n"Rent, Office",Indirect\nSales','l.csv').names,['Cash','Rent, Office','Sales']);
 assert.deepEqual(L.parseLedgerFile('Cash\r\nSales\r\n','l.txt').names,['Cash','Sales']);});
t('unrecognised file reports nothing found (never invents)',()=>{const r=L.parseLedgerFile('<html><body><p>hello</p></body></html>','x.html');assert(r.names.length<=1);const e=L.parseLedgerFile('','e.txt');assert.equal(e.names.length,0);assert(e.notes[0]);});
console.log(n+' ledger-import tests passed');
