import { describe, expect, it } from 'vitest'
import type { Db } from './db'
import { insertAccount, insertTxn, makeRepo } from './testSupport'

/**
 * Standard ledger for dashboard math (June 2026):
 * card (credit): coffee -5000 + -2500, Amazon -10000 + refund +2000,
 *   pending Chipotle -1500, payment received +24000 (loan_payments)
 * checking (depository): autopay -24000 (loan_payments), paycheck +300000 (income),
 *   transfer out -50000; plus May coffee -4000 for the trend.
 */
function seedLedger(db: Db): { card: string; checking: string } {
  const card = insertAccount(db, { type: 'credit', name: 'Card' })
  const checking = insertAccount(db, { type: 'depository', name: 'Checking' })

  insertTxn(db, card, { txnDate: '2026-06-05', amountCents: -5000, importedPayee: 'Blue Bottle', categoryId: 'food_and_drink', categorySource: 'cache' })
  insertTxn(db, card, { txnDate: '2026-06-10', amountCents: -2500, importedPayee: 'Blue Bottle', categoryId: 'food_and_drink', categorySource: 'cache' })
  insertTxn(db, card, { txnDate: '2026-06-12', amountCents: -10000, importedPayee: 'Amazon', categoryId: 'general_merchandise', categorySource: 'rule' })
  insertTxn(db, card, { txnDate: '2026-06-15', amountCents: 2000, importedPayee: 'Amazon', categoryId: 'general_merchandise', categorySource: 'rule' })
  insertTxn(db, card, { txnDate: '2026-06-20', amountCents: -1500, status: 'pending', importedPayee: 'Chipotle', categoryId: 'food_and_drink', categorySource: 'cache' })
  insertTxn(db, card, { txnDate: '2026-06-28', amountCents: 24000, importedPayee: 'Payment Thank You', categoryId: 'loan_payments', categorySource: 'rule' })

  insertTxn(db, checking, { txnDate: '2026-06-27', amountCents: -24000, importedPayee: 'Chase Autopay', categoryId: 'loan_payments', categorySource: 'rule' })
  insertTxn(db, checking, { txnDate: '2026-06-01', amountCents: 300000, importedPayee: 'Employer Inc', categoryId: 'income', categorySource: 'rule' })
  insertTxn(db, checking, { txnDate: '2026-06-03', amountCents: -50000, importedPayee: 'Transfer to Savings', categoryId: 'transfer_out', categorySource: 'rule' })

  insertTxn(db, card, { txnDate: '2026-05-03', amountCents: -4000, importedPayee: 'Blue Bottle', categoryId: 'food_and_drink', categorySource: 'cache' })
  return { card, checking }
}

