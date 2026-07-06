import type {
  CategorySource,
  RecategorizeInput,
  ReviewItem,
  Source,
  TransactionDto,
  TxnQuery,
  TxnStatus,
} from '../../shared/types'
import { isIsoDate } from '../core/dates'
import type { Db } from './db'
import { mapTransaction, type TxnRow } from './rows'

/** LLM categorizations below this confidence land in the review queue */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.7
const DEFAULT_PAGE_LIMIT = 100

const CATEGORY_SOURCES: readonly CategorySource[] = ['user', 'rule', 'cache', 'source', 'llm']

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function assertIsoDate(value: string, field: string): void {
  if (!isIsoDate(value)) {
    throw new Error(`listTransactions: ${field} must be a YYYY-MM-DD date, got ${JSON.stringify(value)}`)
  }
}

export function listTransactions(
  db: Db,
  query: TxnQuery,
): { rows: TransactionDto[]; total: number } {
  const clauses: string[] = ['t.tombstone = 0']
  const params: unknown[] = []

  if (query.accountId !== undefined) {
    clauses.push('t.account_id = ?')
    params.push(query.accountId)
  }
  if (query.categoryId !== undefined) {
    clauses.push('t.category_id = ?')
    params.push(query.categoryId)
  }
  if (query.from !== undefined) {
    assertIsoDate(query.from, 'from')
    clauses.push('t.txn_date >= ?')
    params.push(query.from)
  }
  if (query.to !== undefined) {
    assertIsoDate(query.to, 'to')
    clauses.push('t.txn_date <= ?')
    params.push(query.to)
  }
  if (query.status !== undefined) {
    clauses.push('t.status = ?')
    params.push(query.status)
  }
  if (query.text !== undefined && query.text !== '') {
    clauses.push(`(t.imported_payee LIKE ? ESCAPE '\\' OR t.raw_description LIKE ? ESCAPE '\\')`)
    const pattern = `%${escapeLike(query.text)}%`
    params.push(pattern, pattern)
  }

  const limit = query.limit ?? DEFAULT_PAGE_LIMIT
  const offset = query.offset ?? 0
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`listTransactions: limit must be a positive integer, got ${limit}`)
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`listTransactions: offset must be a non-negative integer, got ${offset}`)
  }

  const where = clauses.join(' AND ')
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM transactions t WHERE ${where}`)
    .get(...params) as { n: number }
  const rows = db
    .prepare(
      `SELECT t.*, c.name AS category_name
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE ${where}
       ORDER BY t.txn_date DESC, t.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<TxnRow & { category_name: string | null }>

  return { rows: rows.map(mapTransaction), total: totalRow.n }
}

/** a live transaction still awaiting categorization (category_id IS NULL) */
export interface UncategorizedTxn {
  id: string
  accountId: string
  source: Source
  txnDate: string
  amountCents: number
  status: TxnStatus
  importedPayee: string
  rawDescription: string
  sourceCategory: string | null
}

export function listUncategorized(db: Db): UncategorizedTxn[] {
  const rows = db
    .prepare(
      `SELECT * FROM transactions
       WHERE category_id IS NULL AND tombstone = 0
       ORDER BY txn_date ASC, id ASC`,
    )
    .all() as TxnRow[]
  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    source: r.source,
    txnDate: r.txn_date,
    amountCents: r.amount_cents,
    status: r.status,
    importedPayee: r.imported_payee,
    rawDescription: r.raw_description,
    sourceCategory: r.source_category,
  }))
}

/**
 * The review queue holds BOTH low-confidence LLM guesses AND rows no tier
 * could categorize at all (category_id NULL — e.g. Ollama offline). The
 * latter surface with the 'uncategorized' suggestion at confidence 0 so they
 * are never invisible to the user.
 */
export function listReviewQueue(db: Db): ReviewItem[] {
  const rows = db
    .prepare(
      `SELECT * FROM transactions
       WHERE tombstone = 0
         AND (category_id IS NULL
              OR (category_source = 'llm' AND llm_confidence < ? AND category_id IS NOT NULL))
       ORDER BY txn_date DESC, id ASC`,
    )
    .all(REVIEW_CONFIDENCE_THRESHOLD) as TxnRow[]
  return rows.map((r) => {
    if (r.category_id === null) {
      return {
        txnId: r.id,
        payee: r.imported_payee,
        rawDescription: r.raw_description,
        amountCents: r.amount_cents,
        txnDate: r.txn_date,
        suggestedCategoryId: 'uncategorized',
        confidence: 0,
      }
    }
    if (r.llm_confidence === null) {
      throw new Error(`review queue: row ${r.id} lost category/confidence mid-query`)
    }
    return {
      txnId: r.id,
      payee: r.imported_payee,
      rawDescription: r.raw_description,
      amountCents: r.amount_cents,
      txnDate: r.txn_date,
      suggestedCategoryId: r.category_id,
      confidence: r.llm_confidence,
    }
  })
}

