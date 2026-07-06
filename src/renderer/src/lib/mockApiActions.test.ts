import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Api } from '../../../shared/ipcContract'
import type { TransactionDto } from '../../../shared/types'
import { createMockApi } from './mockApi'

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../fixtures/csv/${name}`, import.meta.url)), 'utf8')
}

let api: Api

beforeEach(() => {
  api = createMockApi()
})

async function txnsByText(text: string): Promise<TransactionDto[]> {
  const { rows } = await api.listTransactions({ text })
  return rows
}

describe('recategorize', () => {
  it('rejects unknown transaction or category', async () => {
    await expect(api.recategorize({ txnId: 'nope', categoryId: 'groceries', scope: 'txn' })).rejects.toThrow()
    const [row] = await txnsByText('netflix')
    await expect(api.recategorize({ txnId: row!.id, categoryId: 'bogus', scope: 'txn' })).rejects.toThrow()
  })

  it("scope 'txn' updates exactly one row and marks it user-categorized", async () => {
    const rows = await txnsByText('netflix')
    const target = rows[0]!
    const res = await api.recategorize({ txnId: target.id, categoryId: 'general_services', scope: 'txn' })
    expect(res.updated).toBe(1)
    const after = await txnsByText('netflix')
    const changed = after.find((r) => r.id === target.id)!
    expect(changed.categoryId).toBe('general_services')
    expect(changed.categorySource).toBe('user')
    for (const other of after.filter((r) => r.id !== target.id)) {
      expect(other.categoryId).toBe('entertainment')
    }
  })

  it("scope 'merchant' + applyToExisting updates all non-user rows of that payee", async () => {
    const rows = await txnsByText('netflix')
    expect(rows).toHaveLength(3)
    const res = await api.recategorize({
      txnId: rows[0]!.id,
      categoryId: 'general_services',
      scope: 'merchant',
      applyToExisting: true,
    })
    expect(res.updated).toBe(3)
    const after = await txnsByText('netflix')
    expect(after.every((r) => r.categoryId === 'general_services')).toBe(true)
    expect(after.find((r) => r.id === rows[0]!.id)!.categorySource).toBe('user')
    expect(after.filter((r) => r.id !== rows[0]!.id).every((r) => r.categorySource === 'cache')).toBe(true)
  })

  it('never overwrites user-categorized rows when applying to existing', async () => {
    const rows = await txnsByText('netflix')
    // Pin one row as a user decision first.
    await api.recategorize({ txnId: rows[1]!.id, categoryId: 'travel', scope: 'txn' })
    const res = await api.recategorize({
      txnId: rows[0]!.id,
      categoryId: 'general_services',
      scope: 'merchant',
      applyToExisting: true,
    })
    expect(res.updated).toBe(2) // target + the one remaining non-user row
    const after = await txnsByText('netflix')
    expect(after.find((r) => r.id === rows[1]!.id)!.categoryId).toBe('travel')
  })

  it("scope 'merchant' without applyToExisting only touches the target row", async () => {
    const rows = await txnsByText('netflix')
    const res = await api.recategorize({ txnId: rows[0]!.id, categoryId: 'general_services', scope: 'merchant' })
    expect(res.updated).toBe(1)
    const after = await txnsByText('netflix')
    expect(after.filter((r) => r.categoryId === 'entertainment')).toHaveLength(2)
  })
})

describe('review queue', () => {
  it('lists low-confidence LLM categorizations referencing real transactions', async () => {
    const items = await api.listReviewQueue()
    expect(items).toHaveLength(2)
    const { rows } = await api.listTransactions({})
    const ids = new Set(rows.map((r) => r.id))
    for (const item of items) {
      expect(ids.has(item.txnId)).toBe(true)
      expect(item.confidence).toBeLessThan(0.7)
    }
  })

  it('resolveReview applies a user category and removes the item', async () => {
    const [item] = await api.listReviewQueue()
    await api.resolveReview(item!.txnId, 'groceries')
    expect(await api.listReviewQueue()).toHaveLength(1)
    const { rows } = await api.listTransactions({ text: item!.payee })
    const txn = rows.find((r) => r.id === item!.txnId)!
    expect(txn.categoryId).toBe('groceries')
    expect(txn.categorySource).toBe('user')
  })

  it('rejects unknown txn or category', async () => {
    await expect(api.resolveReview('nope', 'groceries')).rejects.toThrow()
    const [item] = await api.listReviewQueue()
    await expect(api.resolveReview(item!.txnId, 'bogus')).rejects.toThrow()
  })
})

describe('csv import', () => {
  it('rejects an unknown account — attribution is explicit, never guessed', async () => {
    await expect(
      api.importCsv({ accountId: 'nope', fileName: 'x.csv', content: fixture('chase_credit.csv'), commit: false }),
    ).rejects.toThrow()
  })

  it('rejects unknown headers loudly', async () => {
    await expect(
      api.importCsv({
        accountId: 'acct-checking',
        fileName: 'weird.csv',
        content: fixture('unknown_format.csv'),
        commit: false,
      }),
    ).rejects.toThrow(/header/i)
  })

  it('dry run reports without persisting', async () => {
    const acct = await api.createCsvAccount({ name: 'Chase Credit backfill', institution: 'chase', type: 'credit' })
    const report = await api.importCsv({
      accountId: acct.id,
      fileName: 'chase_credit.csv',
      content: fixture('chase_credit.csv'),
      commit: false,
    })
    expect(report).toMatchObject({
      accountId: acct.id,
      accountName: 'Chase Credit backfill',
      format: 'chase_credit',
      parsed: 9,
      newCount: 9,
      skippedDuplicates: 0,
      committed: false,
    })
    const { total } = await api.listTransactions({ accountId: acct.id })
    expect(total).toBe(0)
  })

  it('commit persists rows with canonical signs and rule/source categories', async () => {
    const acct = await api.createCsvAccount({ name: 'Backfill', institution: 'chase', type: 'credit' })
    const report = await api.importCsv({
      accountId: acct.id,
      fileName: 'chase_credit.csv',
      content: fixture('chase_credit.csv'),
      commit: true,
    })
    expect(report.committed).toBe(true)
    expect(report.newCount).toBe(9)
    const { rows, total } = await api.listTransactions({ accountId: acct.id })
    expect(total).toBe(9)
    expect(rows.every((r) => r.source === 'chase_csv')).toBe(true)
    const coffees = rows.filter((r) => r.rawDescription.includes('COFFEE HOUSE'))
    expect(coffees).toHaveLength(2) // identical same-day rows both survive (occurrence index)
    expect(coffees[0]!.amountCents).toBe(-675)
    const payment = rows.find((r) => r.rawDescription.includes('Payment Thank You'))!
    expect(payment.categoryId).toBe('loan_payments')
    const grocery = rows.find((r) => r.rawDescription.startsWith('WHOLEFDS'))!
    expect(grocery.categoryId).toBe('groceries')
    expect(grocery.categorySource).toBe('source')
  })

  it('re-importing the same file is a no-op (idempotent hash dedupe)', async () => {
    const acct = await api.createCsvAccount({ name: 'Backfill', institution: 'chase', type: 'credit' })
    const input = { accountId: acct.id, fileName: 'c.csv', content: fixture('chase_credit.csv'), commit: true }
    await api.importCsv(input)
    const second = await api.importCsv(input)
    expect(second.newCount).toBe(0)
    expect(second.skippedDuplicates).toBe(9)
    const { total } = await api.listTransactions({ accountId: acct.id })
    expect(total).toBe(9)
  })

  it('inverts Amex signs on commit', async () => {
    const acct = await api.createCsvAccount({ name: 'Amex backfill', institution: 'amex', type: 'credit' })
    await api.importCsv({
      accountId: acct.id,
      fileName: 'amex.csv',
      content: fixture('amex_extended.csv'),
      commit: true,
    })
    const { rows } = await api.listTransactions({ accountId: acct.id })
    expect(rows.every((r) => r.source === 'amex_csv')).toBe(true)
    const wf = rows.find((r) => r.rawDescription.startsWith('WHOLE FOODS'))!
    expect(wf.amountCents).toBe(-8710)
    const rewards = rows.find((r) => r.rawDescription.startsWith('MEMBERSHIP REWARDS'))!
    expect(rewards.amountCents).toBe(4500)
  })
})

describe('accounts', () => {
  it('createCsvAccount validates and adds a csv_only account', async () => {
    const acct = await api.createCsvAccount({ name: 'Old Amex', institution: 'amex', type: 'credit', mask: '1005' })
    expect(acct.sourceKind).toBe('csv_only')
    expect(acct.status).toBe('ok')
    expect(acct.mask).toBe('1005')
    const all = await api.listAccounts()
    expect(all.map((a) => a.id)).toContain(acct.id)
    await expect(api.createCsvAccount({ name: '   ', institution: 'amex', type: 'credit' })).rejects.toThrow()
  })

  it('linkCsvHistory moves rows onto the teller account', async () => {
    const csvAcct = await api.createCsvAccount({ name: 'Backfill', institution: 'chase', type: 'depository' })
    await api.importCsv({
      accountId: csvAcct.id,
      fileName: 'chk.csv',
      content: fixture('chase_checking.csv'),
      commit: true,
    })
    const before = await api.listTransactions({ accountId: 'acct-checking' })
    const res = await api.linkCsvHistory(csvAcct.id, 'acct-checking')
    expect(res.moved).toBe(7)
    expect((await api.listTransactions({ accountId: csvAcct.id })).total).toBe(0)
    expect((await api.listTransactions({ accountId: 'acct-checking' })).total).toBe(before.total + 7)
  })

  it('linkCsvHistory validates both sides', async () => {
    await expect(api.linkCsvHistory('nope', 'acct-checking')).rejects.toThrow()
    await expect(api.linkCsvHistory('acct-amex', 'acct-checking')).rejects.toThrow() // source must be csv_only
    const csvAcct = await api.createCsvAccount({ name: 'B', institution: 'chase', type: 'depository' })
    const csvAcct2 = await api.createCsvAccount({ name: 'C', institution: 'chase', type: 'depository' })
    await expect(api.linkCsvHistory(csvAcct.id, csvAcct2.id)).rejects.toThrow() // target must be teller
  })

  it('startEnrollment adds a connected teller account', async () => {
    const before = (await api.listAccounts()).length
    const res = await api.startEnrollment('amex')
    expect(res.ok).toBe(true)
    expect(res.accountsAdded).toBe(1)
    expect(res.enrollmentId).toBeTruthy()
    const after = await api.listAccounts()
    expect(after).toHaveLength(before + 1)
    expect(after.at(-1)!.sourceKind).toBe('teller')
  })

  it('reconnect repairs a reconnect_required account without burning quota', async () => {
    const res = await api.reconnect('acct-amex')
    expect(res.ok).toBe(true)
    const amex = (await api.listAccounts()).find((a) => a.id === 'acct-amex')!
    expect(amex.status).toBe('ok')
    await expect(api.reconnect('nope')).rejects.toThrow()
    const csvAcct = await api.createCsvAccount({ name: 'B', institution: 'chase', type: 'depository' })
    await expect(api.reconnect(csvAcct.id)).rejects.toThrow() // csv accounts have no enrollment
  })
})

describe('sync', () => {
  it('reports per-account results and surfaces enrollment-inactive errors', async () => {
    const report = await api.syncNow()
    expect(report.ranAt).toBeTruthy()
    const checking = report.accounts.find((a) => a.accountId === 'acct-checking')!
    expect(checking.error).toBeNull()
    const amex = report.accounts.find((a) => a.accountId === 'acct-amex')!
    expect(amex.error).toMatch(/reconnect/i)
  })

  it('after reconnect, sync succeeds and stamps lastSyncAt', async () => {
    await api.reconnect('acct-amex')
    const report = await api.syncNow()
    expect(report.accounts.every((a) => a.error === null)).toBe(true)
    const amex = (await api.listAccounts()).find((a) => a.id === 'acct-amex')!
    expect(amex.lastSyncAt).toBeTruthy()
  })
})

describe('settings', () => {
  it('returns the settings dto with an enrollment quota counter', async () => {
    const s = await api.getSettings()
    expect(s.tellerEnv === 'sandbox' || s.tellerEnv === 'development').toBe(true)
    expect(s.syncIntervalHours).toBeGreaterThan(0)
    expect(s.ollamaUrl).toBeTruthy()
    expect(s.ollamaModel).toBeTruthy()
    expect(typeof s.enrollmentsUsed).toBe('number')
  })

  it('updateSettings merges immutably and persists', async () => {
    const before = await api.getSettings()
    const updated = await api.updateSettings({ syncIntervalHours: 6 })
    expect(updated.syncIntervalHours).toBe(6)
    expect(updated.ollamaModel).toBe(before.ollamaModel)
    expect((await api.getSettings()).syncIntervalHours).toBe(6)
  })

  it('validates patches at the boundary', async () => {
    await expect(api.updateSettings({ syncIntervalHours: 0 })).rejects.toThrow()
    await expect(api.updateSettings({ syncIntervalHours: -2 })).rejects.toThrow()
    await expect(api.updateSettings({ ollamaUrl: '' })).rejects.toThrow()
    await expect(api.updateSettings({ tellerEnv: 'prod' as never })).rejects.toThrow()
  })
})

describe('exportData', () => {
  it('returns the written path', async () => {
    const res = await api.exportData()
    expect(res.path).toBeTruthy()
  })
})
