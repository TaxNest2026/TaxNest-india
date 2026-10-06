const assert=require('assert'),fs=require('fs');const E=require('./mapping-engine.js'),V=require('./balance-validator.js'),S=require('./smart-mapping.js');
const truth=require('./parser-kotak-mahindra.js')(require('./fixture-statement.js').build(300,11).text);
let n=0;const t=(m,f)=>{f();n++;console.log('ok -',m)};
const mk=(ledgers)=>{const s=E.createState(V.assignReferences(truth.transactions));E.setLedgers(s,ledgers,'tally');return s};
const L=['Bank Charges','Cash','Salary','Kotak Mahindra Bank','Google India Digital Services Pvt Ltd','Loan EMI - HDFC','Freight Outward','Electricity Expense','Rent Paid'];
t('groups collapse reference numbers: same payee + direction = one group',()=>{
  const s=mk(L);const g=S.groupEntries(s);const goog=g.filter(x=>/GOOGLE INDIA DIGITAL/.test(x.label));
  console.log('   groups:',g.length,'| top:',g.slice(0,3).map(x=>x.count+'x '+x.label.slice(0,40)).join(' | '));
  assert(goog.length>=1&&goog[0].count>=40,'GOOGLE group is large: '+goog.map(x=>x.count));assert(g.length<s.entries.length/2,'real compression');
  assert.equal(g.reduce((a,x)=>a+x.count,0),300);});
t('direction is part of the key (same name paid vs received are separate groups)',()=>{
  const s=mk(L);const k=S.groupKey({narration:'UPI/MILKABEN PRATIK/1/NA',drCr:'D'}),k2=S.groupKey({narration:'UPI/MILKABEN PRATIK/2/NA',drCr:'C'});assert.notEqual(k,k2);
  assert.equal(S.groupKey({narration:'SentIMPS528016572622ROOHINEE 7/IBKLX0075/75',drCr:'D'}),S.groupKey({narration:'SentIMPS529013201229ROOHINEE 7/IBKLX0075/RS75',drCr:'D'}).replace(/RS$/,''))||0;});
t('party name in narration -> existing Tally ledger (prefix tolerant: SERVIC -> Services)',()=>{
  const s=mk(L);const p=S.partyMatch(s,'NEFT AXNGG27580741491 GOOGLE INDIA DIGITAL SERVIC');assert.equal(p.ledger,'Google India Digital Services Pvt Ltd');});
t('rules: ECS return charge, salary, cash deposit/withdrawal, loan, freight, electricity, rent',()=>{
  const s=mk(L);const m=(txt,d)=>(S.matchRule(s,txt,d)||{}).ledger;
  assert.equal(m('Chrg: ECS Return on 20251207 CENTRALISEDOPSCSBK','D'),'Bank Charges');assert.equal(m('UPI/DIMPALBEN ASHOK/528109415459/ASHOK SALARY','D'),'Salary');
  assert.equal(m('CASH DEPOSIT BY SELF AT AHMEDABAD','C'),'Cash');assert.equal(m('CASH WITHDRAWAL BY SELF AT CHANDKHEDA','D'),'Cash');
  assert.equal(m('NACH-10-DR-CATHOLICSYRIANBANK EMI','D'),'Loan EMI - HDFC');assert.equal(m('PAID TO OM TRANS LOGISTIC','D'),'Freight Outward');
  assert.equal(m('MSEB BILL PAYMENT','D'),'Electricity Expense');assert.equal(m('OFFICE RENT OCT','D'),'Rent Paid');
  assert.equal(m('CASH DEPOSIT','D'),undefined,'direction respected');});
t('rule with several candidate ledgers is ambiguous, never guessed',()=>{
  const s=mk(['Bank Charges','Bank Fee','Cash']);const r=S.matchRule(s,'Chrg: SMS alert','D');assert(r.ambiguous&&!r.ledger);});
t('rules never suggest a ledger that does not exist',()=>{const s=mk(['Cash']);assert.equal(S.matchRule(s,'Chrg: ECS Return','D'),null);});
t('group suggestions: learned beats party beats rule; unknown learned ledger ignored',()=>{
  const s=mk(L);const g=S.groupEntries(s);const ecs=g.find(x=>/ECS RETURN|CHRG/.test(x.label));assert.equal(ecs.suggestion.ledger,'Bank Charges');assert.equal(ecs.suggestion.source,'rule');
  const sal=g.find(x=>/ASHOK SALARY/.test(x.label));
  const learned=S.learn({},ecs.key,'Rent Paid');assert.equal(S.groupEntries(s,{learned}).find(x=>x.key===ecs.key).suggestion.source,'learned');
  const bad=S.learn({},ecs.key,'Ghost Ledger');assert.equal(S.groupEntries(s,{learned:bad}).find(x=>x.key===ecs.key).suggestion.source,'rule');});
t('locked / excluded / already-mapped rows are not offered again',()=>{
  const s=mk(L);const g0=S.groupEntries(s);const big=g0[0];E.assignLedger(s,big.refs.slice(0,3),'Cash','manual');
  const g1=S.groupEntries(s);assert.equal(g1.find(x=>x.key===big.key).count,big.count-3);const free=s.entries.find(e=>e.ledger_name===s.suspense);free.excluded=true;assert.equal(S.groupEntries(s).reduce((a,x)=>a+x.count,0),300-3-1);});
t('group assign through the engine = real bulk mapping with audit',()=>{
  const s=mk(L);const g=S.groupEntries(s)[0];const r=E.assignLedger(s,g.refs,'Google India Digital Services Pvt Ltd','bulk_manual');assert(r.ok);assert.equal(r.changed,g.count);assert.equal(E.counts(s).suspense,300-g.count);});
console.log(n+' smart-mapping tests passed');
