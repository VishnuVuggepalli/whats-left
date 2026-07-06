import type { Source } from '../../../shared/types'
import type { CategoryId } from './taxonomy'

/**
 * Tier-3 static source-label → taxonomy maps (plan §6 tier 3, §2 taxonomy row).
 * Unknown labels NEVER throw — they return null so the caller routes the row
 * to the review queue (plan §5a fail-loud-to-review). Unknowns are recorded in
 * a collector so sync/import can surface "bank sent a label we don't know".
 */

/** Chase credit CSV's 16 native Category values (plan §5b). */
export const CHASE_CATEGORY_MAP: Readonly<Record<string, CategoryId>> = {
  Automotive: 'transportation',
  'Bills & Utilities': 'rent_and_utilities',
  Education: 'general_services',
  Entertainment: 'entertainment',
  'Fees & Adjustments': 'bank_fees',
  'Food & Drink': 'food_and_drink',
  Gas: 'transportation',
  'Gifts & Donations': 'government_and_non_profit',
  Groceries: 'groceries',
  'Health & Wellness': 'medical',
  Home: 'home_improvement',
  Miscellaneous: 'general_merchandise',
  Personal: 'personal_care',
  'Professional Services': 'general_services',
  Shopping: 'general_merchandise',
  Travel: 'travel',
}

/**
 * Teller's 28-value details.category enum (plan §5a) — EXACTLY these; the enum
 * really contains BOTH `transport` and `transportation`.
 */
export const TELLER_CATEGORY_MAP: Readonly<Record<string, CategoryId>> = {
  accommodation: 'travel',
  advertising: 'general_services',
  bar: 'food_and_drink',
  charity: 'government_and_non_profit',
  clothing: 'general_merchandise',
  dining: 'food_and_drink',
  education: 'general_services',
  electronics: 'general_merchandise',
  entertainment: 'entertainment',
  fuel: 'transportation',
  general: 'general_merchandise',
  groceries: 'groceries',
  health: 'medical',
  home: 'home_improvement',
  income: 'income',
  insurance: 'general_services',
  investment: 'transfer_out',
  loan: 'loan_payments',
  office: 'general_merchandise',
  phone: 'rent_and_utilities',
  service: 'general_services',
  shopping: 'general_merchandise',
  software: 'general_services',
  sport: 'entertainment',
  tax: 'government_and_non_profit',
  transport: 'transportation',
  transportation: 'transportation',
  utilities: 'rent_and_utilities',
}

/**
 * Amex CSV Category values ('Category-Subcategory'). Keys are either full
 * labels (exact match wins) or the part before the first '-' (prefix
 * fallback). Only labels observed in fixtures are mapped — anything else is
 * null → review queue, deliberately, to avoid cache poisoning.
 */
export const AMEX_CATEGORY_MAP: Readonly<Record<string, CategoryId>> = {
  // exact full labels
  'Merchandise & Supplies-Groceries': 'groceries',
  'Merchandise & Supplies-Wholesale Stores': 'groceries',
  // prefixes (part before the first '-')
  Restaurant: 'food_and_drink',
  'Fees & Adjustments': 'bank_fees',
  Travel: 'travel',
  Transportation: 'transportation',
  Entertainment: 'entertainment',
  Communications: 'rent_and_utilities',
  'Business Services': 'general_services',
  'Health Care': 'medical',
}

/**
 * Plaid PFC primary → taxonomy: identity by construction — the taxonomy IS the
 * PFC 16 primaries with lowercase ids (plan §2). Detailed overrides promote
 * app-local categories (groceries).
 */
export const PLAID_PFC_PRIMARY_MAP: Readonly<Record<string, CategoryId>> = {
  INCOME: 'income',
  TRANSFER_IN: 'transfer_in',
  TRANSFER_OUT: 'transfer_out',
  LOAN_PAYMENTS: 'loan_payments',
  BANK_FEES: 'bank_fees',
  ENTERTAINMENT: 'entertainment',
  FOOD_AND_DRINK: 'food_and_drink',
  GENERAL_MERCHANDISE: 'general_merchandise',
  HOME_IMPROVEMENT: 'home_improvement',
  MEDICAL: 'medical',
  PERSONAL_CARE: 'personal_care',
  GENERAL_SERVICES: 'general_services',
  GOVERNMENT_AND_NON_PROFIT: 'government_and_non_profit',
  TRANSPORTATION: 'transportation',
  TRAVEL: 'travel',
  RENT_AND_UTILITIES: 'rent_and_utilities',
}

/** detailed PFC values that beat their primary (app-local promotions) */
export const PLAID_PFC_DETAILED_MAP: Readonly<Record<string, CategoryId>> = {
  FOOD_AND_DRINK_GROCERIES: 'groceries',
}

/**
 * Plaid stores the PFC detailed string (or the primary) as sourceCategory.
 * Resolution: detailed override → exact primary → primary prefix of a
 * detailed label ('FOOD_AND_DRINK_COFFEE' → food_and_drink). No PFC primary
 * is a prefix of another, so the prefix scan is unambiguous.
 */
export function resolvePlaidCategory(label: string): CategoryId | null {
  const trimmed = label.trim()
  if (trimmed === '') return null
  const detailed = PLAID_PFC_DETAILED_MAP[trimmed]
  if (detailed !== undefined) return detailed
  const exact = PLAID_PFC_PRIMARY_MAP[trimmed]
  if (exact !== undefined) return exact
  for (const [primary, id] of Object.entries(PLAID_PFC_PRIMARY_MAP)) {
    if (trimmed.startsWith(`${primary}_`)) return id
  }
  return null
}

/** Exact-then-prefix resolution for Amex 'Category-Subcategory' labels. */
export function resolveAmexCategory(label: string): CategoryId | null {
  const trimmed = label.trim()
  if (trimmed === '') return null
  const exact = AMEX_CATEGORY_MAP[trimmed]
  if (exact !== undefined) return exact
  const dashIdx = trimmed.indexOf('-')
  if (dashIdx <= 0) return null
  const prefix = trimmed.slice(0, dashIdx).trim()
  return AMEX_CATEGORY_MAP[prefix] ?? null
}

/** diagnostics collector: `${source}:${label}` for every unmapped label seen */
const unknownLabelSet = new Set<string>()

export function getUnknownSourceLabels(): readonly string[] {
  return [...unknownLabelSet].sort()
}

export function clearUnknownSourceLabels(): void {
  unknownLabelSet.clear()
}

/**
 * Map a bank-provided category label to a taxonomy id.
 * Unknown label → null (caller routes to review) + recorded in the collector.
 * Never throws — bank label drift must not kill an import (plan §5b).
 */
export function mapSourceCategory(source: Source, label: string | null): CategoryId | null {
  if (label === null) return null
  const trimmed = label.trim()
  if (trimmed === '') return null

  let mapped: CategoryId | null
  switch (source) {
    case 'plaid':
      mapped = resolvePlaidCategory(trimmed)
      break
    case 'teller':
      mapped = TELLER_CATEGORY_MAP[trimmed.toLowerCase()] ?? null
      break
    case 'chase_csv':
      mapped = CHASE_CATEGORY_MAP[trimmed] ?? null
      break
    case 'amex_csv':
      mapped = resolveAmexCategory(trimmed)
      break
    default:
      return assertNever(source)
  }

  if (mapped === null) unknownLabelSet.add(`${source}:${trimmed}`)
  return mapped
}

function assertNever(x: never): never {
  throw new Error(`Unhandled source: ${JSON.stringify(x)}`)
}
