/**
 * Shared domain types — the frozen contract between main, preload, and renderer.
 *
 * Conventions (see docs/PLAN.md):
 * - Amounts are signed integer cents. Negative = money out, positive = money in.
 * - Dates are opaque 'YYYY-MM-DD' strings end-to-end. Never construct a JS Date
 *   from a date-only string (UTC-midnight parsing shifts it a day in US timezones).
 */

export type Source = 'plaid' | 'teller' | 'chase_csv' | 'amex_csv'
export type TxnStatus = 'posted' | 'pending'
export type CategorySource = 'user' | 'rule' | 'cache' | 'source' | 'llm'
export type Institution = 'chase' | 'amex' | 'other'
export type AccountType = 'depository' | 'credit'
export type AccountStatus = 'ok' | 'reconnect_required' | 'error'
export type TellerEnv = 'sandbox' | 'development'

/** 'YYYY-MM-DD'. Branded to discourage Date round-trips. */
export type IsoDate = string

export interface AccountDto {
  id: string
  name: string
  institution: Institution
  sourceKind: 'teller' | 'csv_only'
  tellerAccountId: string | null
  tellerEnrollmentId: string | null
  /**
   * Bank-feed environment the account was enrolled in ('sandbox' |
   * 'production' for Plaid); null for csv_only accounts and legacy feed rows
   * awaiting backfill. Accounts whose feedEnv differs from the active
   * Settings.plaidEnv can never sync (INVALID_API_KEYS) — syncNow skips them
   * and the Accounts screen badges them instead.
   */
  feedEnv: 'sandbox' | 'production' | null
  mask: string | null
  type: AccountType
  subtype: string | null
  status: AccountStatus
  closed: boolean
  balanceCents: number | null
  lastSyncAt: string | null
}

/**
 * A transaction produced by any source (CSV importer or Teller sync) before
 * persistence/reconciliation.
 *
 * externalId: BANK-ISSUED id only (Teller txn id, Amex Reference). Null for
 * hash-only CSV rows. Synthesized hashes are NEVER ids — they live in importHash.
 */
export interface TxnDraft {
  source: Source
  externalId: string | null
  importHash: string
  txnDate: IsoDate
  postDate: IsoDate | null
  amountCents: number
  status: TxnStatus
  rawDescription: string
  /** cleaned display payee (post-normalizer) */
  importedPayee: string
  /** bank-provided category label, verbatim (Chase 16 / Amex / Teller 28) */
  sourceCategory: string | null
  /** Teller details.counterparty.name when present */
  counterparty: string | null
  /** machine type code: Chase checking Type, Chase credit Type, Teller type */
  typeCode: string | null
}

export interface TransactionDto {
  id: string
  accountId: string
  source: Source
  externalId: string | null
  txnDate: IsoDate
  postDate: IsoDate | null
  amountCents: number
  status: TxnStatus
  payee: string
  rawDescription: string
  categoryId: string | null
  categoryName: string | null
  categorySource: CategorySource | null
  sourceCategory: string | null
  notes: string | null
}

export interface CategoryDto {
  id: string
  name: string
  pfcCode: string
  parentId: string | null
  isIncome: boolean
  /** transfers / loan payments: never counted as spend */
  excludedFromSpend: boolean
  sortOrder: number
}

export interface TxnQuery {
  accountId?: string
  categoryId?: string
  from?: IsoDate
  to?: IsoDate
  text?: string
  status?: TxnStatus
  limit?: number
  offset?: number
}

export interface ImportReport {
  accountId: string
  accountName: string
  format: 'chase_checking' | 'chase_credit' | 'amex_extended' | 'amex_basic'
  parsed: number
  newCount: number
  matchedCount: number
  skippedDuplicates: number
  /** committed rows the categorizer could not resolve (visible in Review) */
  uncategorized: number
  warnings: string[]
  committed: boolean
}

export interface SyncReport {
  ranAt: string
  accounts: Array<{
    accountId: string
    fetched: number
    inserted: number
    matched: number
    gcPending: number
    /** fetched rows left without a category after the resolver + LLM tiers */
    uncategorized: number
    /** non-fatal anomaly (e.g. rows swallowed by a cross-account id collision) */
    warning: string | null
    error: string | null
  }>
}

export interface DashboardData {
  month: string // 'YYYY-MM'
  byCategory: Array<{
    categoryId: string
    categoryName: string
    netCents: number // negative = net spend
  }>
  trend: Array<{ month: string; spendCents: number; incomeCents: number }>
  topMerchants: Array<{ payee: string; netCents: number; count: number }>
  pendingCents: number
  /** §5d integrity check: card payments seen from checking vs received on cards */
  paymentsIntegrity: {
    checkingSideCents: number
    cardSideCents: number
    diverges: boolean
  }
}

export interface ReviewItem {
  txnId: string
  payee: string
  rawDescription: string
  amountCents: number
  txnDate: IsoDate
  suggestedCategoryId: string
  confidence: number
}

export interface RecategorizeInput {
  txnId: string
  categoryId: string
  /** 'txn' = this transaction only; 'merchant' = locked cache row for merchant */
  scope: 'txn' | 'merchant'
  /** with scope='merchant': also update existing rows not categorized by user */
  applyToExisting?: boolean
}

export interface EnrollmentResult {
  ok: boolean
  enrollmentId?: string
  institution?: string
  accountsAdded?: number
  error?: string
}

export type PlaidEnv = 'sandbox' | 'production'

export interface SettingsDto {
  /** primary bank feed provider */
  provider: 'plaid' | 'teller'
  tellerEnv: TellerEnv
  plaidEnv: PlaidEnv
  /** Plaid client id (safe to display); secret is write-only via updateSettings */
  plaidClientId: string | null
  /** true when a Plaid secret is stored (the secret itself is never returned) */
  plaidSecretSet: boolean
  syncIntervalHours: number
  ollamaUrl: string
  ollamaModel: string
  /** Teller dev-env lifetime enrollments used (100 cap) */
  enrollmentsUsed: number | null
  /** Plaid lifetime Production Items used (10 cap on Trial plan) */
  plaidItemsUsed: number | null
}

/** patch shape for updateSettings — includes the write-only Plaid secret */
export interface SettingsPatch extends Partial<Omit<SettingsDto, 'plaidSecretSet'>> {
  plaidSecret?: string
}
