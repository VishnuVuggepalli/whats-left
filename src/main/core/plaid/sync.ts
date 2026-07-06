import { createHash } from 'node:crypto'
import type { IsoDate, TxnDraft, TxnStatus } from '../../../shared/types'
import { minIso } from '../dates'
import type { ExistingTxn, ReconcileOutcome, TxnRepoPort } from '../ports'
import { ItemLoginRequiredError } from './client'
import type { PlaidRemovedTransaction, PlaidSyncResponse, PlaidTransaction } from './types'

/**
 * PlaidSyncEngine — Plaid live sync (successor to teller/sync.ts).
 *
 * - /transactions/sync is cursor-based and PER ITEM (an Item can hold several
 *   accounts), so the engine syncs one Item per run and reports per-account
 *   counts. Pages are accumulated until has_more=false, applied, and only
 *   THEN is next_cursor persisted — Plaid's documented pattern: a failed
 *   apply must never advance the cursor (the batch is re-fetched next sync).
 * - The reconciler is INJECTED; this module only depends on its
 *   (incoming, existing) => ReconcileOutcome shape.
 * - NO presence-based GC (that was a Teller workaround): Plaid tells us
 *   explicitly. A posted txn carrying pending_transaction_id replaces that
 *   pending row (tombstone + user-edit carry via repo.gcPending); removed[]
 *   entries are tombstoned by external id — never deleted.
 * - MODIFIED entries can change the amount, which pass-0 same-id matching
 *   deliberately never touches — handled explicitly after reconcile via
 *   repo.updateTxnStateByExternalId, which updates amount/dates/status ONLY
 *   and never category/payee/notes (plan §3 invariant 5).
 */

/** the slice of PlaidClient the engine needs (keeps tests to a tiny stub) */
export interface PlaidSyncClientPort {
  transactionsSync(accessToken: string, cursor?: string): Promise<PlaidSyncResponse>
}

/** per-item cursor persistence (settings table in production, plaidFlow keys) */
export interface PlaidCursorStore {
  get(itemId: string): string | null
  set(itemId: string, cursor: string): void
}

/** state-only update payload for MODIFIED entries — structurally no category/payee */
export interface PlaidTxnStateUpdate {
  amountCents: number
  txnDate: IsoDate
  postDate: IsoDate | null
  status: TxnStatus
}

/** narrow extension of the frozen TxnRepoPort with the Plaid-specific writes */
export interface PlaidTxnRepoPort extends TxnRepoPort {
  /** amount/dates/status by bank id; NEVER touches category/payee/notes; returns rows updated */
  updateTxnStateByExternalId(
    accountId: string,
    externalId: string,
    state: PlaidTxnStateUpdate,
  ): number
  /** tombstone (never delete) by bank id; idempotent; returns rows tombstoned */
  tombstoneByExternalId(accountId: string, externalId: string): number
}

export type ReconcileFn = (
  incoming: readonly TxnDraft[],
  existing: readonly ExistingTxn[],
) => ReconcileOutcome

export interface PlaidAccountSyncResult {
  accountId: string
  fetched: number
  inserted: number
  matched: number
  /** rows tombstoned this sync: replaced pendings + removed[] entries */
  gcPending: number
  /** non-fatal anomaly, e.g. inserts swallowed by a cross-account id collision */
  warning: string | null
  error: string | null
}

export interface PlaidItemSyncResult {
  accounts: PlaidAccountSyncResult[]
  /** 'reconnect_required' when the Item needs a re-login; null on success */
  error: 'reconnect_required' | null
}

export interface PlaidSyncItemInput {
  itemId: string
  accessToken: string
  accounts: Array<{ id: string; plaidAccountId: string }>
}

export interface PlaidSyncEngineDeps {
  client: PlaidSyncClientPort
  repo: PlaidTxnRepoPort
  reconcile: ReconcileFn
  cursors: PlaidCursorStore
}

/** hard ceiling so a misbehaving cursor can never loop forever — fails loudly */
const MAX_PAGES = 500

/** deterministic idempotency hash: sha256 hex of 'plaid:' + transaction_id */
export function plaidImportHash(plaidTxnId: string): string {
  return createHash('sha256').update(`plaid:${plaidTxnId}`, 'utf8').digest('hex')
}

/**
 * Plaid dollars → our signed integer cents. Plaid's sign convention is
 * INVERTED (positive = money out) and the dollars arrive as a float —
 * Math.round before negating (4.10 * 100 === 409.999…).
 */
