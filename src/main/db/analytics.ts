import type { DashboardData } from '../../shared/types'
import { TAXONOMY } from '../core/categorize/taxonomy'
import type { Db } from './db'

/** dashboard math over the SQL views (plan §7) */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const TREND_MONTHS = 12
const TOP_MERCHANTS_LIMIT = 8
/** §5d: divergence tolerance = max(100 cents, 10% of the larger side) */
const INTEGRITY_ABS_TOLERANCE_CENTS = 100
const INTEGRITY_REL_TOLERANCE = 0.1

function loanPaymentsCategoryId(): string {
  const entry = TAXONOMY.find((t) => t.pfcCode === 'LOAN_PAYMENTS')
  if (!entry) throw new Error('taxonomy is missing LOAN_PAYMENTS')
  return entry.id
}

/** the `count` months ending at `end` ('YYYY-MM'), ascending — pure string math */
function trailingMonths(end: string, count: number): string[] {
  const labels: string[] = []
  let year = Number(end.slice(0, 4))
  let month = Number(end.slice(5, 7))
  for (let i = 0; i < count; i++) {
    labels.push(`${year}-${String(month).padStart(2, '0')}`)
    month -= 1
    if (month === 0) {
      month = 12
      year -= 1
    }
  }
  return labels.reverse()
}

export function getDashboard(db: Db, month: string): DashboardData {
  if (!MONTH_RE.test(month)) {
    throw new Error(`getDashboard: month must be 'YYYY-MM', got ${JSON.stringify(month)}`)
  }

  // NULL-category rows bucket into the taxonomy's 'uncategorized' row so
  // spend stays visible even when categorization is behind (Ollama offline).
  const byCategory = (
    db
      .prepare(
        `SELECT COALESCE(v.category_id, 'uncategorized') AS categoryId,
                c.name AS categoryName,
                SUM(v.net_cents) AS netCents
         FROM v_monthly_category v
         LEFT JOIN categories c ON c.id = COALESCE(v.category_id, 'uncategorized')
         WHERE v.month = ?
           AND COALESCE(c.excluded_from_spend, 0) = 0 AND COALESCE(c.is_income, 0) = 0
         GROUP BY COALESCE(v.category_id, 'uncategorized')
         ORDER BY SUM(v.net_cents) ASC, c.name ASC`,
      )
      .all(month) as Array<{ categoryId: string; categoryName: string; netCents: number }>
  ).map((r) => ({ ...r }))

  const months = trailingMonths(month, TREND_MONTHS)
  const first = months[0]
  if (first === undefined) throw new Error('getDashboard: empty trend window')
  const totalsRows = db
    .prepare(
      `SELECT month, spend_cents AS spendCents, income_cents AS incomeCents
       FROM v_monthly_totals WHERE month BETWEEN ? AND ?`,
    )
    .all(first, month) as Array<{ month: string; spendCents: number; incomeCents: number }>
  const totalsByMonth = new Map(totalsRows.map((r) => [r.month, r]))
  const trend = months.map((m) => {
    const hit = totalsByMonth.get(m)
    return { month: m, spendCents: hit?.spendCents ?? 0, incomeCents: hit?.incomeCents ?? 0 }
  })

  const topMerchants = (
    db
      .prepare(
        `SELECT payee, net_cents AS netCents, txn_count AS count
         FROM v_merchant_monthly WHERE month = ?
         ORDER BY ABS(net_cents) DESC, payee ASC LIMIT ?`,
      )
      .all(month, TOP_MERCHANTS_LIMIT) as Array<{ payee: string; netCents: number; count: number }>
  ).map((r) => ({ ...r }))

  const pendingRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS n FROM transactions
       WHERE status = 'pending' AND tombstone = 0 AND strftime('%Y-%m', txn_date) = ?`,
    )
    .get(month) as { n: number }

  return {
    month,
    byCategory,
    trend,
    topMerchants,
    pendingCents: pendingRow.n,
    paymentsIntegrity: paymentsIntegrity(db, month),
  }
}

function paymentsIntegrity(db: Db, month: string): DashboardData['paymentsIntegrity'] {
  const loanPayments = loanPaymentsCategoryId()
  const checkingRow = db
    .prepare(
      `SELECT COALESCE(SUM(t.amount_cents), 0) AS n
       FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE strftime('%Y-%m', t.txn_date) = ? AND t.tombstone = 0 AND t.status = 'posted'
         AND t.category_id = ? AND a.type = 'depository'`,
    )
    .get(month, loanPayments) as { n: number }
  const cardRow = db
    .prepare(
      `SELECT COALESCE(SUM(t.amount_cents), 0) AS n
       FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE strftime('%Y-%m', t.txn_date) = ? AND t.tombstone = 0 AND t.status = 'posted'
         AND t.category_id = ? AND a.type = 'credit' AND t.amount_cents > 0`,
    )
    .get(month, loanPayments) as { n: number }

  const checkingSideCents = Math.abs(checkingRow.n)
  const cardSideCents = cardRow.n
  const tolerance = Math.max(
    INTEGRITY_ABS_TOLERANCE_CENTS,
    INTEGRITY_REL_TOLERANCE * Math.max(checkingSideCents, cardSideCents),
  )
  return {
    checkingSideCents,
    cardSideCents,
    diverges: Math.abs(checkingSideCents - cardSideCents) > tolerance,
  }
}
