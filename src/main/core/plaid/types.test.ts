import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  plaidAccountsGetResponseSchema,
  plaidErrorSchema,
  plaidSyncResponseSchema,
  plaidTransactionSchema,
} from './types'

const FIXTURES = '/root/whats-left/fixtures/plaid'

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}/${name}`, 'utf8'))
}

describe('plaid fixtures parse cleanly at the boundary', () => {
  it('parses transactions_sync_page1.json (has_more=true, cursor set)', () => {
    const page = plaidSyncResponseSchema.parse(loadJson('transactions_sync_page1.json'))
    expect(page.added).toHaveLength(3)
    expect(page.modified).toEqual([])
    expect(page.removed).toEqual([])
    expect(page.has_more).toBe(true)
    expect(page.next_cursor).toBe('plaid-cursor-page-1')
    // unknown keys (request_id, payment_channel) are STRIPPED
    expect('request_id' in page).toBe(false)
    expect(page.added.every((t) => !('payment_channel' in t))).toBe(true)
  })

  it('parses transactions_sync_page2.json (has_more=false ends the cursor chain)', () => {
    const page = plaidSyncResponseSchema.parse(loadJson('transactions_sync_page2.json'))
    expect(page.added).toHaveLength(1)
    expect(page.modified).toHaveLength(1)
    expect(page.removed).toHaveLength(1)
    expect(page.has_more).toBe(false)
    expect(page.next_cursor).toBe('plaid-cursor-page-2')
  })

  it('the fixtures cover the full lifecycle: pending, replacement, modified amount, removed', () => {
    const page1 = plaidSyncResponseSchema.parse(loadJson('transactions_sync_page1.json'))
    const page2 = plaidSyncResponseSchema.parse(loadJson('transactions_sync_page2.json'))

    const pending = page1.added.find((t) => t.pending)
    expect(pending?.transaction_id).toBe('plaid-txn-pending-coffee-01')
    expect(pending?.pending_transaction_id).toBeNull()

    // a posted txn that names the pending row it replaces
    const replacement = page2.added[0]!
    expect(replacement.pending).toBe(false)
    expect(replacement.pending_transaction_id).toBe(pending?.transaction_id)

    // a MODIFIED entry whose amount changed vs its added version
    const original = page1.added.find((t) => t.transaction_id === 'plaid-txn-groceries-02')!
    const modified = page2.modified[0]!
    expect(modified.transaction_id).toBe(original.transaction_id)
    expect(modified.amount).not.toBe(original.amount)

    // PFC categories present, including a detailed groceries label
    expect(original.personal_finance_category?.detailed).toBe('FOOD_AND_DRINK_GROCERIES')
    expect(pending?.personal_finance_category?.primary).toBe('FOOD_AND_DRINK')

    // a removed[] entry with its account id
    expect(page2.removed[0]).toEqual({
      transaction_id: 'plaid-txn-voided-hold-05',
      account_id: 'plaid-acc-amex-01',
    })

    // money-in rows are NEGATIVE in Plaid's convention
    const payroll = page1.added.find((t) => t.transaction_id === 'plaid-txn-payroll-03')!
    expect(payroll.amount).toBeLessThan(0)
    expect(payroll.authorized_date).toBeNull()
  })

  it('parses accounts.json: one Chase depository + one Amex credit under one item', () => {
    const res = plaidAccountsGetResponseSchema.parse(loadJson('accounts.json'))
    expect(res.accounts).toHaveLength(2)
    expect(res.accounts.map((a) => a.type)).toEqual(['depository', 'credit'])
    expect(res.accounts[0]).toMatchObject({ account_id: 'plaid-acc-chase-01', mask: '6789' })
    expect(res.accounts[1]).toMatchObject({ account_id: 'plaid-acc-amex-01', mask: '1005' })
    expect(res.item.item_id).toBe('plaid-item-01')
  })

  it('parses error_item_login_required.json', () => {
    const err = plaidErrorSchema.parse(loadJson('error_item_login_required.json'))
    expect(err.error_type).toBe('ITEM_ERROR')
    expect(err.error_code).toBe('ITEM_LOGIN_REQUIRED')
  })
})

describe('plaid schema strictness', () => {
  const validTxn = () =>
    plaidSyncResponseSchema.parse(loadJson('transactions_sync_page1.json')).added[0]!

  it('rejects a string amount (Plaid amounts are numbers, unlike Teller)', () => {
    const txn = { ...validTxn(), amount: '-6.75' }
    expect(plaidTransactionSchema.safeParse(txn).success).toBe(false)
  })

  it('rejects a non-ISO date', () => {
    expect(plaidTransactionSchema.safeParse({ ...validTxn(), date: '07/05/2026' }).success).toBe(false)
    expect(
      plaidTransactionSchema.safeParse({ ...validTxn(), authorized_date: '2026-7-5' }).success,
    ).toBe(false)
  })

  it('rejects a sync response missing the cursor fields', () => {
    expect(
      plaidSyncResponseSchema.safeParse({ added: [], modified: [], removed: [] }).success,
    ).toBe(false)
  })

  it('tolerates a removed[] entry without account_id (older API shape)', () => {
    const page = {
      added: [],
      modified: [],
      removed: [{ transaction_id: 'plaid-txn-x' }],
      next_cursor: 'c',
      has_more: false,
    }
    const parsed = plaidSyncResponseSchema.parse(page)
    expect(parsed.removed[0]?.transaction_id).toBe('plaid-txn-x')
  })
})
