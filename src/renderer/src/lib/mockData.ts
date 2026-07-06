/**
 * Seed data for the in-memory MockApi: 2 accounts, ~35 transactions across
 * the last 3 months, a review queue, settings. Months are computed relative
 * to the real clock so the demo dashboard always has current data.
 *
 * CATEGORY_MIRROR duplicates src/main/core/categorize/taxonomy.ts on purpose:
 * the renderer must not import main-process modules across the IPC boundary
 * (plan §3 invariant 2). In production the list arrives via api.listCategories.
 */
import type { AccountDto, CategoryDto, ReviewItem, SettingsDto, TransactionDto } from '../../../shared/types'
import { addMonths, currentMonth } from './format'

type Mirror = readonly [
  id: string,
  pfcCode: string,
  name: string,
  isIncome: 0 | 1,
  excludedFromSpend: 0 | 1,
  sortOrder: number,
]

const MIRROR: readonly Mirror[] = [
  ['income', 'INCOME', 'Income', 1, 0, 1],
  ['transfer_in', 'TRANSFER_IN', 'Transfer In', 0, 1, 2],
  ['transfer_out', 'TRANSFER_OUT', 'Transfer Out', 0, 1, 3],
  ['loan_payments', 'LOAN_PAYMENTS', 'Card & Loan Payments', 0, 1, 4],
  ['bank_fees', 'BANK_FEES', 'Bank Fees', 0, 0, 5],
  ['entertainment', 'ENTERTAINMENT', 'Entertainment', 0, 0, 6],
  ['food_and_drink', 'FOOD_AND_DRINK', 'Dining & Drinks', 0, 0, 7],
  ['general_merchandise', 'GENERAL_MERCHANDISE', 'Shopping', 0, 0, 8],
  ['home_improvement', 'HOME_IMPROVEMENT', 'Home', 0, 0, 9],
  ['medical', 'MEDICAL', 'Health & Medical', 0, 0, 10],
  ['personal_care', 'PERSONAL_CARE', 'Personal Care', 0, 0, 11],
  ['general_services', 'GENERAL_SERVICES', 'Services', 0, 0, 12],
  ['government_and_non_profit', 'GOVERNMENT_AND_NON_PROFIT', 'Government & Charity', 0, 0, 13],
  ['transportation', 'TRANSPORTATION', 'Transport', 0, 0, 14],
  ['travel', 'TRAVEL', 'Travel', 0, 0, 15],
  ['rent_and_utilities', 'RENT_AND_UTILITIES', 'Rent & Utilities', 0, 0, 16],
  ['groceries', 'FOOD_AND_DRINK', 'Groceries', 0, 0, 6.5],
  ['uncategorized', 'GENERAL_MERCHANDISE', 'Uncategorized', 0, 0, 99],
]

export const MOCK_CATEGORIES: readonly CategoryDto[] = MIRROR.map(
  ([id, pfcCode, name, isIncome, excludedFromSpend, sortOrder]) => ({
    id,
    name,
    pfcCode,
    parentId: null,
    isIncome: isIncome === 1,
    excludedFromSpend: excludedFromSpend === 1,
    sortOrder,
  }),
)

export function seedAccounts(): AccountDto[] {
  return [
    {
      id: 'acct-checking',
      name: 'Chase Total Checking',
      institution: 'chase',
      sourceKind: 'teller',
      tellerAccountId: 'acc_mock_chk_001',
      tellerEnrollmentId: 'enr_mock_001',
      mask: '4523',
      type: 'depository',
      subtype: 'checking',
      status: 'ok',
      closed: false,
      balanceCents: 342211,
      lastSyncAt: null,
    },
    {
      id: 'acct-amex',
      name: 'Amex Gold',
      institution: 'amex',
      sourceKind: 'teller',
      tellerAccountId: 'acc_mock_amx_001',
      tellerEnrollmentId: 'enr_mock_002',
      mask: '1005',
      type: 'credit',
      subtype: 'credit_card',
      status: 'reconnect_required',
      closed: false,
      balanceCents: -184230,
      lastSyncAt: null,
    },
  ]
}

interface SeedRow {
  accountId: string
  day: string
  amountCents: number
  payee: string
  rawDescription: string
  categoryId: string
  categorySource: TransactionDto['categorySource']
}

