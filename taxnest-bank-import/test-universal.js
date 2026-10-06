const fs=require('fs');const assert=require('assert');
const U=require('./universal-parser.js');const V=require('./balance-validator.js');
const FX=require('./fixture-statement.js').build(300,11);const txt=FX.text;
const truth=require('./parser-kotak-mahindra.js')(txt);       // verified bank-specific result (300 rows, passed)
const tD=truth.transactions.reduce((s,t)=>s+(t.drCr==='D'?t.amount:0),0), tC=truth.transactions.reduce((s,t)=>s+(t.drCr==='C'?t.amount:0),0);
let n=0;const t=(m,f)=>{f();n++;console.log('ok -',m)};
const sums=r=>({D:Math.round(r.transactions.reduce((s,x)=>s+(x.drCr==='D'?x.amount:0),0)*100)/100,C:Math.round(r.transactions.reduce((s,x)=>s+(x.drCr==='C'?x.amount:0),0)*100)/100});
const validate=r=>V.validateStatement(r.transactions,{opening:r.statement.opening_balance,closing:r.statement.closing_balance});
const lines=txt.split('\n');
const rowIdx=[];lines.forEach((l,i)=>{if(/^\d{1,3} \d{2} [A-Z][a-z]{2} \d{4} /.test(l))rowIdx.push(i)});
t('synthetic statement: 300 rows, totals identical to the verified parser, 0 repairs, junk text ignored',()=>{
  const r=U.extractUniversal(txt);assert.equal(r.transactions.length,300);const s=sums(r);
  assert.equal(s.D,Math.round(tD*100)/100);assert.equal(s.C,Math.round(tC*100)/100);
  assert.equal(r.repair.reconstructed,0);assert.equal(r.statement.opening_balance,38.02);assert.equal(r.statement.closing_balance,FX.closing);
  assert.equal(validate(r).status,'passed');});
t('every direction + amount equals the verified parser row by row',()=>{
  const r=U.extractUniversal(txt);r.transactions.forEach((x,i)=>{const y=truth.transactions[i];assert.equal(x.amount,y.amount,'row '+(i+1));assert.equal(x.drCr,y.drCr,'row '+(i+1));assert.equal(x.date,y.date);});});
