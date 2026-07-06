import { randomUUID } from 'node:crypto'
import type { TxnDraft } from '../../shared/types'
import { openDb, runMigrations, type Db } from './db'
import { seedTaxonomy } from './seed'
import { SqliteRepo } from './repository'

/**
 * Test-only helpers (not part of the shipped API). Colocated so db tests can
 * seed in-memory databases without duplicating raw-SQL boilerplate.
 */

export function makeDb(): Db {
  const db = openDb(':memory:')
  runMigrations(db)
  seedTaxonomy(db)
  return db
}

export function makeRepo(): { db: Db; repo: SqliteRepo } {
  const db = makeDb()
  return { db, repo: new SqliteRepo(db) }
}

export interface AccountSeed {
  id?: string
  name?: string
  institution?: 'chase' | 'amex'
  sourceKind?: 'teller' | 'csv_only'
  type?: 'depository' | 'credit'
  mask?: string | null
}

export function insertAccount(db: Db, seed: AccountSeed = {}): string {
  const id = seed.id ?? randomUUID()
  db.prepare(
    `INSERT INTO accounts (id, name, institution, source_kind, type, mask)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    seed.name ?? 'Test Account',
    seed.institution ?? 'chase',
    seed.sourceKind ?? 'csv_only',
    seed.type ?? 'credit',
    seed.mask ?? null,
  )
  return id
}

export interface TxnSeed {
  id?: string
  source?: 'teller' | 'chase_csv' | 'amex_csv'
  externalId?: string | null
  importHash?: string
  txnDate?: string
  postDate?: string | null
  amountCents?: number
  status?: 'posted' | 'pending'
  importedPayee?: string
  rawDescription?: string
  categoryId?: string | null
  sourceCategory?: string | null
  categorySource?: 'user' | 'rule' | 'cache' | 'source' | 'llm' | null
  llmConfidence?: number | null
  notes?: string | null
}

export function insertTxn(db: Db, accountId: string, seed: TxnSeed = {}): string {
  const id = seed.id ?? randomUUID()
  db.prepare(
    `INSERT INTO transactions
       (id, account_id, source, external_id, import_hash, txn_date, post_date, amount_cents,
        status, imported_payee, raw_description, category_id, source_category, category_source,
        llm_confidence, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    accountId,
    seed.source ?? 'chase_csv',
    seed.externalId ?? null,
    seed.importHash ?? randomUUID(),
    seed.txnDate ?? '2026-06-01',
    seed.postDate ?? null,
    seed.amountCents ?? -1000,
    seed.status ?? 'posted',
    seed.importedPayee ?? 'Test Payee',
    seed.rawDescription ?? 'TEST RAW DESCRIPTION',
    seed.categoryId ?? null,
    seed.sourceCategory ?? null,
    seed.categorySource ?? null,
    seed.llmConfidence ?? null,
    seed.notes ?? null,
  )
  return id
}

export function draft(overrides: Partial<TxnDraft> = {}): TxnDraft {
  return {
    source: 'chase_csv',
    externalId: null,
    importHash: randomUUID(),
    txnDate: '2026-06-05',
    postDate: null,
    amountCents: -1234,
    status: 'posted',
    rawDescription: 'RAW DESC',
    importedPayee: 'Some Merchant',
    sourceCategory: null,
    counterparty: null,
    typeCode: null,
    ...overrides,
  }
}

/** raw row fetch for assertions */
export function getTxnRow(db: Db, id: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  if (!row) throw new Error(`test: no transaction row ${id}`)
  return row
}
