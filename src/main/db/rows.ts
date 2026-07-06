import type {
  AccountDto,
  AccountStatus,
  AccountType,
  CategoryDto,
  CategorySource,
  Institution,
  Source,
  TransactionDto,
  TxnStatus,
} from '../../shared/types'
import type { ExistingTxn } from '../core/ports'

/** raw snake_case row shapes as returned by better-sqlite3, plus pure mappers */

export interface AccountRow {
  id: string
  name: string
  institution: Institution
  source_kind: 'teller' | 'csv_only'
  teller_account_id: string | null
  teller_enrollment_id: string | null
  mask: string | null
  type: AccountType
  subtype: string | null
  status: AccountStatus
  balance_cents: number | null
  last_sync_at: string | null
  closed: number
  tombstone: number
}

export interface TxnRow {
  id: string
  account_id: string
  source: Source
  external_id: string | null
  import_hash: string
  linked_source_id: string | null
  txn_date: string
  post_date: string | null
  amount_cents: number
  status: TxnStatus
  payee_id: string | null
  imported_payee: string
  raw_description: string
  category_id: string | null
  source_category: string | null
  category_source: CategorySource | null
  llm_confidence: number | null
  notes: string | null
  reconciled: number
  tombstone: number
}

export interface CategoryRow {
  id: string
  name: string
  pfc_code: string
  parent_id: string | null
  is_income: number
  excluded_from_spend: number
  sort_order: number
}

export function mapAccount(row: AccountRow): AccountDto {
  return {
    id: row.id,
    name: row.name,
    institution: row.institution,
    sourceKind: row.source_kind,
    tellerAccountId: row.teller_account_id,
    tellerEnrollmentId: row.teller_enrollment_id,
    mask: row.mask,
    type: row.type,
    subtype: row.subtype,
    status: row.status,
    closed: row.closed === 1,
    balanceCents: row.balance_cents,
    lastSyncAt: row.last_sync_at,
  }
}

export function mapExisting(row: TxnRow): ExistingTxn {
  return {
    id: row.id,
    accountId: row.account_id,
    source: row.source,
    externalId: row.external_id,
    importHash: row.import_hash,
    txnDate: row.txn_date,
    postDate: row.post_date,
    amountCents: row.amount_cents,
    status: row.status,
    // normalizedPayee = imported_payee for now (normalizer identity in v1 repo reads)
    normalizedPayee: row.imported_payee,
    categorySource: row.category_source,
  }
}

export function mapTransaction(row: TxnRow & { category_name: string | null }): TransactionDto {
  return {
    id: row.id,
    accountId: row.account_id,
    source: row.source,
    externalId: row.external_id,
    txnDate: row.txn_date,
    postDate: row.post_date,
    amountCents: row.amount_cents,
    status: row.status,
    payee: row.imported_payee,
    rawDescription: row.raw_description,
    categoryId: row.category_id,
    categoryName: row.category_name,
    categorySource: row.category_source,
    sourceCategory: row.source_category,
    notes: row.notes,
  }
}

export function mapCategory(row: CategoryRow): CategoryDto {
  return {
    id: row.id,
    name: row.name,
    pfcCode: row.pfc_code,
    parentId: row.parent_id,
    isIncome: row.is_income === 1,
    excludedFromSpend: row.excluded_from_spend === 1,
    sortOrder: row.sort_order,
  }
}
