import { randomUUID } from 'node:crypto'
import type {
  AccountDto,
  AccountStatus,
  CategoryDto,
  CategorySource,
  DashboardData,
  IsoDate,
  RecategorizeInput,
  ReviewItem,
  Source,
  TransactionDto,
  TxnDraft,
  TxnQuery,
} from '../../shared/types'
import type {
  ApplyCounts,
  ExistingTxn,
  MerchantCachePort,
  ReconcileOutcome,
  TxnRepoPort,
} from '../core/ports'
import * as accountOps from './accounts'
import type { CreateAccountInput } from './accounts'
import { getDashboard } from './analytics'
import type { Db } from './db'
import {
  cacheGet,
  cacheSet,
  listMerchantCandidates,
  listReviewQueue,
  listTransactions,
  listUncategorized,
  recategorize,
  setTxnCategory,
  type MerchantCandidate,
  type UncategorizedTxn,
} from './queries'
import { mapCategory, mapExisting, mapTransaction, type CategoryRow, type TxnRow } from './rows'

export type { CreateAccountInput } from './accounts'
export type { ApplyCounts } from '../core/ports'

/** reconcile step injected into linkCsvHistory (kept out of the db layer) */
export type LinkReconcileFn = (
  incoming: TxnDraft[],
  existing: ExistingTxn[],
) => ReconcileOutcome

export interface SyncLogEntry {
  ranAt: string
  source: string
  accountId: string | null
  fetched: number
  inserted: number
  matched: number
  gcPending: number
  errors: string | null
}

/**
 * SQLite-backed repository. Implements the frozen TxnRepoPort and
 * MerchantCachePort plus the app-level queries the IPC layer needs.
 */
export class SqliteRepo implements TxnRepoPort, MerchantCachePort {
  constructor(private readonly db: Db) {}

  // ---- accounts (see accounts.ts) ----------------------------------------

  createAccount(input: CreateAccountInput): AccountDto {
    return accountOps.createAccount(this.db, input)
  }

  listAccounts(): AccountDto[] {
    return accountOps.listAccounts(this.db)
  }

  getAccount(id: string): AccountDto | null {
    return accountOps.getAccount(this.db, id)
  }

  updateAccountStatus(id: string, status: AccountStatus): void {
    accountOps.updateAccountStatus(this.db, id, status)
  }

  /** successful sync: status back to 'ok' AND last_sync_at stamped */
  markSynced(id: string, lastSyncAt: string): void {
    accountOps.markSynced(this.db, id, lastSyncAt)
  }

  /**
   * Move csv_only history onto a Teller account AND reconcile the merged
   * account (plan §5b): moved csv rows are re-presented as drafts against the
   * account's teller-source rows; each match applies the reconciler-approved
   * updates to the teller row, carries user edits (notes always, category only
   * when category_source='user') from the csv twin, and tombstones the twin.
   * All inside one transaction.
   */
  linkCsvHistory(
    csvAccountId: string,
    tellerAccountId: string,
    reconcileFn: LinkReconcileFn,
  ): { moved: number; matched: number } {
    const run = this.db.transaction((): { moved: number; matched: number } => {
      const movedIds = (
        this.db
          .prepare('SELECT id FROM transactions WHERE account_id = ? AND tombstone = 0')
          .all(csvAccountId) as Array<{ id: string }>
      ).map((r) => r.id)
      const moved = accountOps.linkCsvHistory(this.db, csvAccountId, tellerAccountId)

      const accountRows = this.db
        .prepare('SELECT * FROM transactions WHERE account_id = ? AND tombstone = 0')
        .all(tellerAccountId) as TxnRow[]
      const movedIdSet = new Set(movedIds)
      const csvRows = accountRows.filter((r) => movedIdSet.has(r.id) && r.source !== 'teller')
      const tellerRows = accountRows.filter((r) => r.source === 'teller' && !movedIdSet.has(r.id))
      if (csvRows.length === 0 || tellerRows.length === 0) return { moved, matched: 0 }

      const outcome = reconcileFn(csvRows.map(rowToDraft), tellerRows.map(mapExisting))
      let matched = 0
      outcome.decisions.forEach((decision, i) => {
        if (decision.kind !== 'match') return // unmatched csv rows already live as moved rows
        const twin = csvRows[i]
        if (twin === undefined) {
          throw new Error(`linkCsvHistory: decision index ${i} has no source row`)
        }
        this.applyMatch(decision.existingId, decision.updates)
        this.carryUserEdits(twin, decision.existingId)
        this.db.prepare('UPDATE transactions SET tombstone = 1 WHERE id = ?').run(twin.id)
        matched += 1
      })
      return { moved, matched }
    })
    return run()
  }

