import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { CATEGORY_IDS } from './taxonomy'
import {
  AMEX_CATEGORY_MAP,
  CHASE_CATEGORY_MAP,
  PLAID_PFC_DETAILED_MAP,
  PLAID_PFC_PRIMARY_MAP,
  TELLER_CATEGORY_MAP,
  clearUnknownSourceLabels,
  getUnknownSourceLabels,
  mapSourceCategory,
  resolvePlaidCategory,
  resolveAmexCategory,
} from './maps'

const fixture = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../fixtures/${rel}`, import.meta.url)), 'utf8')

/** Chase credit CSV's 16 native categories (plan §2, §5b). */
const CHASE_16 = [
  'Automotive',
  'Bills & Utilities',
  'Education',
  'Entertainment',
  'Fees & Adjustments',
  'Food & Drink',
  'Gas',
  'Gifts & Donations',
  'Groceries',
  'Health & Wellness',
  'Home',
  'Miscellaneous',
  'Personal',
  'Professional Services',
  'Shopping',
  'Travel',
] as const

/** Teller's 28-value enum (plan §5a) — includes BOTH transport AND transportation. */
const TELLER_28 = [
  'accommodation',
  'advertising',
  'bar',
  'charity',
  'clothing',
  'dining',
  'education',
  'electronics',
  'entertainment',
  'fuel',
  'general',
  'groceries',
  'health',
  'home',
  'income',
  'insurance',
  'investment',
  'loan',
  'office',
  'phone',
  'service',
  'shopping',
  'software',
  'sport',
  'tax',
  'transport',
  'transportation',
  'utilities',
] as const

beforeEach(() => {
  clearUnknownSourceLabels()
})

describe('CHASE_CATEGORY_MAP exhaustiveness', () => {
  it('maps every one of the 16 Chase categories to a valid taxonomy id', () => {
    for (const label of CHASE_16) {
      const mapped = CHASE_CATEGORY_MAP[label]
      expect(mapped, `Chase label ${label} must be mapped`).toBeDefined()
      expect(CATEGORY_IDS, `Chase ${label} → ${mapped} must be a taxonomy id`).toContain(mapped)
    }
  })

  it('contains exactly the 16 Chase labels, no extras', () => {
    expect(Object.keys(CHASE_CATEGORY_MAP).sort()).toEqual([...CHASE_16].sort())
  })
})

describe('TELLER_CATEGORY_MAP exhaustiveness', () => {
  it('maps every one of the 28 Teller values to a valid taxonomy id', () => {
    for (const label of TELLER_28) {
      const mapped = TELLER_CATEGORY_MAP[label]
      expect(mapped, `Teller label ${label} must be mapped`).toBeDefined()
      expect(CATEGORY_IDS, `Teller ${label} → ${mapped} must be a taxonomy id`).toContain(mapped)
    }
  })

  it('contains exactly the 28 Teller values, no extras', () => {
    expect(Object.keys(TELLER_CATEGORY_MAP).sort()).toEqual([...TELLER_28].sort())
  })

  it('has BOTH transport and transportation, both mapping to transportation', () => {
    expect(TELLER_CATEGORY_MAP['transport']).toBe('transportation')
    expect(TELLER_CATEGORY_MAP['transportation']).toBe('transportation')
  })
})

describe('AMEX_CATEGORY_MAP / resolveAmexCategory', () => {
  it('exact full-label matches win (Category-Subcategory)', () => {
    expect(resolveAmexCategory('Merchandise & Supplies-Groceries')).toBe('groceries')
    expect(resolveAmexCategory('Merchandise & Supplies-Wholesale Stores')).toBe('groceries')
  })

  it('falls back to the prefix before the first dash', () => {
    expect(resolveAmexCategory('Restaurant-Restaurant')).toBe('food_and_drink')
    expect(resolveAmexCategory('Restaurant-Bar & Café')).toBe('food_and_drink')
    expect(resolveAmexCategory('Fees & Adjustments-Fees')).toBe('bank_fees')
    expect(resolveAmexCategory('Travel-Airline')).toBe('travel')
    expect(resolveAmexCategory('Transportation-Taxis & Coach')).toBe('transportation')
    expect(resolveAmexCategory('Entertainment-General Attractions')).toBe('entertainment')
    expect(resolveAmexCategory('Communications-Cable & Internet Comm')).toBe('rent_and_utilities')
    expect(resolveAmexCategory('Business Services-Professional Services')).toBe('general_services')
    expect(resolveAmexCategory('Health Care-Pharmacies')).toBe('medical')
  })

  it('matches a bare prefix with no subcategory', () => {
    expect(resolveAmexCategory('Travel')).toBe('travel')
    expect(resolveAmexCategory('Restaurant')).toBe('food_and_drink')
  })

  it('returns null for unknown labels and unknown subcategory-only labels', () => {
    expect(resolveAmexCategory('Merchandise & Supplies-Internet Purchase')).toBeNull()
    expect(resolveAmexCategory('Other-Miscellaneous')).toBeNull()
    expect(resolveAmexCategory('')).toBeNull()
    expect(resolveAmexCategory('   ')).toBeNull()
  })

  it('every value in the map is a valid taxonomy id', () => {
    for (const [label, id] of Object.entries(AMEX_CATEGORY_MAP)) {
      expect(CATEGORY_IDS, `Amex ${label} → ${id}`).toContain(id)
    }
  })
})

describe('PLAID_PFC maps / resolvePlaidCategory', () => {
  it('maps all 16 PFC primaries to same-named lowercase taxonomy ids', () => {
    expect(Object.keys(PLAID_PFC_PRIMARY_MAP)).toHaveLength(16)
    for (const [primary, id] of Object.entries(PLAID_PFC_PRIMARY_MAP)) {
      expect(CATEGORY_IDS).toContain(id)
      expect(id).toBe(primary.toLowerCase()) // identity by construction
    }
    // no primary is a prefix of another — the detailed-prefix scan is unambiguous
    const primaries = Object.keys(PLAID_PFC_PRIMARY_MAP)
    for (const a of primaries) {
      for (const b of primaries) {
        if (a !== b) expect(b.startsWith(`${a}_`)).toBe(false)
      }
    }
  })

  it('detailed overrides map to valid taxonomy ids', () => {
    for (const id of Object.values(PLAID_PFC_DETAILED_MAP)) {
      expect(CATEGORY_IDS).toContain(id)
    }
  })

  it('FOOD_AND_DRINK_GROCERIES resolves to the promoted groceries category', () => {
    expect(resolvePlaidCategory('FOOD_AND_DRINK_GROCERIES')).toBe('groceries')
  })

  it('other detailed labels resolve via their primary prefix', () => {
    expect(resolvePlaidCategory('FOOD_AND_DRINK_COFFEE')).toBe('food_and_drink')
    expect(resolvePlaidCategory('INCOME_WAGES')).toBe('income')
    expect(resolvePlaidCategory('TRANSFER_OUT_ACCOUNT_TRANSFER')).toBe('transfer_out')
    expect(resolvePlaidCategory('TRANSFER_IN_DEPOSIT')).toBe('transfer_in')
  })

  it('bare primaries resolve directly (sourceCategory fallback when detailed is absent)', () => {
    expect(resolvePlaidCategory('TRAVEL')).toBe('travel')
    expect(resolvePlaidCategory('RENT_AND_UTILITIES')).toBe('rent_and_utilities')
  })

  it('unknown labels return null, never throw', () => {
    expect(resolvePlaidCategory('CRYPTO_YOLO')).toBeNull()
    expect(resolvePlaidCategory('')).toBeNull()
    expect(resolvePlaidCategory('  ')).toBeNull()
  })
})

describe('mapSourceCategory', () => {
  it('dispatches chase_csv labels to the Chase map (trims whitespace)', () => {
    expect(mapSourceCategory('chase_csv', 'Groceries')).toBe('groceries')
    expect(mapSourceCategory('chase_csv', ' Groceries ')).toBe('groceries')
    expect(mapSourceCategory('chase_csv', 'Bills & Utilities')).toBe('rent_and_utilities')
  })

  it('dispatches plaid PFC labels (detailed stored as sourceCategory)', () => {
    expect(mapSourceCategory('plaid', 'FOOD_AND_DRINK_GROCERIES')).toBe('groceries')
    expect(mapSourceCategory('plaid', 'FOOD_AND_DRINK_COFFEE')).toBe('food_and_drink')
    expect(mapSourceCategory('plaid', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')).toBe('loan_payments')
    expect(mapSourceCategory('plaid', 'GENERAL_MERCHANDISE')).toBe('general_merchandise')
    expect(mapSourceCategory('plaid', 'SOMETHING_NEW')).toBeNull()
    expect(getUnknownSourceLabels()).toEqual(['plaid:SOMETHING_NEW'])
  })

  it('dispatches teller labels case-insensitively', () => {
    expect(mapSourceCategory('teller', 'dining')).toBe('food_and_drink')
    expect(mapSourceCategory('teller', 'Dining')).toBe('food_and_drink')
    expect(mapSourceCategory('teller', ' groceries ')).toBe('groceries')
  })

  it('dispatches amex_csv labels through exact-then-prefix resolution', () => {
    expect(mapSourceCategory('amex_csv', 'Merchandise & Supplies-Groceries')).toBe('groceries')
    expect(mapSourceCategory('amex_csv', 'Restaurant-Restaurant')).toBe('food_and_drink')
  })

  it('never throws on unknown labels — returns null and records them', () => {
    expect(mapSourceCategory('teller', 'cryptocurrency')).toBeNull()
    expect(mapSourceCategory('chase_csv', 'Weird New Label')).toBeNull()
    expect(mapSourceCategory('amex_csv', 'Other-Miscellaneous')).toBeNull()
    expect(getUnknownSourceLabels()).toEqual([
      'amex_csv:Other-Miscellaneous',
      'chase_csv:Weird New Label',
      'teller:cryptocurrency',
    ])
  })

  it('handles garbage input without throwing', () => {
    expect(mapSourceCategory('teller', '🤷')).toBeNull()
    expect(mapSourceCategory('chase_csv', 'Robert"); DROP TABLE transactions;--')).toBeNull()
  })

  it('null and blank labels return null and are NOT recorded as unknown', () => {
    expect(mapSourceCategory('teller', null)).toBeNull()
    expect(mapSourceCategory('chase_csv', '')).toBeNull()
    expect(mapSourceCategory('amex_csv', '   ')).toBeNull()
    expect(getUnknownSourceLabels()).toEqual([])
  })

  it('clearUnknownSourceLabels resets the collector', () => {
    mapSourceCategory('teller', 'nope')
    expect(getUnknownSourceLabels()).toHaveLength(1)
    clearUnknownSourceLabels()
    expect(getUnknownSourceLabels()).toEqual([])
  })
})

describe('fixture-driven mapping', () => {
  it('every Category value in the chase_credit.csv fixture maps to a taxonomy id', () => {
    const lines = fixture('csv/chase_credit.csv').trim().split('\n').slice(1)
    const labels = lines
      .map((line) => line.split(',')[3] ?? '')
      .filter((label) => label !== '')
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) {
      const mapped = mapSourceCategory('chase_csv', label)
      expect(mapped, `fixture Chase label ${label}`).not.toBeNull()
      expect(CATEGORY_IDS).toContain(mapped)
    }
  })

  it('every details.category in the teller fixture maps to a taxonomy id', () => {
    const txns = JSON.parse(fixture('teller/transactions_chase_cc.json')) as Array<{
      details: { category: string | null }
    }>
    const labels = txns.map((t) => t.details.category).filter((c): c is string => c !== null)
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) {
      const mapped = mapSourceCategory('teller', label)
      expect(mapped, `fixture Teller label ${label}`).not.toBeNull()
      expect(CATEGORY_IDS).toContain(mapped)
    }
  })
})
