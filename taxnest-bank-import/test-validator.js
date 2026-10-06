const V=require('./balance-validator.js'); const assert=require('assert'); let n=0;
const t=(name,fn)=>{fn();n++;console.log('ok -',name)};
const base=[
 {date:'20260401',amount:5000,drCr:'D',balance:95000},
 {date:'20260402',amount:25000,drCr:'C',balance:120000},
 {date:'20260403',amount:118,drCr:'D',balance:119882}];
t('clean statement with supplied opening/closing -> passed',()=>{
 const r=V.validateStatement(base,{opening:100000,closing:119882,directionFromMarker:true});
 assert.equal(r.status,'passed'); assert.equal(r.difference,0); assert.equal(r.total_debit,5118); assert.equal(r.total_credit,25000);});
t('no supplied opening/closing -> chain_ok, never passed',()=>{
 const r=V.validateStatement(base,{}); assert.equal(r.status,'chain_ok'); assert.equal(r.opening_balance,100000); assert.equal(r.opening_source,'derived');});
t('dropped row detected with missing amount',()=>{
 const r=V.validateStatement([base[0],base[2]],{opening:100000,closing:119882});
 assert.equal(r.status,'failed'); assert.equal(r.failures[0].kind,'amount_or_row_missing');
 assert.ok(/25000|24882/.test(r.failures[0].message),r.failures[0].message);});
t('reversed direction detected',()=>{
 const x=base.map(o=>({...o})); x[1].drCr='D';
 const r=V.validateStatement(x,{opening:100000,closing:119882,directionFromMarker:true});
 assert.equal(r.status,'failed'); assert.equal(r.failures[0].kind,'direction_wrong');});
t('wrong closing balance supplied -> failed with difference',()=>{
 const r=V.validateStatement(base,{opening:100000,closing:119382}); assert.equal(r.status,'failed'); assert.equal(r.difference,500);});
t('newest-first statement validated oldest-first',()=>{
 const r=V.validateStatement(base.slice().reverse(),{opening:100000,closing:119882}); assert.equal(r.status,'passed'); assert.match(r.order,/descending/);});
t('no balances, no opening/closing -> not_available',()=>{
 const r=V.validateStatement(base.map(({balance,...o})=>o),{}); assert.equal(r.status,'not_available');});
t('references + duplicates',()=>{
 const a=V.assignReferences(base); assert.equal(a[2].reference_no,'TXN-000003'); assert.equal(a[0].ledger_name,'Suspense A/c');
 assert.equal(V.findPossibleDuplicates([base[0],base[0]]).length,1);});
console.log(n+' tests passed');