describe('SqliteRepo.getDashboard', () => {
  it('byCategory nets refunds, excludes payments/transfers/income and pending rows', () => {
    const { db, repo } = makeRepo()
    seedLedger(db)
    const dash = repo.getDashboard('2026-06')
    expect(dash.month).toBe('2026-06')
    expect(dash.byCategory).toEqual([
      { categoryId: 'general_merchandise', categoryName: 'Shopping', netCents: -8000 },
      { categoryId: 'food_and_drink', categoryName: 'Dining & Drinks', netCents: -7500 },
    ])
  })

  it('the loan_payments autopay pair is absent from byCategory and balances the integrity check', () => {
    const { db, repo } = makeRepo()
    seedLedger(db)
    const dash = repo.getDashboard('2026-06')
    expect(dash.byCategory.map((c) => c.categoryId)).not.toContain('loan_payments')
    expect(dash.paymentsIntegrity).toEqual({
      checkingSideCents: 24000,
      cardSideCents: 24000,
      diverges: false,
    })
  })

  it('uncategorized rows do not leak into byCategory', () => {
    const { db, repo } = makeRepo()
    const { card } = seedLedger(db)
    insertTxn(db, card, { txnDate: '2026-06-18', amountCents: -999, importedPayee: 'Mystery' })
    const dash = repo.getDashboard('2026-06')
    expect(dash.byCategory.map((c) => c.categoryId)).toEqual([
      'general_merchandise',
      'food_and_drink',
    ])
  })

  it('trend is 12 zero-filled months ending at the requested month', () => {
    const { db, repo } = makeRepo()
    seedLedger(db)
    const { trend } = repo.getDashboard('2026-06')
    expect(trend).toHaveLength(12)
    expect(trend[0]?.month).toBe('2025-07')
    expect(trend[11]).toEqual({ month: '2026-06', spendCents: -15500, incomeCents: 300000 })
    expect(trend[10]).toEqual({ month: '2026-05', spendCents: -4000, incomeCents: 0 })
    expect(trend[3]).toEqual({ month: '2025-10', spendCents: 0, incomeCents: 0 })
  })

  it('topMerchants ranks by absolute net for the month and excludes payments/transfers/pendings', () => {
    const { db, repo } = makeRepo()
    seedLedger(db)
    const { topMerchants } = repo.getDashboard('2026-06')
    expect(topMerchants).toEqual([
      { payee: 'Amazon', netCents: -8000, count: 2 },
      { payee: 'Blue Bottle', netCents: -7500, count: 2 },
    ])
  })

  it('topMerchants is capped at 8', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    for (let i = 0; i < 10; i++) {
      insertTxn(db, acct, {
        txnDate: '2026-03-10',
        amountCents: -100 * (i + 1),
        importedPayee: `Shop ${i}`,
        categoryId: 'general_merchandise',
        categorySource: 'rule',
      })
    }
    const { topMerchants } = repo.getDashboard('2026-03')
    expect(topMerchants).toHaveLength(8)
    expect(topMerchants[0]).toEqual({ payee: 'Shop 9', netCents: -1000, count: 1 })
  })

  it('pendingCents sums only the requested month’s live pending rows', () => {
    const { db, repo } = makeRepo()
    const { card } = seedLedger(db)
    insertTxn(db, card, { txnDate: '2026-07-01', amountCents: -9999, status: 'pending', importedPayee: 'Next Month' })
    const tomb = insertTxn(db, card, { txnDate: '2026-06-21', amountCents: -500, status: 'pending' })
    db.prepare('UPDATE transactions SET tombstone = 1 WHERE id = ?').run(tomb)
    expect(repo.getDashboard('2026-06').pendingCents).toBe(-1500)
    expect(repo.getDashboard('2026-07').pendingCents).toBe(-9999)
  })

  it('integrity diverges when a payment leaks on only one side', () => {
    const { db, repo } = makeRepo()
    const checking = insertAccount(db, { type: 'depository' })
    insertTxn(db, checking, { txnDate: '2026-04-05', amountCents: -24000, categoryId: 'loan_payments', categorySource: 'rule' })
    const dash = repo.getDashboard('2026-04')
    expect(dash.paymentsIntegrity).toEqual({
      checkingSideCents: 24000,
      cardSideCents: 0,
      diverges: true,
    })
  })

  it('integrity tolerates small drift (≤ max(100¢, 10%)) and only counts positive card rows', () => {
    const { db, repo } = makeRepo()
    const checking = insertAccount(db, { type: 'depository' })
    const card = insertAccount(db, { type: 'credit' })
    insertTxn(db, checking, { txnDate: '2026-02-05', amountCents: -24000, categoryId: 'loan_payments', categorySource: 'rule' })
    insertTxn(db, card, { txnDate: '2026-02-07', amountCents: 23950, categoryId: 'loan_payments', categorySource: 'rule' })
    // negative loan_payments row on the card side must NOT count
    insertTxn(db, card, { txnDate: '2026-02-08', amountCents: -3000, categoryId: 'loan_payments', categorySource: 'rule' })
    const dash = repo.getDashboard('2026-02')
    expect(dash.paymentsIntegrity).toEqual({
      checkingSideCents: 24000,
      cardSideCents: 23950,
      diverges: false,
    })
  })

  it('integrity flags divergence just above the absolute floor', () => {
    const { db, repo } = makeRepo()
    const checking = insertAccount(db, { type: 'depository' })
    insertTxn(db, checking, { txnDate: '2026-01-05', amountCents: -500, categoryId: 'loan_payments', categorySource: 'rule' })
    // diff = 500 > max(100, 10% of 500 = 50) → diverges
    expect(repo.getDashboard('2026-01').paymentsIntegrity.diverges).toBe(true)
  })

  it('rejects malformed months', () => {
    const { repo } = makeRepo()
    expect(() => repo.getDashboard('2026-13')).toThrow(/month/i)
    expect(() => repo.getDashboard('206-01')).toThrow(/month/i)
    expect(() => repo.getDashboard('June 2026')).toThrow(/month/i)
  })

  it('an empty month yields zeroed dashboard data', () => {
    const { repo } = makeRepo()
    const dash = repo.getDashboard('2026-06')
    expect(dash.byCategory).toEqual([])
    expect(dash.topMerchants).toEqual([])
    expect(dash.pendingCents).toBe(0)
    expect(dash.trend).toHaveLength(12)
    expect(dash.trend.every((t) => t.spendCents === 0 && t.incomeCents === 0)).toBe(true)
    expect(dash.paymentsIntegrity).toEqual({
      checkingSideCents: 0,
      cardSideCents: 0,
      diverges: false,
    })
  })
})