const without=(idxs)=>{const drop=new Set();idxs.forEach(i=>{let j=rowIdx[i]+1;while(j<lines.length&&rowIdx.indexOf(j)<0&&!/^Statement Generated|^ROOHINEE|^Account|^Current Account|^# Date/.test(lines[j]))j++;for(let k=rowIdx[i];k<j;k++)drop.add(k)});return lines.filter((_,i)=>!drop.has(i)).join('\n')};
t('5 scattered rows deleted from the text -> 5 rebuilt entries with the exact amounts/directions; totals exact',()=>{
  const gone=[10,57,150,230,280];const r=U.extractUniversal(without(gone));
  assert.equal(r.transactions.length,300);assert.equal(r.repair.reconstructed,5);const s=sums(r);assert.equal(s.D,Math.round(tD*100)/100);assert.equal(s.C,Math.round(tC*100)/100);
  const rebuilt=r.transactions.filter(x=>x.reconstructed);
  gone.forEach(i=>assert(rebuilt.some(x=>x.amount===truth.transactions[i].amount&&x.drCr===truth.transactions[i].drCr),'row '+(i+1)+' rebuilt'));
  assert.equal(validate(r).status,'passed');});
t('two adjacent rows lost -> one net entry, totals still reconcile exactly',()=>{
  const r=U.extractUniversal(without([100,101]));assert.equal(r.repair.reconstructed,1);assert.equal(validate(r).status,'passed');
  const a=truth.transactions[100],b=truth.transactions[101],net=(a.drCr==='C'?a.amount:-a.amount)+(b.drCr==='C'?b.amount:-b.amount);
  const x=r.transactions.find(z=>z.reconstructed);assert.equal(x.amount,Math.round(Math.abs(net)*100)/100);assert.equal(x.drCr,net>0?'C':'D');});
t('last 3 rows lost -> rebuilt from the printed closing balance',()=>{
  const r=U.extractUniversal(without([297,298,299]));assert.equal(r.repair.tailGap,1);assert.equal(validate(r).status,'passed');assert.equal(r.transactions[r.transactions.length-1].balance,FX.closing);});
t('first row lost -> rebuilt from the printed opening balance',()=>{
  const r=U.extractUniversal(without([0]));assert.equal(r.repair.reconstructed,1);const x=r.transactions.find(z=>z.reconstructed);assert.equal(x.amount,truth.transactions[0].amount);assert.equal(x.drCr,truth.transactions[0].drCr);assert.equal(validate(r).status,'passed');});
t('newest-first statement (rows reversed) gives identical totals',()=>{
  const head=lines.slice(0,rowIdx[0]).filter(l=>!/Opening Balance Closing/.test(l));const rows=rowIdx.map((s,i)=>lines.slice(s,i+1<rowIdx.length?rowIdx[i+1]:rowIdx[i]+3).filter(l=>!/^Statement Generated|^ROOHINEE|^Account|^Current Account|^# Date|^End of|^Account Summary|^Particulars|^Current Account \(CA\)|^accepted until/.test(l)));
  const rev=head.concat(rows.slice().reverse().flat()).concat(['Account Summary','Opening Balance Closing Balance','Current Account (CA): 38.02 '+FX.closing.toFixed(2)]).join('\n');
  const r=U.extractUniversal(rev);const s=sums(r);assert.equal(r.transactions.length,300);assert.equal(s.D,Math.round(tD*100)/100);assert.equal(s.C,Math.round(tC*100)/100);assert.equal(validate(r).status,'passed');});
t('no opening/closing labels anywhere: opening derived from first row (balance-cannot-be-negative / narration), status chain_ok not passed',()=>{
  const stripped=txt.replace(/Opening Balance/g,'XX').replace(/Closing Balance/g,'YY');const r=U.extractUniversal(stripped);
  assert.equal(r.statement.opening_balance,null);assert.equal(r.statement.derived_opening_balance,38.02);assert.equal(r.repair.reconstructed,0);
  const v=V.validateStatement(r.transactions,{});assert.equal(v.status,'chain_ok');assert.equal(v.opening_balance,38.02);});
t('amount token missing on one row -> row skipped, then rebuilt from the balance gap',()=>{
  const l2=lines.slice();const i=rowIdx[150];l2[i]=l2[i].replace(/\s[\d,]+\.\d{2}\s([\d,]+\.\d{2})$/,' $1');const r=U.extractUniversal(l2.join('\n'));
  assert.equal(r.transactions.length,300);assert.equal(validate(r).status,'passed');});
t('wrong column: amount printed as the second-to-last number is a cheque value -> balance wins',()=>{
  const syn=`Opening Balance 1,000.00\n01-04-2026 CHQ DEP 100000.00 250.00 1,250.00\n02-04-2026 POS PURCHASE 500.00 750.00\nClosing Balance 750.00`;
  const r=U.extractUniversal(syn);assert.equal(r.transactions[0].amount,250);assert.equal(r.transactions[0].drCr,'C');assert.equal(r.transactions[1].drCr,'D');assert.equal(validate(r).status,'passed');});
t('single-transaction statement: opening derived from closing identity (credit impossible => debit)',()=>{
  const syn=`01-04-2026 NEFT TO VENDOR 500.00 0.00`;const r=U.extractUniversal(syn);assert.equal(r.transactions[0].drCr,'D');assert.equal(r.statement.derived_opening_balance,500);});
t('lost "received 50,000" before "sent 50,000" (balance unchanged) is rebuilt, not mistaken for a duplicate',()=>{
  const syn=`Opening Balance 1,000.00\n01-04-2026 UPI SENT TO VENDOR 400.00 600.00\n02-04-2026 SENTIMPS PAYMENT 50,000.00 600.00\n03-04-2026 POS PURCHASE 100.00 500.00\nClosing Balance 500.00`;
  const r=U.extractUniversal(syn);assert.equal(r.repair.reconstructed,1);assert.equal(r.repair.noBalanceEffect,0);
  const vv=V.validateStatement(r.transactions,{opening:1000,closing:500});assert.equal(vv.status,'passed');
  const dup=`Opening Balance 1,000.00\n01-04-2026 POS PURCHASE 400.00 600.00\n01-04-2026 POS PURCHASE 400.00 600.00\nClosing Balance 600.00`;
  const d=U.extractUniversal(dup);assert.equal(d.repair.noBalanceEffect,1);assert.equal(d.repair.reconstructed,0);});
console.log(n+' universal-parser tests passed');