export function assertCategoryExists(db: Db, categoryId: string): void {
  const hit = db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)
  if (!hit) throw new Error(`Unknown category: ${categoryId}`)
}

export function setTxnCategory(
  db: Db,
  txnId: string,
  categoryId: string,
  source: CategorySource,
  confidence?: number,
): void {
  if (!CATEGORY_SOURCES.includes(source)) {
    throw new Error(`setTxnCategory: invalid category source ${JSON.stringify(source)}`)
  }
  if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
    throw new Error(`setTxnCategory: confidence out of [0,1]: ${confidence}`)
  }
  assertCategoryExists(db, categoryId)
  const info = db
    .prepare(
      `UPDATE transactions SET category_id = ?, category_source = ?, llm_confidence = ?
       WHERE id = ? AND tombstone = 0`,
    )
    .run(categoryId, source, confidence ?? null, txnId)
  if (info.changes === 0) throw new Error(`setTxnCategory: unknown transaction ${txnId}`)
}

export function cacheGet(
  db: Db,
  normalizedMerchant: string,
): { categoryId: string; locked: boolean } | null {
  const row = db
    .prepare('SELECT category_id, locked FROM merchant_category_cache WHERE normalized_merchant = ?')
    .get(normalizedMerchant) as { category_id: string; locked: number } | undefined
  if (!row) return null
  return { categoryId: row.category_id, locked: row.locked === 1 }
}

export function cacheSet(
  db: Db,
  entry: {
    normalizedMerchant: string
    categoryId: string
    source: 'rule' | 'chase' | 'amex' | 'teller' | 'llm' | 'user'
    confidence: number | null
    locked: boolean
  },
): void {
  // locked rows are only ever overwritten by an incoming user write
  db.prepare(
    `INSERT INTO merchant_category_cache (normalized_merchant, category_id, source, confidence, locked)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(normalized_merchant) DO UPDATE SET
       category_id = excluded.category_id,
       source = excluded.source,
       confidence = excluded.confidence,
       locked = excluded.locked
     WHERE merchant_category_cache.locked = 0 OR excluded.source = 'user'`,
  ).run(
    entry.normalizedMerchant,
    entry.categoryId,
    entry.source,
    entry.confidence,
    entry.locked ? 1 : 0,
  )
}

/** a live non-user-categorized row, candidate for merchant-scope bulk updates */
export interface MerchantCandidate {
  id: string
  importedPayee: string
}

export function listMerchantCandidates(db: Db, excludeTxnId: string): MerchantCandidate[] {
  const rows = db
    .prepare(
      `SELECT id, imported_payee FROM transactions
       WHERE tombstone = 0 AND id != ?
         AND (category_source IS NULL OR category_source != 'user')`,
    )
    .all(excludeTxnId) as Array<{ id: string; imported_payee: string }>
  return rows.map((r) => ({ id: r.id, importedPayee: r.imported_payee }))
}

/**
 * Two-action recategorize (plan §6):
 * - scope 'txn': this row only, category_source='user', no cache write
 * - scope 'merchant': row update + locked user cache row; with applyToExisting,
 *   the caller supplies the same-merchant row ids (matched through the SAME
 *   normalizer that keys the merchant cache — raw imported_payee equality is
 *   NOT the cache key) and those rows take category_source='cache'. Rows the
 *   user categorized are never touched, even if their ids are passed in.
 */
export function recategorize(
  db: Db,
  input: RecategorizeInput,
  normalizedMerchant: string,
  applyToTxnIds: readonly string[] = [],
): { updated: number } {
  assertCategoryExists(db, input.categoryId)
  if (input.scope === 'merchant' && normalizedMerchant.trim() === '') {
    throw new Error('recategorize: normalized merchant is required for merchant scope')
  }
  const target = db
    .prepare('SELECT id FROM transactions WHERE id = ? AND tombstone = 0')
    .get(input.txnId) as { id: string } | undefined
  if (!target) throw new Error(`recategorize: unknown transaction ${input.txnId}`)

  const run = db.transaction((): number => {
    setTxnCategory(db, input.txnId, input.categoryId, 'user')
    let updated = 1
    if (input.scope === 'merchant') {
      cacheSet(db, {
        normalizedMerchant,
        categoryId: input.categoryId,
        source: 'user',
        confidence: null,
        locked: true,
      })
      if (input.applyToExisting === true && applyToTxnIds.length > 0) {
        const placeholders = applyToTxnIds.map(() => '?').join(', ')
        const info = db
          .prepare(
            `UPDATE transactions
             SET category_id = ?, category_source = 'cache', llm_confidence = NULL
             WHERE id IN (${placeholders}) AND id != ? AND tombstone = 0
               AND (category_source IS NULL OR category_source != 'user')`,
          )
          .run(input.categoryId, ...applyToTxnIds, input.txnId)
        updated += info.changes
      }
    }
    return updated
  })
  return { updated: run() }
}