  /** carry user edits from a redundant twin onto its surviving row (plan §5a semantics) */
  private carryUserEdits(twin: TxnRow, targetId: string): void {
    if (twin.notes !== null) {
      this.db.prepare('UPDATE transactions SET notes = ? WHERE id = ?').run(twin.notes, targetId)
    }
    if (twin.category_source === 'user' && twin.category_id !== null) {
      this.db
        .prepare(
          `UPDATE transactions SET category_id = ?, category_source = 'user', llm_confidence = NULL
           WHERE id = ?`,
        )
        .run(twin.category_id, targetId)
    }
  }

  // ---- TxnRepoPort -------------------------------------------------------

  listExisting(accountId: string, fromDate: IsoDate | null): ExistingTxn[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM transactions
         WHERE account_id = ? AND tombstone = 0
           AND (? IS NULL OR txn_date >= ? OR (post_date IS NOT NULL AND post_date >= ?))
         ORDER BY txn_date ASC, id ASC`,
      )
      .all(accountId, fromDate, fromDate, fromDate) as TxnRow[]
    return rows.map(mapExisting)
  }

  listPending(accountId: string): ExistingTxn[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM transactions
         WHERE account_id = ? AND status = 'pending' AND tombstone = 0
         ORDER BY txn_date ASC, id ASC`,
      )
      .all(accountId) as TxnRow[]
    return rows.map(mapExisting)
  }

  /**
   * Every non-NULL external id on the account regardless of row source: a csv
   * row that adopted a teller id via a fuzzy merge still counts as known
   * (external ids are namespace-unique via ux_txn_external).
   */
  knownExternalIds(accountId: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT external_id FROM transactions
         WHERE account_id = ? AND external_id IS NOT NULL`,
      )
      .all(accountId) as Array<{ external_id: string }>
    return new Set(rows.map((r) => r.external_id))
  }

  /**
   * Persist a reconcile outcome atomically. Inserts use INSERT OR IGNORE
   * against ux_txn_import_hash / ux_txn_external: a unique violation means a
   * concurrent duplicate and is counted as skipped, never a crash. Match
   * decisions apply ONLY the reconciler-approved fields + reconciled=1 —
   * category/payee fields are never touched (plan invariant 5).
   */
  applyDecisions(accountId: string, outcome: ReconcileOutcome): ApplyCounts {
    const insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO transactions
         (id, account_id, source, external_id, import_hash, txn_date, post_date,
          amount_cents, status, imported_payee, raw_description, source_category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const run = this.db.transaction((): ApplyCounts => {
      const counts: ApplyCounts = { inserted: 0, matched: 0, skipped: 0 }
      for (const decision of outcome.decisions) {
        if (decision.kind === 'insert') {
          const d = decision.draft
          const info = insertStmt.run(
            randomUUID(),
            accountId,
            d.source,
            d.externalId,
            d.importHash,
            d.txnDate,
            d.postDate,
            d.amountCents,
            d.status,
            d.importedPayee,
            d.rawDescription,
            d.sourceCategory,
          )
          if (info.changes === 1) counts.inserted += 1
          else counts.skipped += 1
        } else if (decision.kind === 'match') {
          this.applyMatch(decision.existingId, decision.updates)
          counts.matched += 1
        } else {
          counts.skipped += 1
        }
      }
      return counts
    })
    return run()
  }

  private applyMatch(
    existingId: string,
    updates: {
      txnDate?: IsoDate
      postDate?: IsoDate
      status?: 'posted' | 'pending'
      linkedSourceId?: string
      externalId?: string
    },
  ): void {
    const sets: string[] = ['reconciled = 1']
    const params: unknown[] = []
    if (updates.txnDate !== undefined) {
      sets.push('txn_date = ?')
      params.push(updates.txnDate)
    }
    if (updates.postDate !== undefined) {
      sets.push('post_date = ?')
      params.push(updates.postDate)
    }
    if (updates.status !== undefined) {
      sets.push('status = ?')
      params.push(updates.status)
    }
    if (updates.externalId !== undefined) {
      sets.push('external_id = ?')
      params.push(updates.externalId)
    }
    if (updates.linkedSourceId !== undefined) {
      sets.push('linked_source_id = ?')
      params.push(updates.linkedSourceId)
    }
    const info = this.db
      .prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, existingId)
    if (info.changes === 0) {
      throw new Error(`applyDecisions: match target not found: ${existingId}`)
    }
  }

  /**
   * Tombstone stale pendings (presence-based GC, plan §5a). When a replacement
   * is known, carry user edits over: notes always; the category pair only when
   * the user set it (category_source='user'). The replacement is identified by
   * its BANK-ISSUED Teller id (SyncEngine only sees Teller ids — local row
   * UUIDs never cross that boundary) and resolved within the pending's account.
   */
  gcPending(ids: Array<{ id: string; replacementExternalId?: string }>): void {
    const read = this.db.prepare(
      'SELECT account_id, notes, category_id, category_source FROM transactions WHERE id = ?',
    )
    const resolveReplacement = this.db.prepare(
      `SELECT id FROM transactions
       WHERE account_id = ? AND source = 'teller' AND external_id = ? AND tombstone = 0`,
    )
    const tomb = this.db.prepare('UPDATE transactions SET tombstone = 1 WHERE id = ?')
    const copyNotes = this.db.prepare('UPDATE transactions SET notes = ? WHERE id = ?')
    const copyCategory = this.db.prepare(
      `UPDATE transactions SET category_id = ?, category_source = 'user', llm_confidence = NULL
       WHERE id = ?`,
    )
    const run = this.db.transaction(() => {
      for (const { id, replacementExternalId } of ids) {
        const old = read.get(id) as
          | {
              account_id: string
              notes: string | null
              category_id: string | null
              category_source: CategorySource | null
            }
          | undefined
        if (!old) throw new Error(`gcPending: unknown transaction ${id}`)
        const carryCategory = old.category_source === 'user' && old.category_id !== null
        if (replacementExternalId !== undefined && (old.notes !== null || carryCategory)) {
          const target = resolveReplacement.get(old.account_id, replacementExternalId) as
            | { id: string }
            | undefined
          if (target === undefined) {
            throw new Error(`gcPending: unknown replacement ${replacementExternalId}`)
          }
          if (old.notes !== null) copyNotes.run(old.notes, target.id)
          if (carryCategory) copyCategory.run(old.category_id, target.id)
        }
        tomb.run(id)
      }
    })
    run()
  }

  /**
   * AppService seam: locate a live row by its idempotency key so freshly
   * inserted drafts can be categorized (id + categorization state only).
   */
  findByImportHash(
    accountId: string,
    source: Source,
    importHash: string,
  ): { id: string; categoryId: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT id, category_id FROM transactions
         WHERE account_id = ? AND source = ? AND import_hash = ? AND tombstone = 0`,
      )
      .get(accountId, source, importHash) as { id: string; category_id: string | null } | undefined
    return row ? { id: row.id, categoryId: row.category_id } : null
  }

  /** AppService seam: single live transaction by id (recategorize/review flows) */
  getTransaction(id: string): TransactionDto | null {
    const row = this.db
      .prepare(
        `SELECT t.*, c.name AS category_name
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.id = ? AND t.tombstone = 0`,
      )
      .get(id) as (TxnRow & { category_name: string | null }) | undefined
    return row ? mapTransaction(row) : null
  }

  // ---- categorization support -------------------------------------------

  setTxnCategory(
    txnId: string,
    categoryId: string,
    source: CategorySource,
    confidence?: number,
  ): void {
    setTxnCategory(this.db, txnId, categoryId, source, confidence)
  }

  listUncategorized(): UncategorizedTxn[] {
    return listUncategorized(this.db)
  }

  listReviewQueue(): ReviewItem[] {
    return listReviewQueue(this.db)
  }

  /**
   * Candidate rows for a merchant-scope "apply to existing" — every live row
   * whose category was NOT set by the user. The caller matches candidates
   * against the merchant with the SAME normalizer that keys the merchant
   * cache, then passes the ids back into recategorize.
   */
  listMerchantCandidates(excludeTxnId: string): MerchantCandidate[] {
    return listMerchantCandidates(this.db, excludeTxnId)
  }

  recategorize(
    input: RecategorizeInput,
    normalizedMerchant: string,
    applyToTxnIds: readonly string[] = [],
  ): { updated: number } {
    return recategorize(this.db, input, normalizedMerchant, applyToTxnIds)
  }

  // ---- MerchantCachePort --------------------------------------------------

  get(normalizedMerchant: string): { categoryId: string; locked: boolean } | null {
    return cacheGet(this.db, normalizedMerchant)
  }

  set(entry: {
    normalizedMerchant: string
    categoryId: string
    source: 'rule' | 'chase' | 'amex' | 'teller' | 'llm' | 'user'
    confidence: number | null
    locked: boolean
  }): void {
    cacheSet(this.db, entry)
  }

  // ---- analytics & app queries --------------------------------------------

  getDashboard(month: string): DashboardData {
    return getDashboard(this.db, month)
  }

  listTransactions(query: TxnQuery): { rows: TransactionDto[]; total: number } {
    return listTransactions(this.db, query)
  }

  listCategories(): CategoryDto[] {
    const rows = this.db
      .prepare('SELECT * FROM categories ORDER BY sort_order ASC, id ASC')
      .all() as CategoryRow[]
    return rows.map(mapCategory)
  }

  // ---- settings & sync log -------------------------------------------------

  /**
   * Corrupt JSON (disk corruption, manual sqlite edit) degrades to null so
   * callers fall back to defaults and the next setSetting self-heals the row —
   * a single bad row must never brick every settings/sync surface.
   */
  getSetting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (!row) return null
    try {
      return JSON.parse(row.value) as T
    } catch (err: unknown) {
      console.error(
        `[whats-left] settings row ${JSON.stringify(key)} holds corrupt JSON ` +
          `(${err instanceof Error ? err.message : String(err)}) — falling back to defaults`,
      )
      return null
    }
  }

  setSetting(key: string, value: unknown): void {
    if (value === undefined) {
      throw new Error(`setSetting: refusing to store undefined for ${JSON.stringify(key)}`)
    }
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value))
  }

  insertSyncLog(entry: SyncLogEntry): string {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO sync_log (id, ran_at, source, account_id, fetched, inserted, matched, gc_pending, errors)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.ranAt,
        entry.source,
        entry.accountId,
        entry.fetched,
        entry.inserted,
        entry.matched,
        entry.gcPending,
        entry.errors,
      )
    return id
  }
}

/** re-present a persisted row as a draft for the linkCsvHistory reconcile pass */
function rowToDraft(row: TxnRow): TxnDraft {
  return {
    source: row.source,
    externalId: row.external_id,
    importHash: row.import_hash,
    txnDate: row.txn_date,
    postDate: row.post_date,
    amountCents: row.amount_cents,
    status: row.status,
    rawDescription: row.raw_description,
    importedPayee: row.imported_payee,
    sourceCategory: row.source_category,
    counterparty: null,
    typeCode: null,
  }
}
