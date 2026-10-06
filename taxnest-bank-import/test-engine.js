const assert=require('assert');const E=require('./mapping-engine.js');const V=require('./balance-validator.js');
let n=0;const t=(m,f)=>{f();n++;console.log('ok -',m)};
const raw=[
 {date:'20260401',narration:'BANK CHARGES GST',amount:118,drCr:'D',refNo:'',balance:99882},
 {date:'20260402',narration:'NEFT CUSTOMER PAYMENT ABC',amount:25000,drCr:'C',refNo:'N1',balance:124882},
 {date:'20260403',narration:'Bank Charges SMS',amount:12,drCr:'D',refNo:'',balance:124870},
 {date:'20260404',narration:'UPI/RENT',amount:15000,drCr:'D',refNo:'U1',balance:109870}];
const mk=()=>{const s=E.createState(V.assignReferences(raw));E.setLedgers(s,['Bank Charges','Sales','Rent Expense','Kotak Bank'],'tally');return s};
t('default every entry to Suspense with source default',()=>{const s=mk();assert(s.entries.every(e=>e.ledger_name==='Suspense A/c'&&e.ledger_source==='default'));});
t('ledger list always includes Suspense, deduped case-insensitively',()=>{const s=E.createState([]);E.setLedgers(s,['Sales','sales',' Sales ']);assert.deepEqual(s.ledgers,['Sales','Suspense A/c']);});
t('contains filter is case-insensitive; not_contains / starts_with / exact',()=>{const s=mk();
 const f=(op,v)=>E.applyFilters(s,[{field:'narration',op,value:v}]).length;
 assert.equal(f('contains','CHARGES'),2);assert.equal(f('contains','charges'),2);assert.equal(f('not_contains','charges'),2);
 assert.equal(f('starts_with','upi'),1);assert.equal(f('exact','upi/rent'),1);assert.equal(f('contains',''),4);});
t('amount filters + date range + suspense/unmapped',()=>{const s=mk();
 assert.equal(E.applyFilters(s,[{field:'debit',op:'gt',value:'100'}]).length,2);
 assert.equal(E.applyFilters(s,[{field:'credit',op:'gt',value:'0'}]).length,1);
 assert.equal(E.applyFilters(s,[],{from:'20260402',to:'20260403'}).length,2);
 assert.equal(E.applyFilters(s,[{field:'ledger',op:'is_suspense'}]).length,4);});
t('bulk assign: only filtered refs change, source recorded, locked, audited',()=>{const s=mk();
 const refs=E.applyFilters(s,[{field:'narration',op:'contains',value:'bank charges'}]).map(e=>e.reference_no);
 const r=E.assignLedger(s,refs,'bank charges','bulk_manual');assert(r.ok);assert.equal(r.changed,2);
 assert.equal(s.entries[0].ledger_name,'Bank Charges');assert.equal(s.entries[0].ledger_source,'bulk_manual');assert(s.entries[0].mapping_locked);
 assert.equal(s.entries[1].ledger_name,'Suspense A/c');assert.equal(s.audit.length,2);assert.equal(s.audit[0].from,'Suspense A/c');});
t('assigning an unavailable ledger is refused',()=>{const s=mk();const r=E.assignLedger(s,['TXN-000001'],'Made Up Ledger','manual');assert(!r.ok);assert.equal(s.entries[0].ledger_name,'Suspense A/c');});
t('ledger autocomplete: prefix first then substring',()=>{const s=mk();E.setLedgers(s,['Bank Charges','Bank Account','Axis Bank','Sales'],'tally');
 assert.deepEqual(E.searchLedgers(s,'bank').slice(0,3),['Bank Account','Bank Charges','Axis Bank']);});
t('AI input contains refs, ledgers, directions; prompt forbids inventing',()=>{const s=mk();const i=E.buildAiInput(s,{bank:'Kotak'});
 assert.equal(i.transactions.length,4);assert.equal(i.transactions[1].credit,25000);assert(i.available_tally_ledgers.includes('Bank Charges'));
 assert(/Never invent a ledger/.test(E.buildAiPromptText()));});
const ai=(s,maps,extra)=>JSON.stringify(Object.assign({version:'1.0',mappings:maps},extra||{}));
t('AI result: bad JSON / wrong version / missing array are fatal',()=>{const s=mk();
 assert(E.validateAiResult(s,'{nope').fatal);assert(E.validateAiResult(s,'{"version":"9","mappings":[]}').fatal);assert(E.validateAiResult(s,'{"version":"1.0"}').fatal);
 assert(!E.validateAiResult(s,'```json\n{"version":"1.0","mappings":[]}\n```').fatal);});
