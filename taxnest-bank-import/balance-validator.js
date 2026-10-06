/* =========================================================
   balance-validator.js
   Accounting checks for parsed bank statements. Plain <script> include
   (window.BalanceValidator) or Node module. No dependencies.

   Input: transactions as returned by any parser --
     { date:'YYYYMMDD', amount, drCr:'D'|'C', balance?, ... }
   in DOCUMENT order (the validator works out chronological order itself).
   `balance` is the statement's own running balance after that row
   (negative = overdrawn).

   WHAT EACH CHECK ACTUALLY PROVES (so the UI never overclaims):
   1. Row check  |balance - previousBalance| == amount
        Direction-independent. Catches a dropped row, a misread amount,
        a line merged into the wrong row.
   2. Direction check  previousBalance -/+ amount == balance
        Only meaningful when the parser read an explicit Dr/Cr marker.
        The generic parser infers direction FROM the balance change, so
        for its rows this check can't fail -- results carry
        `direction_independent:false` in that case and the UI should say so.
   3. Totals check  Opening - Debits + Credits == Closing
        Only "passed" when opening AND closing came from outside the row
        chain (printed on the statement or typed by the user). If the
        opening is derived from the first row, it is labelled as such and
        the overall status tops out at 'chain_ok'.

   status values:
     'passed'         totals + every row verified against independent opening/closing
     'chain_ok'       every row consistent, but opening/closing not independently supplied
     'failed'         at least one row or the totals do not reconcile
     'not_available'  no running balances and no opening/closing to check against
   ========================================================= */
