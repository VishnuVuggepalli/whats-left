import { readFileSync } from 'node:fs'
import type { IsoDate, TxnDraft } from '../../../shared/types'
import type { ApplyCounts, ExistingTxn, ReconcileOutcome } from '../ports'
import type { ReconcileFn, PlaidCursorStore, PlaidSyncClientPort, PlaidTxnRepoPort, PlaidTxnStateUpdate } from './sync'
import { PlaidSyncEngine, plaidImportHash } from './sync'
import type { PlaidSyncResponse, PlaidTransaction } from './types'
import { plaidSyncResponseSchema } from './types'

/** shared fakes/builders for sync.test.ts (test-only) */

export const ITEM = {
  itemId: 'plaid-item-01',
  accessToken: 'access-token-01',
  accounts: [
    { id: 'app_acc_chase', plaidAccountId: 'plaid-acc-chase-01' },
    { id: 'app_acc_amex', plaidAccountId: 'plaid-acc-amex-01' },
  ],
}

export const fixturePage1 = plaidSyncResponseSchema.parse(
  JSON.parse(readFileSync('/root/whats-left/fixtures/plaid/transactions_sync_page1.json', 'utf8')),
)
export const fixturePage2 = plaidSyncResponseSchema.parse(
  JSON.parse(readFileSync('/root/whats-left/fixtures/plaid/transactions_sync_page2.json', 'utf8')),
)

export function mkPlaidTxn(
  over: Partial<PlaidTransaction> & { transaction_id: string },
): PlaidTransaction {
  return {
    account_id: 'plaid-acc-amex-01',
    amount: 10,
    iso_currency_code: 'USD',
    date: '2026-07-01',
    authorized_date: null,
    name: `TXN ${over.transaction_id}`,
    merchant_name: null,
    pending: false,
    pending_transaction_id: null,
    personal_finance_category: null,
    ...over,
  }
}

export function mkPage(over: Partial<PlaidSyncResponse> = {}): PlaidSyncResponse {
  return {
    added: [],
    modified: [],
    removed: [],
    next_cursor: 'cursor-end',
    has_more: false,
    ...over,
  }
}

export function mkPending(
  over: Partial<ExistingTxn> & { id: string; externalId: string; accountId: string },
): ExistingTxn {
  return {
    source: 'plaid',
    importHash: plaidImportHash(over.externalId),
    txnDate: '2026-07-01',
    postDate: null,
    amountCents: -1000,
    status: 'pending',
    normalizedPayee: '',
    categorySource: null,
    ...over,
  }
}

export class FakePlaidRepo implements PlaidTxnRepoPort {
  existing = new Map<string, ExistingTxn[]>() // accountId → rows
  pending = new Map<string, ExistingTxn[]>() // accountId → pending rows
  /** simulate INSERT OR IGNORE swallowing inserts (cross-account id collision) */
  swallowInserts = 0
  /** result of tombstoneByExternalId (rows actually tombstoned) */
  tombstoneResult = 1
  /** when set, applyDecisions throws — simulates a mid-batch persistence failure */
  failApplyFor: string | null = null

  readonly ops: string[] = []
  readonly applied: Array<{ accountId: string; outcome: ReconcileOutcome }> = []
  readonly stateUpdates: Array<{ accountId: string; externalId: string; state: PlaidTxnStateUpdate }> = []
  readonly tombstoned: Array<{ accountId: string; externalId: string }> = []
  readonly gcArgs: Array<Array<{ id: string; replacementExternalId?: string }>> = []
  readonly listExistingArgs: Array<{ accountId: string; fromDate: IsoDate | null }> = []

  listExisting(accountId: string, fromDate: IsoDate | null): ExistingTxn[] {
    this.listExistingArgs.push({ accountId, fromDate })
    return [...(this.existing.get(accountId) ?? [])]
  }

  listPending(accountId: string): ExistingTxn[] {
    // include pendings inserted THIS run (the engine reads pendings after
    // applyDecisions so a same-batch pending+replacement pair still links)
    const inserted = this.applied
      .filter((a) => a.accountId === accountId)
      .flatMap((a) => a.outcome.decisions)
      .filter(
        (d): d is { kind: 'insert'; draft: TxnDraft } =>
          d.kind === 'insert' && d.draft.status === 'pending',
      )
      .map((d) =>
        mkPending({
          id: `inserted_${d.draft.externalId ?? d.draft.importHash}`,
          externalId: d.draft.externalId ?? '',
          accountId,
          amountCents: d.draft.amountCents,
          txnDate: d.draft.txnDate,
        }),
      )
    return [...(this.pending.get(accountId) ?? []), ...inserted]
  }

