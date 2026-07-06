import { describe, expect, it } from 'vitest'
import type { TxnDraft } from '../../../shared/types'
import type { MerchantCachePort } from '../ports'
import { applyLlmResults, resolveCategory } from './resolver'

interface CacheRow {
  normalizedMerchant: string
  categoryId: string
  source: 'rule' | 'chase' | 'amex' | 'teller' | 'llm' | 'user'
  confidence: number | null
  locked: boolean
}

class FakeMerchantCache implements MerchantCachePort {
  readonly rows = new Map<string, CacheRow>()

  get(normalizedMerchant: string): { categoryId: string; locked: boolean } | null {
    const row = this.rows.get(normalizedMerchant)
    return row ? { categoryId: row.categoryId, locked: row.locked } : null
  }

  set(entry: CacheRow): void {
    this.rows.set(entry.normalizedMerchant, { ...entry })
  }
}

function draft(overrides: Partial<TxnDraft>): TxnDraft {
  return {
    source: 'chase_csv',
    externalId: null,
    importHash: 'hash',
    txnDate: '2026-06-30',
    postDate: '2026-06-30',
    amountCents: -1000,
    status: 'posted',
    rawDescription: 'SOME MERCHANT',
    importedPayee: 'Some Merchant',
    sourceCategory: null,
    counterparty: null,
    typeCode: null,
    ...overrides,
  }
}

const autopayDraft = (): TxnDraft =>
  draft({
    rawDescription: 'CHASE CREDIT CRD AUTOPAY                    PPD ID: 4760039224',
    amountCents: -84355,
    typeCode: 'ACH_DEBIT',
  })

describe('tier 1 — shipped default rules', () => {
  it('rule hit → categorySource=rule and an unlocked cache write with source=rule', () => {
    const cache = new FakeMerchantCache()
    const result = resolveCategory(
      { draft: autopayDraft(), accountType: 'depository', normalizedMerchant: 'Chase Credit Crd Autopay' },
      { cache },
    )
    expect(result).toEqual({ categoryId: 'loan_payments', categorySource: 'rule' })
    expect(cache.rows.get('Chase Credit Crd Autopay')).toEqual({
      normalizedMerchant: 'Chase Credit Crd Autopay',
      categoryId: 'loan_payments',
      source: 'rule',
      confidence: null,
      locked: false,
    })
  })

  it('rule beats an unlocked cache row and overwrites it', () => {
    const cache = new FakeMerchantCache()
    cache.set({ normalizedMerchant: 'Chase Credit Crd Autopay', categoryId: 'groceries', source: 'chase', confidence: null, locked: false })
    const result = resolveCategory(
      { draft: autopayDraft(), accountType: 'depository', normalizedMerchant: 'Chase Credit Crd Autopay' },
      { cache },
    )
    expect(result).toEqual({ categoryId: 'loan_payments', categorySource: 'rule' })
    expect(cache.rows.get('Chase Credit Crd Autopay')?.categoryId).toBe('loan_payments')
    expect(cache.rows.get('Chase Credit Crd Autopay')?.source).toBe('rule')
  })

  it('LOCKED user cache row always wins — even over a matching rule — and is never overwritten', () => {
    const cache = new FakeMerchantCache()
    cache.set({ normalizedMerchant: 'Chase Credit Crd Autopay', categoryId: 'transfer_out', source: 'user', confidence: null, locked: true })
    const result = resolveCategory(
      { draft: autopayDraft(), accountType: 'depository', normalizedMerchant: 'Chase Credit Crd Autopay' },
      { cache },
    )
    expect(result).toEqual({ categoryId: 'transfer_out', categorySource: 'cache' })
    expect(cache.rows.get('Chase Credit Crd Autopay')).toEqual({
      normalizedMerchant: 'Chase Credit Crd Autopay',
      categoryId: 'transfer_out',
      source: 'user',
      confidence: null,
      locked: true,
    })
  })
})

