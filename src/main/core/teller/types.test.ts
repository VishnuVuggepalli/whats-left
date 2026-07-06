import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  tellerAccountSchema,
  tellerAccountsSchema,
  tellerBalancesSchema,
  tellerErrorSchema,
  tellerTransactionSchema,
  tellerTransactionsSchema,
} from './types'

const FIXTURES = '/root/whats-left/fixtures/teller'

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}/${name}`, 'utf8'))
}

/** a fully valid transaction; tests override single fields to probe rejection */
function validTxn(): Record<string, unknown> {
  return {
    id: 'txn_1',
    account_id: 'acc_1',
    date: '2026-07-01',
    description: 'TST* COFFEE HOUSE SEATTLE WA',
    amount: '-6.75',
    status: 'posted',
    type: 'card_payment',
    running_balance: null,
    details: {
      processing_status: 'complete',
      category: 'dining',
      counterparty: { name: 'Coffee House', type: 'organization' },
    },
  }
}

describe('teller fixture parsing', () => {
  it('accounts.json parses cleanly', () => {
    const parsed = tellerAccountsSchema.parse(loadJson('accounts.json'))
    expect(parsed).toHaveLength(2)
    expect(parsed[0]?.id).toBe('acc_chase_cc_1')
    expect(parsed[0]?.institution).toEqual({ id: 'chase', name: 'Chase' })
    expect(parsed[0]?.type).toBe('credit')
    expect(parsed[1]?.last_four).toBe('1005')
  })

  it('transactions_chase_cc.json parses cleanly', () => {
    const parsed = tellerTransactionsSchema.parse(loadJson('transactions_chase_cc.json'))
    expect(parsed).toHaveLength(6)
    const pending = parsed.find((t) => t.id === 'txn_pending_new1')
    expect(pending?.status).toBe('pending')
    expect(pending?.details.category).toBeNull()
    expect(pending?.details.counterparty?.name).toBeNull()
    const coffee = parsed.find((t) => t.id === 'txn_cc_coffee_a')
    expect(coffee?.amount).toBe('-6.75')
    expect(coffee?.details.counterparty?.name).toBe('Coffee House')
  })

  it('error_enrollment_inactive.json parses cleanly', () => {
    const parsed = tellerErrorSchema.parse(loadJson('error_enrollment_inactive.json'))
    expect(parsed.error.code).toBe('enrollment.disconnected')
    expect(parsed.error.message).toContain('reconnect')
  })

  it('strips unknown keys like links (never leak transport noise downstream)', () => {
    const parsed = tellerAccountsSchema.parse(loadJson('accounts.json'))
    expect(parsed[0]).not.toHaveProperty('links')
    const txns = tellerTransactionsSchema.parse(loadJson('transactions_chase_cc.json'))
    expect(txns[0]).not.toHaveProperty('links')
  })
})

describe('tellerTransactionSchema boundary validation', () => {
  it('rejects amount as a number (must be signed string)', () => {
    const res = tellerTransactionSchema.safeParse({ ...validTxn(), amount: -6.75 })
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.includes('amount'))).toBe(true)
    }
  })

  it('rejects non-decimal amount strings', () => {
    for (const bad of ['abc', '6,75', '$5.00', '5.123', '--5', '']) {
      expect(tellerTransactionSchema.safeParse({ ...validTxn(), amount: bad }).success).toBe(false)
    }
  })

  it('accepts signed decimal amount strings', () => {
    for (const good of ['-6.75', '843.55', '0.50', '-0.5', '5', '-412.60']) {
      expect(tellerTransactionSchema.safeParse({ ...validTxn(), amount: good }).success).toBe(true)
    }
  })

  it('rejects non-ISO dates', () => {
    for (const bad of ['07/05/2026', '2026-7-5', '20260705', '']) {
      expect(tellerTransactionSchema.safeParse({ ...validTxn(), date: bad }).success).toBe(false)
    }
  })

  it('rejects unknown status values', () => {
    expect(tellerTransactionSchema.safeParse({ ...validTxn(), status: 'settled' }).success).toBe(false)
  })

  it('rejects missing id / empty id', () => {
    const { id: _drop, ...rest } = validTxn()
    expect(tellerTransactionSchema.safeParse(rest).success).toBe(false)
    expect(tellerTransactionSchema.safeParse({ ...validTxn(), id: '' }).success).toBe(false)
  })

  it('rejects missing details', () => {
    const { details: _drop, ...rest } = validTxn()
    expect(tellerTransactionSchema.safeParse(rest).success).toBe(false)
  })

  it('accepts null counterparty object and running_balance string', () => {
    const txn = {
      ...validTxn(),
      running_balance: '1234.56',
      details: { processing_status: 'complete', category: null, counterparty: null },
    }
    const res = tellerTransactionSchema.safeParse(txn)
    expect(res.success).toBe(true)
    if (res.success) {
      expect(res.data.details.counterparty).toBeNull()
      expect(res.data.running_balance).toBe('1234.56')
    }
  })
})

describe('tellerAccountSchema boundary validation', () => {
  it('rejects unknown account type', () => {
    const acc = tellerAccountsSchema.parse(loadJson('accounts.json'))[0] as Record<string, unknown>
    expect(tellerAccountSchema.safeParse({ ...acc, type: 'loan' }).success).toBe(false)
  })

  it('rejects missing institution.name', () => {
    const acc = tellerAccountsSchema.parse(loadJson('accounts.json'))[0] as Record<string, unknown>
    expect(tellerAccountSchema.safeParse({ ...acc, institution: { id: 'chase' } }).success).toBe(false)
  })
})

describe('tellerBalancesSchema', () => {
  it('accepts amount strings and nulls', () => {
    const res = tellerBalancesSchema.safeParse({
      account_id: 'acc_1',
      available: '93013.29',
      ledger: null,
    })
    expect(res.success).toBe(true)
  })

  it('rejects numeric balances', () => {
    expect(
      tellerBalancesSchema.safeParse({ account_id: 'acc_1', available: 93013.29, ledger: null }).success,
    ).toBe(false)
  })
})

describe('tellerErrorSchema', () => {
  it('rejects bodies without error.code', () => {
    expect(tellerErrorSchema.safeParse({ error: { message: 'nope' } }).success).toBe(false)
    expect(tellerErrorSchema.safeParse({ message: 'nope' }).success).toBe(false)
    expect(tellerErrorSchema.safeParse('oops').success).toBe(false)
  })
})