  applyDecisions(accountId: string, outcome: ReconcileOutcome): ApplyCounts {
    if (this.failApplyFor === accountId) {
      throw new Error(`applyDecisions failed for ${accountId} (simulated)`)
    }
    this.ops.push(`apply:${accountId}`)
    this.applied.push({ accountId, outcome })
    const swallowed = Math.min(this.swallowInserts, outcome.inserted)
    return {
      inserted: outcome.inserted - swallowed,
      matched: outcome.matched,
      skipped: outcome.skipped + swallowed,
    }
  }

  gcPending(ids: Array<{ id: string; replacementExternalId?: string }>): void {
    this.ops.push('gc')
    this.gcArgs.push(ids)
  }

  knownExternalIds(): Set<string> {
    return new Set()
  }

  updateTxnStateByExternalId(
    accountId: string,
    externalId: string,
    state: PlaidTxnStateUpdate,
  ): number {
    this.ops.push(`state:${externalId}`)
    this.stateUpdates.push({ accountId, externalId, state })
    return 1
  }

  tombstoneByExternalId(accountId: string, externalId: string): number {
    this.ops.push(`tombstone:${externalId}`)
    this.tombstoned.push({ accountId, externalId })
    return this.tombstoneResult
  }
}

export class MemoryCursorStore implements PlaidCursorStore {
  readonly store = new Map<string, string>()
  readonly sets: Array<{ itemId: string; cursor: string }> = []
  get(itemId: string): string | null {
    return this.store.get(itemId) ?? null
  }
  set(itemId: string, cursor: string): void {
    this.sets.push({ itemId, cursor })
    this.store.set(itemId, cursor)
  }
}

export class StubPagedClient implements PlaidSyncClientPort {
  readonly calls: Array<{ accessToken: string; cursor: string | undefined }> = []
  constructor(private readonly pages: PlaidSyncResponse[]) {}
  async transactionsSync(accessToken: string, cursor?: string): Promise<PlaidSyncResponse> {
    this.calls.push({ accessToken, cursor })
    const page = this.pages[this.calls.length - 1]
    if (!page) throw new Error('StubPagedClient: no scripted page left')
    return page
  }
}

/** simple stand-in for the real reconciler: match on externalId, else insert */
export function recordingReconcile(): {
  fn: ReconcileFn
  calls: Array<{ incoming: TxnDraft[]; existing: ExistingTxn[] }>
} {
  const calls: Array<{ incoming: TxnDraft[]; existing: ExistingTxn[] }> = []
  const fn: ReconcileFn = (incoming, existing) => {
    calls.push({ incoming: [...incoming], existing: [...existing] })
    const byExt = new Map(
      existing.filter((e) => e.externalId !== null).map((e) => [e.externalId as string, e.id]),
    )
    const decisions = incoming.map((draft) => {
      const hit = draft.externalId !== null ? byExt.get(draft.externalId) : undefined
      return hit !== undefined
        ? { kind: 'match' as const, existingId: hit, draft, updates: {} }
        : { kind: 'insert' as const, draft }
    })
    return {
      decisions,
      inserted: decisions.filter((d) => d.kind === 'insert').length,
      matched: decisions.filter((d) => d.kind === 'match').length,
      skipped: 0,
    }
  }
  return { fn, calls }
}

export function makeEngine(opts: { pages?: PlaidSyncResponse[]; repo?: FakePlaidRepo; cursors?: MemoryCursorStore }): {
  engine: PlaidSyncEngine
  repo: FakePlaidRepo
  client: StubPagedClient
  cursors: MemoryCursorStore
  reconcileCalls: Array<{ incoming: TxnDraft[]; existing: ExistingTxn[] }>
} {
  const repo = opts.repo ?? new FakePlaidRepo()
  const client = new StubPagedClient(opts.pages ?? [])
  const cursors = opts.cursors ?? new MemoryCursorStore()
  const { fn, calls } = recordingReconcile()
  const engine = new PlaidSyncEngine({ client, repo, reconcile: fn, cursors })
  return { engine, repo, client, cursors, reconcileCalls: calls }
}