describe('tier 2 — merchant cache', () => {
  it('unlocked cache hit → categorySource=cache, beats source label mapping', () => {
    const cache = new FakeMerchantCache()
    cache.set({ normalizedMerchant: 'Coffee House', categoryId: 'entertainment', source: 'user', confidence: null, locked: false })
    const result = resolveCategory(
      {
        draft: draft({ rawDescription: 'TST* COFFEE HOUSE 0042 SEATTLE WA', amountCents: -675, sourceCategory: 'Groceries' }),
        accountType: 'credit',
        normalizedMerchant: 'Coffee House',
      },
      { cache },
    )
    expect(result).toEqual({ categoryId: 'entertainment', categorySource: 'cache' })
  })

  it('refund guard: positive amount on credit account with cache-known merchant inherits that category — never income', () => {
    const cache = new FakeMerchantCache()
    cache.set({ normalizedMerchant: 'Amazon Marketplace', categoryId: 'general_merchandise', source: 'chase', confidence: null, locked: false })
    const result = resolveCategory(
      {
        // Teller labels the refund 'income'; the cache must win.
        draft: draft({ source: 'teller', amountCents: 6499, sourceCategory: 'income' }),
        accountType: 'credit',
        normalizedMerchant: 'Amazon Marketplace',
      },
      { cache },
    )
    expect(result).toEqual({ categoryId: 'general_merchandise', categorySource: 'cache' })
  })
})

describe('tier 3 — source label mapping', () => {
  it('chase_csv label → categorySource=source with cache write source=chase', () => {
    const cache = new FakeMerchantCache()
    const result = resolveCategory(
      { draft: draft({ sourceCategory: 'Groceries' }), accountType: 'credit', normalizedMerchant: 'Wholefds' },
      { cache },
    )
    expect(result).toEqual({ categoryId: 'groceries', categorySource: 'source' })
    expect(cache.rows.get('Wholefds')).toEqual({
      normalizedMerchant: 'Wholefds',
      categoryId: 'groceries',
      source: 'chase',
      confidence: null,
      locked: false,
    })
  })

  it('teller label → cache write source=teller', () => {
    const cache = new FakeMerchantCache()
    const result = resolveCategory(
      { draft: draft({ source: 'teller', sourceCategory: 'dining' }), accountType: 'credit', normalizedMerchant: 'Coffee House' },
      { cache },
    )
    expect(result).toEqual({ categoryId: 'food_and_drink', categorySource: 'source' })
    expect(cache.rows.get('Coffee House')?.source).toBe('teller')
  })

  it('amex_csv label (exact-then-prefix) → cache write source=amex', () => {
    const cache = new FakeMerchantCache()
    const result = resolveCategory(
      {
        draft: draft({ source: 'amex_csv', sourceCategory: 'Restaurant-Restaurant' }),
        accountType: 'credit',
        normalizedMerchant: 'Uber Eats',
      },
      { cache },
    )
    expect(result).toEqual({ categoryId: 'food_and_drink', categorySource: 'source' })
    expect(cache.rows.get('Uber Eats')?.source).toBe('amex')
  })

  it('tier-3 never overwrites a locked row... (locked short-circuits at tier 1)', () => {
    const cache = new FakeMerchantCache()
    cache.set({ normalizedMerchant: 'Wholefds', categoryId: 'food_and_drink', source: 'user', confidence: null, locked: true })
    const result = resolveCategory(
      { draft: draft({ sourceCategory: 'Groceries' }), accountType: 'credit', normalizedMerchant: 'Wholefds' },
      { cache },
    )
    expect(result).toEqual({ categoryId: 'food_and_drink', categorySource: 'cache' })
    expect(cache.rows.get('Wholefds')?.source).toBe('user')
  })

  it('refund guard part 2: source label income on a credit-account positive row is suppressed → needsLlm', () => {
    const cache = new FakeMerchantCache()
    const result = resolveCategory(
      { draft: draft({ source: 'teller', amountCents: 4500, sourceCategory: 'income' }), accountType: 'credit', normalizedMerchant: 'Mystery Rebate' },
      { cache },
    )
    expect(result).toEqual({ needsLlm: true })
    expect(cache.rows.size).toBe(0)
  })

  it('income label on a depository account is allowed (payroll)', () => {
    const cache = new FakeMerchantCache()
    const result = resolveCategory(
      { draft: draft({ source: 'teller', amountCents: 250000, sourceCategory: 'income' }), accountType: 'depository', normalizedMerchant: 'Acme Corp' },
      { cache },
    )
    expect(result).toEqual({ categoryId: 'income', categorySource: 'source' })
  })

  it('income label on a credit-account NEGATIVE row is not the refund case and maps normally', () => {
    const cache = new FakeMerchantCache()
    const result = resolveCategory(
      { draft: draft({ source: 'teller', amountCents: -4500, sourceCategory: 'income' }), accountType: 'credit', normalizedMerchant: 'Odd Merchant' },
      { cache },
    )
    expect(result).toEqual({ categoryId: 'income', categorySource: 'source' })
  })
})

