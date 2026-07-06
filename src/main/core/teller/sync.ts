import { createHash } from 'node:crypto'
import type { IsoDate, TxnDraft } from '../../../shared/types'
import { daysBetween, minIso } from '../dates'
import { parseAmountToCents } from '../money'
import type { Clock, ExistingTxn, ReconcileOutcome, TxnRepoPort } from '../ports'
import { EnrollmentInactiveError } from './client'
import type { TellerTransaction } from './types'

/**
 * SyncEngine — Teller live sync (plan §5a).
 *
 * - Cursor pagination backward via from_id; stops after K consecutive
 *   already-known ids, but always extends the window back past the oldest
 *   local pending row's date so presence-based GC sees the full picture.
 * - The reconciler is INJECTED (built in parallel in core/reconcile); this
 *   module only depends on its (incoming, existing) => ReconcileOutcome shape.
 * - Presence-based pending GC: a local pending whose Teller id is absent from
 *   the freshly fetched window is tombstoned; a replacing posted row (new id,
 *   date ±5 days, amount ±20% — tips change amounts) is passed along so the
 *   repo can carry user edits onto it.
 */

/** the slice of TellerClient the engine needs (keeps tests to a tiny stub) */
export interface SyncClientPort {
  listTransactions(
    accountId: string,
    opts?: { count?: number; fromId?: string },
  ): Promise<TellerTransaction[]>
}

export type ReconcileFn = (
  incoming: readonly TxnDraft[],
  existing: readonly ExistingTxn[],
) => ReconcileOutcome

export interface SyncAccountResult {
  fetched: number
  inserted: number
  matched: number
  gcPending: number
  /** 'reconnect_required' when the enrollment is inactive; null on success */
  error: string | null
}

export interface SyncEngineDeps {
  client: SyncClientPort
  repo: TxnRepoPort
  clock: Clock
  reconcile: ReconcileFn
  /** page size for cursor pagination (test seam; default 100) */
  pageSize?: number
  /** stop after this many consecutive known ids (plan §5a: K=15) */
  stopAfterKnown?: number
}

const DEFAULT_PAGE_SIZE = 100
const DEFAULT_STOP_AFTER_KNOWN = 15
/** hard ceiling so a misbehaving cursor can never loop forever — fails loudly */
const MAX_PAGES = 500
const REPLACEMENT_DATE_WINDOW_DAYS = 5
const REPLACEMENT_AMOUNT_TOLERANCE = 0.2

/** deterministic idempotency hash for a Teller transaction: sha256 hex of its id */
export function tellerImportHash(tellerTxnId: string): string {
  return createHash('sha256').update(tellerTxnId, 'utf8').digest('hex')
}

/** TellerTransaction → TxnDraft (plan §5a mapping; validated input, pure output) */
export function mapTellerTxn(t: TellerTransaction): TxnDraft {
  const counterparty = t.details.counterparty?.name ?? null
  return {
    source: 'teller',
    externalId: t.id,
    importHash: tellerImportHash(t.id),
    txnDate: t.date,
    postDate: t.status === 'posted' ? t.date : null,
    amountCents: parseAmountToCents(t.amount),
    status: t.status,
    rawDescription: t.description,
    importedPayee: counterparty ?? t.description,
    sourceCategory: t.details.category,
    counterparty,
    typeCode: t.type,
  }
}

export class SyncEngine {
  constructor(private readonly deps: SyncEngineDeps) {}

  async syncAccount(account: { id: string; tellerAccountId: string }): Promise<SyncAccountResult> {
    try {
      return await this.run(account)
    } catch (err) {
      if (err instanceof EnrollmentInactiveError) {
        // Surfaced as a result marker so callers flag the account for
        // reconnect instead of crashing the whole sync run. No repo writes
        // happened for this account (a partial window must never drive GC).
        return { fetched: 0, inserted: 0, matched: 0, gcPending: 0, error: 'reconnect_required' }
      }
      throw err
    }
  }

  private async run(account: { id: string; tellerAccountId: string }): Promise<SyncAccountResult> {
    const { client, repo, reconcile } = this.deps
    const pageSize = this.deps.pageSize ?? DEFAULT_PAGE_SIZE
    const stopAfterKnown = this.deps.stopAfterKnown ?? DEFAULT_STOP_AFTER_KNOWN

    const knownIds = repo.knownExternalIds(account.id, 'teller')
    const tellerPendings = repo
      .listPending(account.id)
      .filter((p) => p.source === 'teller' && p.externalId !== null)
    const oldestPendingDate = tellerPendings.reduce<IsoDate | null>(
      (oldest, p) => (oldest === null ? p.txnDate : minIso(oldest, p.txnDate)),
      null,
    )

    const { fetched, fetchedIds, oldestFetchedDate } = await fetchWindow({
      client,
      tellerAccountId: account.tellerAccountId,
      pageSize,
      stopAfterKnown,
      knownIds,
      oldestPendingDate,
    })

    let inserted = 0
    let matched = 0
    if (fetched.length > 0) {
      const drafts = fetched.map(mapTellerTxn)
      const existing = repo.listExisting(account.id, oldestFetchedDate)
      const outcome = reconcile(drafts, existing)
      repo.applyDecisions(account.id, outcome)
      inserted = outcome.inserted
      matched = outcome.matched
    }

    // GC runs after applyDecisions so a freshly inserted replacement row
    // already exists when the repo carries user edits onto it.
    const gcList = identifyPendingGc(tellerPendings, fetched, fetchedIds, knownIds)
    if (gcList.length > 0) repo.gcPending(gcList)

    return { fetched: fetched.length, inserted, matched, gcPending: gcList.length, error: null }
  }
}

