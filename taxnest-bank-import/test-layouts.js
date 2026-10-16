// Layouts of Indian bank statements (fake data), reproduced from the statement formats banks actually print.
// Each fixture is what the universal parser receives: text lines, with (Dr)/(Cr) hints where the column header allowed them.
const assert=require('assert');const U=require('./universal-parser.js');const V=require('./balance-validator.js');
let n=0;
function run(name,text,exp){
  const r=U.extractUniversal(text);const T=r.transactions;
  const D=Math.round(T.reduce((s,x)=>s+(x.drCr==='D'?x.amount:0),0)*100)/100,C=Math.round(T.reduce((s,x)=>s+(x.drCr==='C'?x.amount:0),0)*100)/100;
  const v=V.validateStatement(T,{opening:r.statement.opening_balance,closing:r.statement.closing_balance});
  assert.equal(T.length,exp.rows,name+': rows '+T.length+' '+JSON.stringify(r.skipped.map(s=>s.reason)));
  assert.equal(D,exp.debit,name+': debit '+D);assert.equal(C,exp.credit,name+': credit '+C);
  assert.equal(r.repair.reconstructed,0,name+': nothing should need rebuilding');
  assert.equal(v.status===(exp.status||'chain_ok')||v.status==='passed',true,name+': status '+v.status+' '+JSON.stringify(v.failures.slice(0,1)));
  if(exp.opening!==undefined){const o=r.statement.opening_balance!==null?r.statement.opening_balance:r.statement.derived_opening_balance;assert.equal(o,exp.opening,name+': opening '+o);}
  if(exp.first)assert.match(T[0].narration,exp.first,name+': narration '+T[0].narration);
  n++;console.log('ok -',name,'('+T.length+' rows, '+v.status+')');
}
run('Indian Bank (dd/mm/yyyy, "-" cells, CR suffix, newest first)',`STATEMENT OF ACCOUNT
Statement Period : From 30/09/2022 To 01/01/2023
TRANSACTION DATE PARTICULARS WITHDRAWALS DEPOSIT BALANCE
04/01/2023 UPI TRANSFER/300135738998/K11woyj 1000.00(Dr) - 23004.85 CR
02/01/2023 UPI TRANSFER/300133582429/KSU63634182 200.00(Dr) - 24004.85 CR
01/01/2023 *NEFT/CR/336733038273/Payment from Vishal fertilizer/SBIN00 - 24000.00(Cr) 24204.85 CR
01/01/2023 UPI TRANSFER/300172753759/Pay to BharatPe Merc 15.00(Dr) - 204.85 CR`,{rows:4,debit:1215,credit:24000,opening:219.85});
run('Bank of Baroda (serial no + two dates + Opening Balance row)',`Account Statement from 01-05-2024 to 31-05-2024
Serial No Transaction Date Value Date Description Cheque Number Debit Credit Balance
1 01-05-2024 01-05-2024 Opening Balance - - 736,280.00
2 01-05-2024 01-05-2024 UPI/201921164575/20:37:38/UPI/bharatpe.905000575 - 138.00(Cr) 736,418.00
3 01-05-2024 01-05-2024 UPI/130515257828/15:09:48/UPI/adilshaikh8735@okh - 76,000.00(Cr) 812,418.00
4 02-05-2024 02-05-2024 UPI/130658724392/11:17:45/UPI/7046825565@ybl/Pa 20,000.00(Dr) - 792,418.00`,{rows:3,debit:20000,credit:76138,opening:736280,first:/bharatpe/});
run('IndusInd (dd-Mon-yyyy, alphanumeric ref column, overdrawn start)',`Date Particulars Chq./Ref.No. Withdrawl Deposit Balance
11-Jun-2025 N/N/163243089768290/HDFC000 7017/PUSTIKAR SAKH SAHAK S55843295 122,831.67(Cr) 119,376.22
12-Jun-2025 N/N/164243091923805/HDFC000 7017/PUSTIKAR SAKH SAHAK S66801172 102,932.00(Cr) 222,308.22
19-Jun-2025 UPI/417134790678/DR/Phon/YE SB/BBPSBP@ybl/Payment f S3539096 939.00(Dr) 221,369.22`,{rows:3,debit:939,credit:225763.67,opening:-3455.45});
run('Federal Bank (two dates, Tran ID, trailing CR, opening printed with one decimal)',`Opening Balance : 3.6
Statement of Account for the period 01-Feb-2025 to 02-Apr-2025
Date Value Date Particulars Tran Type Tran ID Cheque Details Withdrawals Deposits Balance Dr/Cr
02/02/2025 02/02/2025 FT IMPS/IFI/503318474184/LENDENCLUB LENDER FU/Loan TFR S43304231 8092.60(Cr) 8096.20 CR
03/02/2025 03/02/2025 UPIOUT/503460634964/cred.club@axisb/payment /7322 TFR S56754916 2079.00(Dr) 6017.20 CR
04/02/2025 04/02/2025 UPIOUT/540188946026/fatakpaydigital929958.rz/6012 TFR S65753893 1787.33(Dr) 4229.87 CR`,{rows:3,debit:3866.33,credit:8092.6,opening:3.6});
run('Central Bank of India (NO paise: 4,67,000; Brought Fwd. 20,00,000 Cr)',`Statement from 01/08/2016 to 31/12/2017
Date Details Chq. No. Debit Credit Balance
Brought Fwd. 20,00,000 Cr
09/09/2016 TechMech Pvt. Ltd. 123456 - 4,67,000(Cr) 24,67,000
09/10/2016 TechMech Pvt Ltd 458211 - 4,67,000(Cr) 29,34,000
05/01/2017 Zech Solutions 222555 - 1,32,000(Cr) 30,66,000
16/01/2017 TechMech Pvt. Ltd 221144 1,00,000(Dr) - 29,66,000`,{rows:4,debit:100000,credit:1066000,opening:2000000,first:/TechMech/});
run('IDFC First (two dates, summary table: Opening / Total Debit / Total Credit / Closing)',`STATEMENT OF ACCOUNT
Opening Balance Total Debit Total Credit Closing Balance
21.62 1,977.50 2,001.00 45.12
Transaction Date Value Date Particulars Cheque No. Debit Credit Balance
01-Apr-2018 01-Apr-2018 IMPS-MOB/Fund Trf/809119519742/Oma Ram/BENE - VER 1.00(Cr) 22.62
01-Apr-2018 01-Apr-2018 IMPS-MOB/Fund Trf/809119553510/Oma Ram/2000 2,000.00(Cr) 2,022.62
03-Apr-2018 03-Apr-2018 NACH/TP ACH Bajaj Finanac/88551679 1,912.00(Dr) 110.62
04-Apr-2018 04-Apr-2018 POS-VISA/KARUN MEDICAL/809414290216 65.50(Dr) 45.12`,{rows:4,debit:1977.5,credit:2001,opening:21.62,status:'passed'});
run('Axis Bank (opening ".00", Init. Br column after the balance)',`Tran Date Chq No Particulars Debit Credit Balance Init. Br
OPENING BALANCE .00
29-01-2020 BRN-OTHERS-Other 380.00(Cr) 380.00 002
30-01-2020 ATM-CASH/NITIN S NERS NH79/BHILWARA/300120 200.00(Dr) 180.00 241
02-02-2020 ATM-CASH/SHREE DEV EMITRA &/LBhilwara/020220 150.00(Dr) 30.00 241
07-02-2020 BRN-SALARY PAYMENT-Salary 8514.00(Cr) 8544.00 101`,{rows:4,debit:350,credit:8894,opening:0});
run('South Indian Bank (dd-mm-yy, Cr glued to balance, Page Total line)',`STATEMENT OF ACCOUNT FOR THE PERIOD FROM 03-04-2023 TO 03-04-2024
DATE PARTICULARS CHQ.NO. WITHDRAWALS DEPOSITS BALANCE
03-04-23 UPI/INDB/RRN-309325964812/HAJA MOHINUDEEN/UPI 4,900.00(Cr) 11,348.45Cr
03-04-23 UPI/IBKL/RRN-309333675610/HAJA MOHINUDEEN S A/Payment 28,600.00(Cr) 39,948.45Cr
03-04-23 UPI/CNRB/RRN-309333458987/SHADIK ALI/UPI 35,000.00(Dr) 4,948.45Cr
Page Total : 35,000.00 33,500.00 4,948.45Cr
Page 1 of 58`,{rows:3,debit:35000,credit:33500,opening:6448.45});
run('Karur Vysya (two dates, branch code, ref no, overdrawn balance, B/F...)',`Opening Balance Total Credit Amount Total Debit Amount Closing Balance
597.42 + 16,425.00 - 16,599.00 = 423.42
Txn Date Value Date Brn Code Particulars Ref. No Debit Credit Balance
01/06/2019 01/06/2019 B/F... 597.42
02/06/2019 02/06/2019 1440 Cash Deposit at CDM-S1ECD144001 13,000.00(Cr) 13,597.42
03/06/2019 03/06/2019 2103 ECS BAJAJ 03062019 000000 4,304.00(Dr) 9,293.42
03/06/2019 03/06/2019 2103 ECSBFL:21222409190162:442GIS87764151 000000 8,870.00(Dr) 423.42
03/06/2019 03/06/2019 1440 ECSBFL:21222908180185:4420CD84967549 000000 3,425.00(Dr) -3,001.58
03/06/2019 03/06/2019 1440 ECSBFL:21222908180185:4420CD84967549 000000 3,425.00(Cr) 423.42`,{rows:5,debit:16599,credit:16425,opening:597.42});
run('SBI (value date in brackets on the next line, negative Indian-grouped balances, newest first)',`Account Statement for the period 2/9/2022 to 2/3/2023
Date (Value Date) Narration Ref/Cheque No. Debit Credit Balance
01-Mar-23 O.S. DEPOSIT TRAN 20,340.00(Cr) -9,44,949.50
(01-Mar-2023) TRANSFER FROM TRANSFER FR
OM 30297061482 Mrs. NIRMAL A BANDI
28-Feb-23 INTEREST 8,414.00(Dr) -9,65,289.50
(28-Feb-2023)
20-Feb-23 DEPOSIT TRANSFER 20,340.00(Cr) -9,56,875.50
(20-Feb-2023)`,{rows:3,debit:8414,credit:40680,opening:-977215.5,first:/O\.S\. DEPOSIT TRAN TRANSFER FROM/});
run('UCO Bank (date wrapped: "01-12-" then "2024")',`Statement of Account from 01-12-2024 to 31-03-2023
Date Particulars Chq. No. Withdrawals Deposits Balance
01-12- MPAY/IMPSI/TRTR/209203802941/Flipkart Int/XX010602 199.00(Cr) 457.21
2024
02-12- MPAY/UPI/TRTR/209243310706/IOBA/9564817471@axl/Pa 200.00(Dr) 257.21
2024
02-12- MPAY/UPI/TRTR/209268129649/SBIN/8343095480@ybl/Pa 200.00(Dr) 57.21
2024
03-12- MPAY/UPI/TRTR/209346728694/UTIB/sasmalsaikat3@i/P 3,000.00(Cr) 3,057.21
2024`,{rows:4,debit:400,credit:3199,opening:258.21});
run('ICICI (old layout: B/F row, narration wraps before the amounts)',`Statement of Transactions in Savings Account Number: 000201658354 in INR for the period December 21, 2018 - June 23, 2019
DATE MODE** PARTICULARS DEPOSITS WITHDRAWALS BALANCE
21-12-2018 B/F 23,177.79
21-12-2018 UPI/835506074111/Gift/venkat6333@okic/ICICI Bank 1,100.00(Cr) 24,277.79
21-12-2018 UPI/835509113276/TV
fare/ramesh6191@okhd/CHATISGARH R G 5,000.00(Cr) 29,277.79
24-12-2018 MOBILE BANKING MMT/IMPS/835711427777/Saala/Hariprasad/SBIN0 10,000.00(Dr) 19,277.79`,{rows:3,debit:10000,credit:6100,opening:23177.79,first:/Gift/});
console.log(n+' layout tests passed');