export function plaidAmountToCents(amount: number): number {
  return -Math.round(amount * 100)
}

/** PlaidTransaction → TxnDraft (validated input, pure output) */
export function mapPlaidTxn(t: PlaidTransaction): TxnDraft {
  return {
    source: 'plaid',
    externalId: t.transaction_id,
    importHash: plaidImportHash(t.transaction_id),
    // authorized_date = swipe date (best "when it happened"); date = posted or
    // expected date. Earliest-known-date semantics, mirroring CSV txn/post.
    txnDate: t.authorized_date ?? t.date,
    postDate: t.pending ? null : t.date,
    amountCents: plaidAmountToCents(t.amount),
    status: t.pending ? 'pending' : 'posted',
    rawDescription: t.name,
    importedPayee: t.merchant_name ?? t.name,
    sourceCategory: t.personal_finance_category?.detailed ?? t.personal_finance_category?.primary ?? null,
    counterparty: t.merchant_name,
    typeCode: null,
  }
}

/** state-only slice of a Plaid txn, for updateTxnStateByExternalId */
export function plaidTxnState(t: PlaidTransaction): PlaidTxnStateUpdate {
  return {
    amountCents: plaidAmountToCents(t.amount),
    txnDate: t.authorized_date ?? t.date,
    postDate: t.pending ? null : t.date,
    status: t.pending ? 'pending' : 'posted',
  }
}

/**
 * The final (deduped, later-pages-win) added+modified transactions of one
 * plaid account across a batch of sync pages, as drafts. Used by the sync
 * engine AND by AppService to know which rows to categorize.
 */
export function draftsForAccount(
  responses: readonly PlaidSyncResponse[],
  plaidAccountId: string,
): TxnDraft[] {
  return [...dedupeLatest(responses).values()]
    .filter((t) => t.account_id === plaidAccountId)
    .map(mapPlaidTxn)
}

/** added+modified deduped by transaction_id — a later page's version wins */
function dedupeLatest(responses: readonly PlaidSyncResponse[]): Map<string, PlaidTransaction> {
  const latest = new Map<string, PlaidTransaction>()
  for (const page of responses) {
    for (const txn of [...page.added, ...page.modified]) {
      latest.set(txn.transaction_id, txn)
    }
  }
  return latest
}

interface FetchedBatch {
  responses: PlaidSyncResponse[]
  latest: Map<string, PlaidTransaction>
  modifiedIds: Set<string>
  removed: PlaidRemovedTransaction[]
  nextCursor: string
}

export class PlaidSyncEngine {
  constructor(private readonly deps: PlaidSyncEngineDeps) {}

  async syncItem(input: PlaidSyncItemInput): Promise<PlaidItemSyncResult> {
    let batch: FetchedBatch
    try {
      batch = await this.fetchBatch(input)
    } catch (err) {
      if (err instanceof ItemLoginRequiredError) {
        // Surfaced as a result marker so callers flag the accounts for
        // reconnect instead of crashing the whole sync run. No repo writes
        // happened and the cursor did not advance.
        return {
          accounts: input.accounts.map((a) => ({
            accountId: a.id,
            fetched: 0,
            inserted: 0,
            matched: 0,
            gcPending: 0,
            warning: null,
            error: 'reconnect_required' as const,
          })),
          error: 'reconnect_required',
        }
      }
      throw err
    }

    // Apply the WHOLE batch before persisting the cursor: any throw below
    // propagates to the caller with the cursor untouched, so the next sync
    // re-fetches the same batch (Plaid's documented pattern).
    const results = input.accounts.map((account) => this.applyAccount(account, batch))
    this.applyRemoved(input.accounts, batch, results)
    this.deps.cursors.set(input.itemId, batch.nextCursor)
    return { accounts: results, error: null }
  }

  private async fetchBatch(input: PlaidSyncItemInput): Promise<FetchedBatch> {
    const { client } = this.deps
    const responses: PlaidSyncResponse[] = []
    const modifiedIds = new Set<string>()
    const removed: PlaidRemovedTransaction[] = []
    let cursor = this.deps.cursors.get(input.itemId) ?? undefined
    for (let pages = 0; ; ) {
      if (++pages > MAX_PAGES) {
        throw new Error(`Plaid sync ${input.itemId}: exceeded ${MAX_PAGES} pages — aborting`)
      }
      const page = await client.transactionsSync(input.accessToken, cursor)
      responses.push(page)
      for (const txn of page.modified) modifiedIds.add(txn.transaction_id)
      removed.push(...page.removed)
      cursor = page.next_cursor
      if (!page.has_more) {
        return { responses, latest: dedupeLatest(responses), modifiedIds, removed, nextCursor: cursor }
      }
    }
  }