t('AI result: unknown ledger -> Suspense + flagged; unknown/duplicate ref rejected; modified amount rejected',()=>{const s=mk();
 const v=E.validateAiResult(s,ai(s,[
  {reference_no:'TXN-000001',ledger_name:'Bank Charges',confidence:0.97,reason:'charges'},
  {reference_no:'TXN-000002',ledger_name:'XYZ Ledger',confidence:0.95,reason:'?'},
  {reference_no:'TXN-000003',ledger_name:'Bank Charges',confidence:0.8,amount:13},
  {reference_no:'TXN-000001',ledger_name:'Sales',confidence:0.9},
  {reference_no:'TXN-999999',ledger_name:'Sales',confidence:0.9}]));
 const codes=v.issues.map(i=>i.code).sort();
 assert.deepEqual(codes,['duplicate_reference','field_modified','missing_transactions','unknown_ledger','unknown_reference']);
 const x=v.valid.find(a=>a.ref==='TXN-000002');assert.equal(x.ledger,'Suspense A/c');assert(x.forced);
 assert(!v.valid.find(a=>a.ref==='TXN-000003'));assert.equal(v.summary.rejected,3);assert.equal(v.summary.missing,1);});
t('AI result: non-numeric confidence flagged, treated as 0; extra unknown fields ignored',()=>{const s=mk();
 const v=E.validateAiResult(s,ai(s,[{reference_no:'TXN-000001',ledger_name:'Bank Charges',confidence:'high',foo:'bar'}]),{});
 assert(v.issues.some(i=>i.code==='bad_confidence'));assert.equal(v.valid[0].confidence,0);});
t('accept respects lock; bulk accept applies only >= threshold, skips locked/forced/low, never touches others',()=>{const s=mk();
 E.assignLedger(s,['TXN-000003'],'Rent Expense','manual');                       // locked by user
 const v=E.validateAiResult(s,ai(s,[
  {reference_no:'TXN-000001',ledger_name:'Bank Charges',confidence:0.97,reason:'a'},
  {reference_no:'TXN-000002',ledger_name:'Sales',confidence:0.75,reason:'b'},
  {reference_no:'TXN-000003',ledger_name:'Bank Charges',confidence:0.99,reason:'c'},
  {reference_no:'TXN-000004',ledger_name:'Rent Expense',confidence:0.95,reason:'d'}]));
 E.stageAiSuggestions(s,v);
 const pv=E.previewAcceptAll(s,0.9);assert.deepEqual(pv,{apply:2,lockedSkipped:1,remainSuspenseOrReview:1});
 const r=E.acceptAllValid(s,0.9);assert.deepEqual(r,{applied:2,skippedLocked:1,skippedLow:1});
 assert.equal(s.entries[0].ledger_source,'imported_ai');assert.equal(s.entries[0].mapping_confidence,0.97);
 assert.equal(s.entries[1].ledger_name,'Suspense A/c');                            // 0.75 stays pending
 assert.equal(s.entries[2].ledger_name,'Rent Expense');                            // locked untouched
 assert.equal(E.acceptSuggestion(s,'TXN-000003').reason,'locked');
 assert.equal(E.acceptSuggestion(s,'TXN-000003',{force:true}).ok,true);assert.equal(s.entries[2].ledger_name,'Bank Charges');
 assert.equal(s.audit.filter(a=>a.source==='imported_ai').length,3);});
t('summaries and counts',()=>{const s=mk();E.assignLedger(s,['TXN-000001','TXN-000003'],'Bank Charges','bulk_manual');
 const c=E.counts(s);assert.deepEqual([c.total,c.suspense,c.mapped,c.locked],[4,2,2,2]);
 const m=E.mappingSummary(s).find(g=>g.ledger==='Bank Charges');assert.equal(m.count,2);assert.equal(m.debit,130);});
t('final validation: ok / unknown ledger when Tally-connected / failed balance warning / duplicate flags',()=>{const s=mk();
 assert(E.finalValidation(s,{status:'passed'}).ok);
 s.entries[0].ledger_name='Ghost';const f=E.finalValidation(s,{status:'failed',difference:500});
 assert(!f.ok);assert(/not in the connected Tally/.test(f.errors[0]));assert(/FAILED/.test(f.warnings[0]));
 s.entries[0].ledger_name='Sales';s.entries[1].flags=['possible_duplicate'];assert(E.finalValidation(s,null).warnings.some(w=>/duplicate/.test(w)));
 s.entries[2].amount=-5;assert(!E.finalValidation(s,null).ok);});
t('tally transactions carry counterLedger and keep statement direction',()=>{const s=mk();E.assignLedger(s,['TXN-000002'],'Sales','manual');
 const x=E.toTallyTransactions(s);assert.equal(x[1].counterLedger,'Sales');assert.equal(x[1].drCr,'C');assert.equal(x[0].counterLedger,'Suspense A/c');
 const xml=require('./tally-xml-builder.js').buildImportXML({transactions:x,bankLedgerName:'Kotak Bank',ledgersToCreate:[{name:'Suspense A/c',parent:'Suspense Account'}]});
 assert(/<VOUCHER [^>]*VCHTYPE="Receipt"/.test(xml));assert((xml.match(/<VOUCHER /g)||[]).length===4);assert(xml.includes('<LEDGERNAME>Sales</LEDGERNAME>'));});
console.log(n+' engine tests passed');
