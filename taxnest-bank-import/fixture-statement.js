/* Synthetic bank statement text in the Kotak "serial-number" layout (fake names, fake numbers, seeded random).
   Lets every test run without any real client statement. build(n, seed) -> { text, rows, opening, closing } */
'use strict';
function indian(n) { var s = n.toFixed(2), p = s.split('.'), i = p[0], last3 = i.slice(-3), rest = i.slice(0, -3); return (rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : '') + last3 + '.' + p[1]; }
function build(n, seed) {
  var x = seed || 7; function rnd() { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; }
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var credit = [
    ['NEFT AXNGG{N11} GOOGLE INDIA', 'DIGITAL SERVIC', 'NEFTINW-{N10}', 400, 9000, 0.34],
    ['Recd:IMPS/{N12}/GOOGLEINDI/KKBK', '/X2063/IMPS', 'IMPS-{N12}', 300, 8000, 0.10],
    ['MB:RECEIVED FROM TEST CUSTOMER', 'WHEELS/ROHINI', 'MB-{N12}', 3000, 90000, 0.06],
    ['NEFT 002342675381 INWARD RTGS', 'UBIN0558184', 'NEFTINW-{N10}', 1000, 30000, 0.05],
    ['UPI/SAMPLE PAYER/{N12}/Payment from Ph', '', 'UPI-{N12}', 2000, 60000, 0.05]];
  var debit = [
    ['SentIMPS{N12}SAMPLECO', '7/IBKLX0075/RS75', 'IMPS-{N12}', 500, 20000, 0.20],
    ['UPI/ASHOK STAFF/{N12}/ASHOK SALARY', '', 'UPI-{N12}', 5000, 15000, 0.04],
    ['Chrg: ECS Return on 20251207', '', '', 590, 590, 0.03],
    ['NACH-10-DR-SAMPLEFINANCE-', '1007324510', 'NACHDB{N10}', 3000, 60000, 0.02],
    ['CASH WITHDRAWAL BY SELF AT BRANCH', '0839', '1368', 10000, 70000, 0.02],
    ['PAID TO TEST LOGISTIC', 'LTD', 'MB-{N12}', 800, 12000, 0.04],
    ['MB:SENT TO TEST VENDOR', '', 'MB-{N12}', 500, 25000, 0.05]];
  function num(k) { var s = ''; for (var i = 0; i < k; i++) s += Math.floor(rnd() * 10); return s; }
  function fill(t) { return t.replace('{N10}', num(10)).replace('{N11}', num(11)).replace('{N12}', num(12)); }
  function pick(list) { var r = rnd(), acc = 0; for (var i = 0; i < list.length; i++) { acc += list[i][5]; if (r < acc) return list[i]; } return list[list.length - 1]; }
  var balance = 38.02, opening = balance, rows = [], day = 0;
  var lines = ['Account Statement', '01 Oct 2025 - 28 Feb 2026', 'TEST TRADERS', 'Account No. 9999999999 Account Type Current', 'Current Account Transactions', '# Date Description Chq/Ref. No. Withdrawal (Dr.) Deposit (Cr.) Balance', '- - Opening Balance - - - ' + indian(opening)];
  var pages = Math.ceil(n / 20);
  for (var i = 1; i <= n; i++) {
    if ((i - 1) % 3 === 0) day++;
    var isCredit = rnd() < 0.5, def;
    if (!isCredit) { def = pick(debit); if (balance < def[3]) { isCredit = true; } }
    if (isCredit) def = pick(credit);
    var amt = isCredit ? Math.round((def[3] + rnd() * (def[4] - def[3])) * 100) / 100 : Math.min(Math.round((def[3] + rnd() * (def[4] - def[3])) * 100) / 100, Math.floor(balance * 100) / 100);
    if (!isCredit && (def[3] === def[4])) amt = def[3];
    if (amt <= 0) { isCredit = true; def = pick(credit); amt = def[3]; }
    balance = Math.round((balance + (isCredit ? amt : -amt)) * 100) / 100;
    var d = new Date(Date.UTC(2025, 9, 1 + day)), ds = String(d.getUTCDate()).padStart(2, '0') + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
    var l1 = fill(def[0]), l2 = fill(def[1]), ref = fill(def[2]);
    lines.push(i + ' ' + ds + ' ' + l1 + (ref ? ' ' + ref : '') + ' ' + indian(amt) + ' ' + indian(balance));
    if (l2) lines.push(l2);
    rows.push({ serial: i, amount: amt, drCr: isCredit ? 'C' : 'D', balance: balance });
    if (i % 20 === 0 && i < n) {
      var pg = i / 20;
      lines.push('Statement Generated on 02 Mar 2026, 15:22 Page ' + pg + ' of ' + (pages + 2));
      lines.push('TEST TRADERS', 'Account No. 9999999999', 'Account Statement 01 Oct 2025 - 28 Feb 2026', 'Current Account Transactions', '# Date Description Chq/Ref. No. Withdrawal (Dr.) Deposit (Cr.) Balance');
    }
  }
  lines.push('Statement Generated on 02 Mar 2026, 15:22 Page ' + pages + ' of ' + (pages + 2));
  lines.push('TEST TRADERS', 'Account No. 9999999999', 'Account Statement 01 Oct 2025 - 28 Feb 2026', 'Account Summary', 'Particulars Opening Balance Closing Balance', 'Current Account (CA): ' + indian(opening) + ' ' + indian(balance), 'End of Statement');
  lines.push('accepted until July 20, 2025, as per the existing process. Salary account holders may view their insurance covers 24.01 ok');
  return { text: lines.join('\n'), rows: rows, opening: opening, closing: balance };
}
module.exports = { build: build };
