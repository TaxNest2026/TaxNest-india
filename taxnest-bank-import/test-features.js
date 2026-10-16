const assert=require('assert');const E=require('./mapping-engine.js'),S=require('./smart-mapping.js'),V=require('./balance-validator.js');let n=0;const t=(m,f)=>{f();n++;console.log('ok -',m)};
function mk(rows){return E.createState(V.assignReferences(rows))}
function mon(y,m,d){return y+('0'+m).slice(-2)+('0'+d).slice(-2)}
t('recurring: same amount every month -> detected (rent-like), with the month count',()=>{
 const rows=[];for(let m=1;m<=6;m++)rows.push({date:mon(2026,m,5),narration:'NEFT TO SHARMA PROPERTIES RENT',amount:25000,drCr:'D',balance:0});
 rows.push({date:mon(2026,2,9),narration:'UPI TO RANDOM SHOP',amount:1200,drCr:'D',balance:0});
 const s=mk(rows);const g=S.detectRecurring(s);assert.equal(g.length,1);assert.equal(g[0].amount,25000);assert.equal(g[0].months,6);assert.equal(g[0].count,6);});
t('recurring: two payments in one month, or irregular gaps -> NOT recurring',()=>{
 const rows=[{date:mon(2026,1,3),narration:'EMI A',amount:5000,drCr:'D',balance:0},{date:mon(2026,1,20),narration:'EMI A',amount:5000,drCr:'D',balance:0},
  {date:mon(2026,2,3),narration:'EMI A',amount:5000,drCr:'D',balance:0},{date:mon(2026,3,3),narration:'EMI A',amount:5000,drCr:'D',balance:0}];
 assert.equal(S.detectRecurring(mk(rows)).length,0);
 const rows2=[mon(2026,1,1),mon(2026,1,30),mon(2026,4,20)].map(d=>({date:d,narration:'SIP X',amount:1000,drCr:'D',balance:0}));
 assert.equal(S.detectRecurring(mk(rows2)).length,0);});
t('recurring: salary (credit) detected separately from debits',()=>{
 const rows=[1,2,3,4].map(m=>({date:mon(2026,m,1),narration:'NEFT SALARY ROHAN',amount:40000,drCr:'C',balance:0}));
 const g=S.detectRecurring(mk(rows));assert.equal(g.length,1);assert.equal(g[0].drCr,'C');});
t('AI: "accept all for one account" applies only that ledger, keeps others pending',()=>{
 const s=mk([{date:'20260101',narration:'A',amount:1,drCr:'D',balance:0},{date:'20260102',narration:'B',amount:2,drCr:'D',balance:0},{date:'20260103',narration:'C',amount:3,drCr:'D',balance:0}]);
 E.setLedgers(s,['Rent Expense','Cash'],'tally');
 s.entries[0].ai_suggestion={ledger:'Rent Expense',confidence:0.95,reason:'x',status:'pending'};
 s.entries[1].ai_suggestion={ledger:'Rent Expense',confidence:0.8,reason:'y',status:'pending'};
 s.entries[2].ai_suggestion={ledger:'Cash',confidence:0.9,reason:'z',status:'pending'};
 const g=E.pendingByLedger(s);assert.equal(g[0].ledger,'Rent Expense');assert.equal(g[0].refs.length,2);
 const r=E.acceptByLedger(s,'Rent Expense');assert.equal(r.applied,2);assert.equal(s.entries[2].ai_suggestion.status,'pending');assert.equal(s.entries[0].ledger_name,'Rent Expense');});
t('new ledger: trims stray spaces, refuses duplicates and unknown groups, queued for Tally',()=>{
 const s=mk([]);E.setLedgers(s,['Cash'],'tally');
 let r=E.addNewLedger(s,'  Office Rent  ','Indirect Expenses');assert.ok(r.ok);assert.equal(r.name,'Office Rent');
 assert.equal(E.addNewLedger(s,'office rent','Indirect Expenses').ok,false);
 assert.equal(E.addNewLedger(s,'Other','Made Up Group').ok,false);
 assert.equal(E.addNewLedger(s,'   ','Sundry Creditors').ok,false);
 assert.deepEqual(s.pendingLedgers,[{name:'Office Rent',parent:'Indirect Expenses'}]);
 assert.ok(E.canonicalLedger(s,'OFFICE RENT'));});
console.log(n+' feature tests passed');