describe('tier 4 — needsLlm fall-through', () => {
  it('no rule, no cache, no source label → needsLlm', () => {
    const cache = new FakeMerchantCache()
    const result = resolveCategory(
      { draft: draft({ sourceCategory: null }), accountType: 'credit', normalizedMerchant: 'New Merchant' },
      { cache },
    )
    expect(result).toEqual({ needsLlm: true })
    expect(cache.rows.size).toBe(0)
  })

  it('unknown source label → needsLlm (fail-safe to review, no cache poisoning)', () => {
    const cache = new FakeMerchantCache()
    const result = resolveCategory(
      { draft: draft({ source: 'amex_csv', sourceCategory: 'Other-Miscellaneous' }), accountType: 'credit', normalizedMerchant: 'New Merchant' },
      { cache },
    )
    expect(result).toEqual({ needsLlm: true })
    expect(cache.rows.size).toBe(0)
  })
})

describe('empty normalizedMerchant', () => {
  it('rules still resolve but nothing is cached under an empty key', () => {
    const cache = new FakeMerchantCache()
    const result = resolveCategory({ draft: autopayDraft(), accountType: 'depository', normalizedMerchant: '' }, { cache })
    expect(result).toEqual({ categoryId: 'loan_payments', categorySource: 'rule' })
    expect(cache.rows.size).toBe(0)
  })

  it('source labels still resolve but nothing is cached under an empty key', () => {
    const cache = new FakeMerchantCache()
    const result = resolveCategory(
      { draft: draft({ sourceCategory: 'Groceries' }), accountType: 'credit', normalizedMerchant: '   ' },
      { cache },
    )
    expect(result).toEqual({ categoryId: 'groceries', categorySource: 'source' })
    expect(cache.rows.size).toBe(0)
  })
})

describe('applyLlmResults', () => {
  it('writes cache rows with source=llm and the given confidence', () => {
    const cache = new FakeMerchantCache()
    const summary = applyLlmResults(
      [
        { merchant: 'Blue Bottle Coffee', category: 'food_and_drink', confidence: 0.92 },
        { merchant: 'Candle Studio', category: 'general_merchandise', confidence: 0.61 },
      ],
      { cache },
    )
    expect(summary).toEqual({ written: 2, skippedLocked: 0 })
    expect(cache.rows.get('Blue Bottle Coffee')).toEqual({
      normalizedMerchant: 'Blue Bottle Coffee',
      categoryId: 'food_and_drink',
      source: 'llm',
      confidence: 0.92,
      locked: false,
    })
  })

  it('skips locked rows (user categorization wins forever)', () => {
    const cache = new FakeMerchantCache()
    cache.set({ normalizedMerchant: 'Blue Bottle Coffee', categoryId: 'entertainment', source: 'user', confidence: null, locked: true })
    const summary = applyLlmResults([{ merchant: 'Blue Bottle Coffee', category: 'food_and_drink', confidence: 0.9 }], { cache })
    expect(summary).toEqual({ written: 0, skippedLocked: 1 })
    expect(cache.rows.get('Blue Bottle Coffee')?.categoryId).toBe('entertainment')
    expect(cache.rows.get('Blue Bottle Coffee')?.locked).toBe(true)
  })

  it('overwrites unlocked rows', () => {
    const cache = new FakeMerchantCache()
    cache.set({ normalizedMerchant: 'Candle Studio', categoryId: 'uncategorized', source: 'llm', confidence: 0.2, locked: false })
    const summary = applyLlmResults([{ merchant: 'Candle Studio', category: 'general_merchandise', confidence: 0.8 }], { cache })
    expect(summary).toEqual({ written: 1, skippedLocked: 0 })
    expect(cache.rows.get('Candle Studio')?.categoryId).toBe('general_merchandise')
    expect(cache.rows.get('Candle Studio')?.confidence).toBe(0.8)
  })

  it('throws loudly on a category outside the taxonomy (never silently mislabels)', () => {
    const cache = new FakeMerchantCache()
    expect(() => applyLlmResults([{ merchant: 'X', category: 'crypto_gambling', confidence: 0.9 }], { cache })).toThrow(/crypto_gambling/)
    expect(cache.rows.size).toBe(0)
  })

  it('throws on out-of-range or NaN confidence', () => {
    const cache = new FakeMerchantCache()
    expect(() => applyLlmResults([{ merchant: 'X', category: 'travel', confidence: 1.5 }], { cache })).toThrow(/confidence/)
    expect(() => applyLlmResults([{ merchant: 'X', category: 'travel', confidence: Number.NaN }], { cache })).toThrow(/confidence/)
  })

  it('throws on an empty merchant name', () => {
    const cache = new FakeMerchantCache()
    expect(() => applyLlmResults([{ merchant: '  ', category: 'travel', confidence: 0.9 }], { cache })).toThrow(/merchant/)
  })
})
