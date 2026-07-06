import { beforeEach, describe, expect, it } from 'vitest'
import type { Api } from '../../../shared/ipcContract'
import type { TransactionDto } from '../../../shared/types'
import { addMonths, currentMonth } from './format'
import { createMockApi } from './mockApi'

const M0 = currentMonth()
const M1 = addMonths(M0, -1)
const M2 = addMonths(M0, -2)

let api: Api

beforeEach(() => {
  api = createMockApi()
})

async function txnsByText(text: string): Promise<TransactionDto[]> {
  const { rows } = await api.listTransactions({ text })
  return rows
}

describe('seed data shape', () => {
  it('has 2 accounts: a Chase checking (teller) and an Amex credit needing reconnect', async () => {
    const accounts = await api.listAccounts()
    expect(accounts).toHaveLength(2)
    const checking = accounts.find((a) => a.id === 'acct-checking')!
    expect(checking.institution).toBe('chase')
    expect(checking.type).toBe('depository')
    expect(checking.sourceKind).toBe('teller')
    expect(checking.status).toBe('ok')
    const amex = accounts.find((a) => a.id === 'acct-amex')!
    expect(amex.institution).toBe('amex')
    expect(amex.type).toBe('credit')
    expect(amex.status).toBe('reconnect_required')
  })

  it('has ~30 transactions spread across exactly 3 months', async () => {
    const { rows, total } = await api.listTransactions({})
    expect(total).toBeGreaterThanOrEqual(30)
    expect(total).toBeLessThanOrEqual(40)
    expect(rows).toHaveLength(total)
    const months = new Set(rows.map((r) => r.txnDate.slice(0, 7)))
    expect([...months].sort()).toEqual([M2, M1, M0].sort())
  })

  it('mirrors the main-process taxonomy (18 categories incl. groceries + uncategorized)', async () => {
    const cats = await api.listCategories()
    expect(cats).toHaveLength(18)
    const ids = cats.map((c) => c.id)
    expect(ids).toContain('groceries')
    expect(ids).toContain('uncategorized')
    const excluded = cats.filter((c) => c.excludedFromSpend).map((c) => c.id)
    expect(excluded.sort()).toEqual(['loan_payments', 'transfer_in', 'transfer_out'])
    expect(cats.find((c) => c.id === 'income')!.isIncome).toBe(true)
  })

  it('returns defensive copies — callers cannot corrupt internal state', async () => {
    const a1 = await api.listAccounts()
    a1[0]!.name = 'HACKED'
    const a2 = await api.listAccounts()
    expect(a2[0]!.name).not.toBe('HACKED')

    const t1 = await api.listTransactions({})
    t1.rows[0]!.payee = 'HACKED'
    const t2 = await api.listTransactions({})
    expect(t2.rows[0]!.payee).not.toBe('HACKED')
  })
})

describe('listTransactions', () => {
  it('sorts by txnDate descending', async () => {
    const { rows } = await api.listTransactions({})
    const dates = rows.map((r) => r.txnDate)
    const sorted = [...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    expect(dates).toEqual(sorted)
  })

  it('filters by accountId', async () => {
    const { rows } = await api.listTransactions({ accountId: 'acct-checking' })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.accountId === 'acct-checking')).toBe(true)
  })

  it('filters by categoryId', async () => {
    const { rows, total } = await api.listTransactions({ categoryId: 'groceries' })
    expect(total).toBe(6) // 2 grocery merchants x 3 months
    expect(rows.every((r) => r.categoryId === 'groceries')).toBe(true)
  })

  it('filters by text, case-insensitively, against payee and raw description', async () => {
    expect(await txnsByText('netflix')).toHaveLength(3)
    expect(await txnsByText('NETFLIX')).toHaveLength(3)
    expect(await txnsByText('nEtFlIx.CoM')).toHaveLength(3) // raw description hit
    expect(await txnsByText('zzz-no-such-merchant')).toHaveLength(0)
  })

  it('filters by status: exactly the 2 current-month pendings', async () => {
    const { rows } = await api.listTransactions({ status: 'pending' })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === 'pending' && r.txnDate.startsWith(M0))).toBe(true)
  })

  it('filters by date range with plain string comparison', async () => {
    const { rows } = await api.listTransactions({ from: `${M0}-01` })
    expect(rows.every((r) => r.txnDate >= `${M0}-01`)).toBe(true)
    expect(rows).toHaveLength(11)
    const older = await api.listTransactions({ from: `${M2}-01`, to: `${M2}-28` })
    expect(older.rows).toHaveLength(12) // oldest month has the extra autopay row
  })

  it('paginates with limit/offset while total reports the filtered count', async () => {
    const all = await api.listTransactions({})
    const page = await api.listTransactions({ limit: 10 })
    expect(page.rows).toHaveLength(10)
    expect(page.total).toBe(all.total)
    const tail = await api.listTransactions({ offset: all.total - 3, limit: 10 })
    expect(tail.rows).toHaveLength(3)
  })
})

