/**
 * Canonical taxonomy: Plaid PFC 16 primaries as stable ids, friendly display
 * names on top (plan §2). Transfers/loan payments are excluded from spend by
 * flag — the #1 cause of garbage "how much did I spend" numbers.
 */

export interface TaxonomyEntry {
  id: string // stable app id == lowercase pfc code
  pfcCode: string
  name: string // friendly display name
  isIncome: boolean
  excludedFromSpend: boolean
  sortOrder: number
}

export const TAXONOMY: readonly TaxonomyEntry[] = [
  { id: 'income', pfcCode: 'INCOME', name: 'Income', isIncome: true, excludedFromSpend: false, sortOrder: 1 },
  { id: 'transfer_in', pfcCode: 'TRANSFER_IN', name: 'Transfer In', isIncome: false, excludedFromSpend: true, sortOrder: 2 },
  { id: 'transfer_out', pfcCode: 'TRANSFER_OUT', name: 'Transfer Out', isIncome: false, excludedFromSpend: true, sortOrder: 3 },
  { id: 'loan_payments', pfcCode: 'LOAN_PAYMENTS', name: 'Card & Loan Payments', isIncome: false, excludedFromSpend: true, sortOrder: 4 },
  { id: 'bank_fees', pfcCode: 'BANK_FEES', name: 'Bank Fees', isIncome: false, excludedFromSpend: false, sortOrder: 5 },
  { id: 'entertainment', pfcCode: 'ENTERTAINMENT', name: 'Entertainment', isIncome: false, excludedFromSpend: false, sortOrder: 6 },
  { id: 'food_and_drink', pfcCode: 'FOOD_AND_DRINK', name: 'Dining & Drinks', isIncome: false, excludedFromSpend: false, sortOrder: 7 },
  { id: 'general_merchandise', pfcCode: 'GENERAL_MERCHANDISE', name: 'Shopping', isIncome: false, excludedFromSpend: false, sortOrder: 8 },
  { id: 'home_improvement', pfcCode: 'HOME_IMPROVEMENT', name: 'Home', isIncome: false, excludedFromSpend: false, sortOrder: 9 },
  { id: 'medical', pfcCode: 'MEDICAL', name: 'Health & Medical', isIncome: false, excludedFromSpend: false, sortOrder: 10 },
  { id: 'personal_care', pfcCode: 'PERSONAL_CARE', name: 'Personal Care', isIncome: false, excludedFromSpend: false, sortOrder: 11 },
  { id: 'general_services', pfcCode: 'GENERAL_SERVICES', name: 'Services', isIncome: false, excludedFromSpend: false, sortOrder: 12 },
  { id: 'government_and_non_profit', pfcCode: 'GOVERNMENT_AND_NON_PROFIT', name: 'Government & Charity', isIncome: false, excludedFromSpend: false, sortOrder: 13 },
  { id: 'transportation', pfcCode: 'TRANSPORTATION', name: 'Transport', isIncome: false, excludedFromSpend: false, sortOrder: 14 },
  { id: 'travel', pfcCode: 'TRAVEL', name: 'Travel', isIncome: false, excludedFromSpend: false, sortOrder: 15 },
  { id: 'rent_and_utilities', pfcCode: 'RENT_AND_UTILITIES', name: 'Rent & Utilities', isIncome: false, excludedFromSpend: false, sortOrder: 16 },
  // App-local additions (not PFC): promoted because people actually track them.
  { id: 'groceries', pfcCode: 'FOOD_AND_DRINK', name: 'Groceries', isIncome: false, excludedFromSpend: false, sortOrder: 6.5 },
  { id: 'uncategorized', pfcCode: 'GENERAL_MERCHANDISE', name: 'Uncategorized', isIncome: false, excludedFromSpend: false, sortOrder: 99 },
] as const

export const CATEGORY_IDS = TAXONOMY.map((t) => t.id)
export type CategoryId = (typeof TAXONOMY)[number]['id']

export function categoryById(id: string): TaxonomyEntry | undefined {
  return TAXONOMY.find((t) => t.id === id)
}