(function (root) {
  'use strict';

  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  // Majority vote over adjacent rows, so one stray out-of-order row can't flip the answer.
  function isAscending(txns) {
    var up = 0, down = 0;
    for (var i = 1; i < txns.length; i++) {
      if (txns[i].date > txns[i - 1].date) up++; else if (txns[i].date < txns[i - 1].date) down++;
    }
    return up >= down; // ties / all-same-date -> assume as printed
  }

  /* opts: { opening?:number, closing?:number, tolerance?:number (default 0.01),
             directionFromMarker?:boolean (true when drCr came from an explicit Dr/Cr marker) } */
  function validateStatement(transactions, opts) {
    opts = opts || {};
    var tol = typeof opts.tolerance === 'number' ? opts.tolerance : 0.01;
    var asc = isAscending(transactions);
    var chrono = asc ? transactions : transactions.slice().reverse();

    var totalDebit = 0, totalCredit = 0;
    chrono.forEach(function (t) {
      if (t.drCr === 'D') totalDebit += t.amount; else totalCredit += t.amount;
    });
    totalDebit = round2(totalDebit); totalCredit = round2(totalCredit);

    var withBalance = chrono.filter(function (t) { return typeof t.balance === 'number' && isFinite(t.balance); });
    var hasBalances = withBalance.length === chrono.length && chrono.length > 0;

    var openingSupplied = typeof opts.opening === 'number' && isFinite(opts.opening);
    var closingSupplied = typeof opts.closing === 'number' && isFinite(opts.closing);

    var rows = [], failures = [], notes = [];
    var opening = null, openingSource = 'none';

    if (openingSupplied) { opening = opts.opening; openingSource = 'statement'; }
    else if (hasBalances) {
      var f = chrono[0];
      opening = round2(f.balance + (f.drCr === 'D' ? f.amount : -f.amount));
      openingSource = 'derived';
    }

    if (hasBalances && opening !== null) {
      var prev = opening;
      chrono.forEach(function (t, i) {
        var delta = round2(t.balance - prev);
        var amountOk = Math.abs(Math.abs(delta) - t.amount) <= tol;
        var expected = round2(prev + (t.drCr === 'C' ? t.amount : -t.amount));
        var dirOk = Math.abs(expected - t.balance) <= tol;
        var status = dirOk ? 'passed' : 'failed';
        rows.push({ index: i, ref: t.reference_no, date: t.date, expected_balance: expected, statement_balance: t.balance,
          difference: round2(expected - t.balance), status: status, amount_matches_balance_change: amountOk });
        if (!dirOk) {
          failures.push({
            index: i, ref: t.reference_no, date: t.date, amount: t.amount,
            kind: amountOk ? 'direction_wrong' : 'amount_or_row_missing',
            balance_change_seen: delta,
            message: amountOk
              ? 'Amount matches the balance change but Debit/Credit looks reversed.'
              : (Math.abs(delta) <= tol ? 'Balance did not change but this row shows ' + t.amount + ' — possible duplicate row or a non-transaction line.' : 'Balance moved by ' + Math.abs(delta) + ' but this row is ' + t.amount +
                (Math.abs(delta) > t.amount ? ' -- a transaction of about ' + round2(Math.abs(delta) - t.amount) + ' may be missing before this row.' : ' -- amount may be misread.'))
          });
        }
        prev = t.balance; // re-anchor on the statement's balance so one bad row doesn't cascade
      });
    } else if (!hasBalances) {
      notes.push('Statement rows carry no running balance; row-by-row check not available.');
    }

    var calculatedClosing = opening === null ? null : round2(opening - totalDebit + totalCredit);
    var statementClosing = closingSupplied ? opts.closing : (hasBalances ? chrono[chrono.length - 1].balance : null);
    var closingSource = closingSupplied ? 'statement' : (hasBalances ? 'derived' : 'none');
    var difference = (calculatedClosing !== null && statementClosing !== null) ? round2(calculatedClosing - statementClosing) : null;
    var totalsOk = difference !== null && Math.abs(difference) <= tol;

    var status;
    if (difference === null && !rows.length) status = 'not_available';
    else if (failures.length || (difference !== null && !totalsOk)) status = 'failed';
    else if (openingSource === 'statement' && closingSource === 'statement' && hasBalances) status = 'passed';
    else if (openingSource === 'statement' && closingSource === 'statement') status = 'passed'; // totals only, no balance column
    else status = 'chain_ok';

    if (openingSource === 'derived') notes.push('Opening balance was derived from the first row, not read from the statement.');
    if (closingSource === 'derived') notes.push('Closing balance is the last row\'s balance, not read separately from the statement.');
    if (!opts.directionFromMarker) notes.push('Debit/Credit direction was inferred from balance changes, so direction errors cannot be detected by this check.');

    return {
      status: status,
      tolerance: tol,
      order: asc ? 'ascending' : 'descending (validated oldest-first)',
      opening_balance: opening, opening_source: openingSource,
      total_debit: totalDebit, total_credit: totalCredit,
      calculated_closing_balance: calculatedClosing,
      statement_closing_balance: statementClosing, closing_source: closingSource,
      difference: difference,
      direction_independent: !!opts.directionFromMarker,
      rows: rows, failures: failures, notes: notes,
      transaction_count: transactions.length
    };
  }

  /* Stable internal references in DOCUMENT order: TXN-000001... Assigned once,
     right after parsing, before any filtering or mapping. */
  function assignReferences(transactions, suspenseLedger) {
    var s = suspenseLedger || 'Suspense A/c';
    return transactions.map(function (t, i) {
      var o = {}; for (var k in t) o[k] = t[k];
      o.reference_no = 'TXN-' + String(i + 1).padStart(6, '0');
      o.ledger_name = s; o.ledger_source = 'default'; o.mapping_locked = false;
      return o;
    });
  }

  /* Flag only, never delete: identical date+narration+amount+direction+balance. */
  function findPossibleDuplicates(transactions) {
    var seen = {}, dups = [];
    transactions.forEach(function (t, i) {
      var key = [t.date, t.narration, t.amount, t.drCr, t.balance].join('|');
      if (seen[key] !== undefined) dups.push({ index: i, duplicate_of: seen[key] });
      else seen[key] = i;
    });
    return dups;
  }

  var BalanceValidator = { validateStatement: validateStatement, assignReferences: assignReferences, findPossibleDuplicates: findPossibleDuplicates };
  if (typeof module !== 'undefined' && module.exports) module.exports = BalanceValidator;
  else root.BalanceValidator = BalanceValidator;
})(typeof window !== 'undefined' ? window : this);