interface FetchWindowResult {
  fetched: TellerTransaction[]
  fetchedIds: Set<string>
  oldestFetchedDate: IsoDate | null
}

async function fetchWindow(input: {
  client: SyncClientPort
  tellerAccountId: string
  pageSize: number
  stopAfterKnown: number
  knownIds: ReadonlySet<string>
  oldestPendingDate: IsoDate | null
}): Promise<FetchWindowResult> {
  const { client, tellerAccountId, pageSize, stopAfterKnown, knownIds, oldestPendingDate } = input
  const fetched: TellerTransaction[] = []
  const fetchedIds = new Set<string>()
  let oldestFetchedDate: IsoDate | null = null
  let consecutiveKnown = 0
  let fromId: string | undefined
  for (let pages = 0; ; ) {
    if (++pages > MAX_PAGES) {
      throw new Error(`Teller sync ${tellerAccountId}: exceeded ${MAX_PAGES} pages — aborting`)
    }
    const page = await client.listTransactions(tellerAccountId, { count: pageSize, fromId })
    for (const txn of page) {
      if (!fetchedIds.has(txn.id)) {
        fetchedIds.add(txn.id)
        fetched.push(txn)
      }
      consecutiveKnown = knownIds.has(txn.id) ? consecutiveKnown + 1 : 0
      oldestFetchedDate = oldestFetchedDate === null ? txn.date : minIso(oldestFetchedDate, txn.date)
    }
    const noMorePages = page.length < pageSize
    // The window must reach back past the oldest local pending row's date so
    // absence in the window is meaningful (plan §5a presence-based GC).
    const pendingWindowCovered =
      oldestPendingDate === null ||
      (oldestFetchedDate !== null && oldestFetchedDate < oldestPendingDate)
    if (noMorePages || (consecutiveKnown >= stopAfterKnown && pendingWindowCovered)) {
      return { fetched, fetchedIds, oldestFetchedDate }
    }
    const last = page[page.length - 1]
    if (last === undefined) {
      throw new Error('unreachable: full page with no last element')
    }
    fromId = last.id
  }
}

/**
 * Presence-based pending GC (plan §5a): local teller pendings absent from the
 * fetched id set are tombstoned. Replacement = freshly fetched posted row that
 * is NEW (id not already known — a pending→posted rewrite issues a new id),
 * dated within ±5 days and amount within ±20% (tip adjustments). Each
 * candidate is consumed at most once; best candidate = closest date, then
 * closest amount.
 */
function identifyPendingGc(
  pendings: readonly ExistingTxn[],
  fetched: readonly TellerTransaction[],
  fetchedIds: ReadonlySet<string>,
  knownIds: ReadonlySet<string>,
): Array<{ id: string; replacementId?: string }> {
  const candidates = fetched.filter((t) => t.status === 'posted' && !knownIds.has(t.id))
  const claimed = new Set<string>()
  const gcList: Array<{ id: string; replacementId?: string }> = []
  for (const pending of pendings) {
    if (pending.externalId !== null && fetchedIds.has(pending.externalId)) continue
    const replacement = findReplacement(pending, candidates, claimed)
    if (replacement !== null) {
      claimed.add(replacement.id)
      gcList.push({ id: pending.id, replacementId: replacement.id })
    } else {
      gcList.push({ id: pending.id })
    }
  }
  return gcList
}

function findReplacement(
  pending: ExistingTxn,
  candidates: readonly TellerTransaction[],
  claimed: ReadonlySet<string>,
): TellerTransaction | null {
  let best: TellerTransaction | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    if (claimed.has(candidate.id)) continue
    const dateDistance = Math.abs(daysBetween(pending.txnDate, candidate.date))
    if (dateDistance > REPLACEMENT_DATE_WINDOW_DAYS) continue
    const amountDelta = Math.abs(parseAmountToCents(candidate.amount) - pending.amountCents)
    if (amountDelta > Math.abs(pending.amountCents) * REPLACEMENT_AMOUNT_TOLERANCE) continue
    // rank: date proximity dominates, amount proximity breaks ties
    const score = dateDistance * 1_000_000 + amountDelta
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}