  private applyAccount(
    account: { id: string; plaidAccountId: string },
    batch: FetchedBatch,
  ): PlaidAccountSyncResult {
    const { repo, reconcile } = this.deps
    const txns = [...batch.latest.values()].filter((t) => t.account_id === account.plaidAccountId)
    const result: PlaidAccountSyncResult = {
      accountId: account.id,
      fetched: txns.length,
      inserted: 0,
      matched: 0,
      gcPending: 0,
      warning: null,
      error: null,
    }
    if (txns.length === 0) return result

    const drafts = txns.map(mapPlaidTxn)
    const oldestDraftDate = drafts.reduce<IsoDate | null>(
      (oldest, d) => (oldest === null ? d.txnDate : minIso(oldest, d.txnDate)),
      null,
    )
    const existing = repo.listExisting(account.id, oldestDraftDate)
    const outcome = reconcile(drafts, existing)
    // Report what the DB ACTUALLY persisted, not the reconciler's plan —
    // INSERT OR IGNORE can swallow a cross-account external-id collision.
    const counts = repo.applyDecisions(account.id, outcome)
    result.inserted = counts.inserted
    result.matched = counts.matched
    if (counts.inserted < outcome.inserted) {
      result.warning =
        `${outcome.inserted - counts.inserted} transaction(s) were not inserted — ` +
        'their external ids already exist on another account'
    }

    // MODIFIED entries: pass-0 matching never updates the amount — apply the
    // bank's new state explicitly. State only; category/payee/notes untouched.
    for (const txn of txns) {
      if (batch.modifiedIds.has(txn.transaction_id)) {
        repo.updateTxnStateByExternalId(account.id, txn.transaction_id, plaidTxnState(txn))
      }
    }

    // pending_transaction_id: a posted txn explicitly names the pending row it
    // replaces. Tombstone that pending via gcPending, which carries user edits
    // (notes always, category when category_source='user') onto the
    // replacement. Runs AFTER applyDecisions so the replacement row exists.
    result.gcPending += this.gcReplacedPendings(account.id, txns)
    return result
  }

  private gcReplacedPendings(accountId: string, txns: readonly PlaidTransaction[]): number {
    const { repo } = this.deps
    const replacers = txns.filter((t) => !t.pending && t.pending_transaction_id !== null)
    if (replacers.length === 0) return 0
    const pendingByExternalId = new Map(
      repo
        .listPending(accountId)
        .filter((p) => p.source === 'plaid' && p.externalId !== null)
        .map((p) => [p.externalId as string, p]),
    )
    const gcList: Array<{ id: string; replacementExternalId?: string }> = []
    for (const replacer of replacers) {
      const pending = pendingByExternalId.get(replacer.pending_transaction_id as string)
      if (pending !== undefined) {
        gcList.push({ id: pending.id, replacementExternalId: replacer.transaction_id })
      }
    }
    if (gcList.length > 0) repo.gcPending(gcList)
    return gcList.length
  }

  /**
   * removed[] → tombstone by external id (idempotent; a pending already
   * tombstoned via pending_transaction_id is a no-op here). Entries missing
   * account_id (older API shape) are tried against every synced account.
   */
  private applyRemoved(
    accounts: ReadonlyArray<{ id: string; plaidAccountId: string }>,
    batch: FetchedBatch,
    results: PlaidAccountSyncResult[],
  ): void {
    const { repo } = this.deps
    const resultByAccountId = new Map(results.map((r) => [r.accountId, r]))
    for (const entry of batch.removed) {
      const targets =
        entry.account_id != null
          ? accounts.filter((a) => a.plaidAccountId === entry.account_id)
          : accounts
      for (const target of targets) {
        const result = resultByAccountId.get(target.id)
        if (result !== undefined && entry.account_id != null) result.fetched += 1
        const tombstoned = repo.tombstoneByExternalId(target.id, entry.transaction_id)
        if (tombstoned > 0) {
          if (result !== undefined) result.gcPending += tombstoned
          break
        }
      }
    }
  }
}