/** One month's worth of recurring activity (11 rows). */
const MONTHLY: readonly SeedRow[] = [
  // checking
  { accountId: 'acct-checking', day: '27', amountCents: 250000, payee: 'Acme Corp', rawDescription: 'ORIG CO NAME:ACME CORP           CO ENTRY DESCR:PAYROLL', categoryId: 'income', categorySource: 'rule' },
  { accountId: 'acct-checking', day: '01', amountCents: -165000, payee: 'City Properties', rawDescription: 'CITY PROPERTIES LLC RENT PAYMENT', categoryId: 'rent_and_utilities', categorySource: 'cache' },
  { accountId: 'acct-checking', day: '15', amountCents: -84355, payee: 'Amex ePayment', rawDescription: 'AMEX EPAYMENT    ACH PMT    M1234 WEB ID: 9493560001', categoryId: 'loan_payments', categorySource: 'rule' },
  // amex card
  { accountId: 'acct-amex', day: '16', amountCents: 84355, payee: 'Amex Payment Received', rawDescription: 'AUTOPAY PAYMENT RECEIVED - THANK YOU', categoryId: 'loan_payments', categorySource: 'rule' },
  { accountId: 'acct-amex', day: '03', amountCents: -8710, payee: 'Whole Foods Market', rawDescription: 'WHOLE FOODS MARKET SEATTLE WA', categoryId: 'groceries', categorySource: 'cache' },
  { accountId: 'acct-amex', day: '18', amountCents: -5423, payee: "Trader Joe's", rawDescription: "TRADER JOE'S #552 SEATTLE WA", categoryId: 'groceries', categorySource: 'cache' },
  { accountId: 'acct-amex', day: '05', amountCents: -675, payee: 'Coffee House', rawDescription: 'TST* COFFEE HOUSE 0042 SEATTLE WA', categoryId: 'food_and_drink', categorySource: 'cache' },
  { accountId: 'acct-amex', day: '12', amountCents: -2845, payee: 'DoorDash', rawDescription: 'DD *DOORDASH BURGERPL 6505553801 CA', categoryId: 'food_and_drink', categorySource: 'llm' },
  { accountId: 'acct-amex', day: '08', amountCents: -1599, payee: 'Netflix', rawDescription: 'NETFLIX.COM 866-579-7172 CA', categoryId: 'entertainment', categorySource: 'source' },
  { accountId: 'acct-amex', day: '20', amountCents: -1834, payee: 'Uber', rawDescription: 'UBER TRIP HELP.UBER.COM CA', categoryId: 'transportation', categorySource: 'llm' },
  { accountId: 'acct-amex', day: '22', amountCents: -4599, payee: 'Amazon', rawDescription: 'AMZN Mktp US*RT4Y66TR3 Amzn.com/bill WA', categoryId: 'general_merchandise', categorySource: 'llm' },
]

export interface MockSeed {
  transactions: TransactionDto[]
  reviewItems: ReviewItem[]
}

export function seedTransactions(): MockSeed {
  const m0 = currentMonth()
  const m1 = addMonths(m0, -1)
  const m2 = addMonths(m0, -2)
  const categoryName = (id: string): string => MOCK_CATEGORIES.find((c) => c.id === id)?.name ?? id

  let n = 0
  const make = (month: string, row: SeedRow, overrides?: Partial<TransactionDto>): TransactionDto => {
    n += 1
    return {
      id: `mock-txn-${String(n).padStart(3, '0')}`,
      accountId: row.accountId,
      source: 'teller',
      externalId: `txn_mock_${String(n).padStart(3, '0')}`,
      txnDate: `${month}-${row.day}`,
      postDate: `${month}-${row.day}`,
      amountCents: row.amountCents,
      status: 'posted',
      payee: row.payee,
      rawDescription: row.rawDescription,
      categoryId: row.categoryId,
      categoryName: categoryName(row.categoryId),
      categorySource: row.categorySource,
      sourceCategory: null,
      notes: null,
      ...overrides,
    }
  }

  const transactions: TransactionDto[] = []
  for (const month of [m2, m1, m0]) {
    for (const row of MONTHLY) {
      // Current month: two card charges still pending (dashboard badge demo).
      const pending = month === m0 && (row.payee === 'Uber' || row.payee === 'DoorDash')
      transactions.push(make(month, row, pending ? { status: 'pending', postDate: null } : undefined))
    }
  }
  // M2: a leaked checking-side autopay with no card-side counterpart —
  // makes the §5d payments-integrity banner reproducible in the demo.
  transactions.push(
    make(m2, {
      accountId: 'acct-checking',
      day: '28',
      amountCents: -21500,
      payee: 'Chase Card Autopay',
      rawDescription: 'CHASE CREDIT CRD AUTOPAY                    PPD ID: 4760039224',
      categoryId: 'loan_payments',
      categorySource: 'rule',
    }),
  )
  // M1: a refund that nets against its category (spend definition §4).
  transactions.push(
    make(m1, {
      accountId: 'acct-amex',
      day: '25',
      amountCents: 1299,
      payee: 'Amazon',
      rawDescription: 'AMZN Mktp US*REFUND Amzn.com/bill WA',
      categoryId: 'general_merchandise',
      categorySource: 'cache',
    }),
  )

  const byPayee = (payee: string, month: string): TransactionDto => {
    const txn = transactions.find((t) => t.payee === payee && t.txnDate.startsWith(month))
    if (!txn) throw new Error(`Mock seed inconsistent: no ${payee} txn in ${month}`)
    return txn
  }
  const doordash = byPayee('DoorDash', m0)
  const amazon = byPayee('Amazon', m0)
  const reviewItems: ReviewItem[] = [
    {
      txnId: doordash.id,
      payee: doordash.payee,
      rawDescription: doordash.rawDescription,
      amountCents: doordash.amountCents,
      txnDate: doordash.txnDate,
      suggestedCategoryId: 'food_and_drink',
      confidence: 0.62,
    },
    {
      txnId: amazon.id,
      payee: amazon.payee,
      rawDescription: amazon.rawDescription,
      amountCents: amazon.amountCents,
      txnDate: amazon.txnDate,
      suggestedCategoryId: 'general_merchandise',
      confidence: 0.55,
    },
  ]

  return { transactions, reviewItems }
}

export function seedSettings(): SettingsDto {
  return {
    tellerEnv: 'sandbox',
    syncIntervalHours: 8,
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'qwen3:8b',
    enrollmentsUsed: 2,
  }
}