describe('getDashboard', () => {
  it('rejects malformed months', async () => {
    await expect(api.getDashboard('garbage')).rejects.toThrow()
    await expect(api.getDashboard('2026-7')).rejects.toThrow()
  })

  it('excludes income, transfers and loan payments from byCategory', async () => {
    const d = await api.getDashboard(M0)
    const ids = d.byCategory.map((c) => c.categoryId)
    expect(ids).not.toContain('income')
    expect(ids).not.toContain('loan_payments')
    expect(ids).not.toContain('transfer_out')
  })

  it('computes net spend per category from posted rows only', async () => {
    const d = await api.getDashboard(M0)
    const groceries = d.byCategory.find((c) => c.categoryId === 'groceries')!
    expect(groceries.netCents).toBe(-14133) // 8710 + 5423
    // uber + doordash are pending in M0 → transportation absent, food is coffee only
    expect(d.byCategory.find((c) => c.categoryId === 'transportation')).toBeUndefined()
    expect(d.byCategory.find((c) => c.categoryId === 'food_and_drink')!.netCents).toBe(-675)
  })

  it('nets refunds into their category (M1 Amazon return)', async () => {
    const d = await api.getDashboard(M1)
    const merch = d.byCategory.find((c) => c.categoryId === 'general_merchandise')!
    expect(merch.netCents).toBe(-3300) // -4599 + 1299
  })

  it('reports pending total for the requested month', async () => {
    const d = await api.getDashboard(M0)
    expect(d.pendingCents).toBe(-4679) // doordash -2845 + uber -1834
    const prev = await api.getDashboard(M1)
    expect(prev.pendingCents).toBe(0)
  })

  it('returns a 12-month trend ending at the requested month', async () => {
    const d = await api.getDashboard(M0)
    expect(d.trend).toHaveLength(12)
    expect(d.trend[11]!.month).toBe(M0)
    expect(d.trend[0]!.month).toBe(addMonths(M0, -11))
    const m1 = d.trend.find((t) => t.month === M1)!
    expect(m1.spendCents).toBe(189386)
    expect(m1.incomeCents).toBe(250000)
    // months with no data are present as zeros, not missing
    expect(d.trend[0]!.spendCents).toBe(0)
  })

  it('ranks top merchants by net spend, spend categories only', async () => {
    const d = await api.getDashboard(M0)
    expect(d.topMerchants.length).toBeGreaterThan(0)
    expect(d.topMerchants.length).toBeLessThanOrEqual(5)
    expect(d.topMerchants[0]!.payee).toBe('City Properties')
    expect(d.topMerchants[0]!.netCents).toBe(-165000)
    expect(d.topMerchants.map((m) => m.payee)).not.toContain('Amex ePayment')
  })

  it('payments integrity balances in recent months and diverges in the oldest', async () => {
    const now = await api.getDashboard(M0)
    expect(now.paymentsIntegrity.diverges).toBe(false)
    expect(now.paymentsIntegrity.checkingSideCents).toBe(84355)
    expect(now.paymentsIntegrity.cardSideCents).toBe(84355)
    const old = await api.getDashboard(M2)
    expect(old.paymentsIntegrity.diverges).toBe(true)
    expect(old.paymentsIntegrity.checkingSideCents).toBe(105855) // 84355 + leaked 21500 autopay
    expect(old.paymentsIntegrity.cardSideCents).toBe(84355)
  })
})
