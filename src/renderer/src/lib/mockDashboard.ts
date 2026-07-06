/**
 * Dashboard aggregation for the MockApi — mirrors the SQL-view semantics the
 * main process implements (plan §4): spend = net signed sum of non-excluded,
 * non-income categories; pending rows excluded from totals; refunds net into
 * the category they refund; payments-integrity per §5d.
 */
import type { AccountDto, CategoryDto, DashboardData, TransactionDto } from '../../../shared/types'
import { isYearMonth, lastNMonths } from './format'

const INTEGRITY_TOLERANCE_CENTS = 100

function isSpendCategory(cat: CategoryDto | undefined): boolean {
  return cat !== undefined && !cat.isIncome && !cat.excludedFromSpend
}

export function computeMockDashboard(
  month: string,
  transactions: readonly TransactionDto[],
  accounts: readonly AccountDto[],
  categories: readonly CategoryDto[],
): DashboardData {
  if (!isYearMonth(month)) throw new Error(`Not a YYYY-MM month: ${JSON.stringify(month)}`)
  const catById = new Map(categories.map((c) => [c.id, c]))
  const accountType = new Map(accounts.map((a) => [a.id, a.type]))
  const inMonth = transactions.filter((t) => t.txnDate.startsWith(month))
  const posted = inMonth.filter((t) => t.status === 'posted')

  const byCategoryMap = new Map<string, number>()
  for (const t of posted) {
    if (t.categoryId === null || !isSpendCategory(catById.get(t.categoryId))) continue
    byCategoryMap.set(t.categoryId, (byCategoryMap.get(t.categoryId) ?? 0) + t.amountCents)
  }
  const byCategory = [...byCategoryMap.entries()]
    .filter(([, net]) => net !== 0)
    .map(([categoryId, netCents]) => ({
      categoryId,
      categoryName: catById.get(categoryId)?.name ?? categoryId,
      netCents,
    }))
    .sort((a, b) => a.netCents - b.netCents)

  const trend = lastNMonths(month, 12).map((m) => {
    let spendNet = 0
    let incomeNet = 0
    for (const t of transactions) {
      if (t.status !== 'posted' || !t.txnDate.startsWith(m) || t.categoryId === null) continue
      const cat = catById.get(t.categoryId)
      if (cat?.isIncome) incomeNet += t.amountCents
      else if (isSpendCategory(cat)) spendNet += t.amountCents
    }
    return { month: m, spendCents: Math.max(0, -spendNet), incomeCents: Math.max(0, incomeNet) }
  })

  const merchantMap = new Map<string, { netCents: number; count: number }>()
  for (const t of posted) {
    if (t.categoryId === null || !isSpendCategory(catById.get(t.categoryId))) continue
    const entry = merchantMap.get(t.payee) ?? { netCents: 0, count: 0 }
    merchantMap.set(t.payee, { netCents: entry.netCents + t.amountCents, count: entry.count + 1 })
  }
  const topMerchants = [...merchantMap.entries()]
    .map(([payee, { netCents, count }]) => ({ payee, netCents, count }))
    .sort((a, b) => a.netCents - b.netCents)
    .slice(0, 5)

  const pendingCents = inMonth
    .filter((t) => t.status === 'pending')
    .reduce((sum, t) => sum + t.amountCents, 0)

  let checkingSideCents = 0
  let cardSideCents = 0
  for (const t of posted) {
    if (t.categoryId !== 'loan_payments') continue
    const type = accountType.get(t.accountId)
    if (type === 'depository' && t.amountCents < 0) checkingSideCents += -t.amountCents
    if (type === 'credit' && t.amountCents > 0) cardSideCents += t.amountCents
  }

  return {
    month,
    byCategory,
    trend,
    topMerchants,
    pendingCents,
    paymentsIntegrity: {
      checkingSideCents,
      cardSideCents,
      diverges: Math.abs(checkingSideCents - cardSideCents) > INTEGRITY_TOLERANCE_CENTS,
    },
  }
}
