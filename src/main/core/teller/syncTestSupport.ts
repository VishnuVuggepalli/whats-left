import { readFileSync } from 'node:fs'
import type { ApplyCounts, ExistingTxn, ReconcileOutcome, TxnRepoPort } from '../ports'
import type { IsoDate, TxnDraft } from '../../../shared/types'
import { FixedClock } from '../../platform/fakes'
import type { TellerTransaction } from './types'
import { tellerTransactionsSchema } from './types'
import type { ReconcileFn, SyncClientPort } from './sync'
import { SyncEngine, tellerImportHash } from './sync'

/** shared fakes/builders for sync.test.ts and sync.gc.test.ts (test-only) */

export const ACCOUNT = { id: 'app_acc_1', tellerAccountId: 'acc_chase_cc_1' }

export const fixtureTxns = tellerTransactionsSchema.parse(
  JSON.parse(readFileSync('/root/whats-left/fixtures/teller/transactions_chase_cc.json', 'utf8')),
)

export function mkTxn(over: Partial<TellerTransaction> & { id: string }): TellerTransaction {
  return {
    account_id: 'acc_chase_cc_1',
    date: '2026-07-01',
    description: `TXN ${over.id}`,
    amount: '-10.00',
    status: 'posted',
    type: 'card_payment',
    running_balance: null,
    details: { processing_status: 'complete', category: null, counterparty: null },
    ...over,
  }
}

export function mkPending(
  over: Partial<ExistingTxn> & { id: string; externalId: string },
): ExistingTxn {
  return {
    accountId: ACCOUNT.id,
    source: 'teller',
    importHash: tellerImportHash(over.externalId),
    txnDate: '2026-07-01',
    postDate: null,
    amountCents: -1000,
    status: 'pending',
    normalizedPayee: '',
    categorySource: null,
    ...over,
  }
}

export class FakeRepo implements TxnRepoPort {
  existing: ExistingTxn[] = []
  pending: ExistingTxn[] = []
  known = new Set<string>()
  readonly ops: string[] = []
  readonly applied: ReconcileOutcome[] = []
  readonly gcArgs: Array<Array<{ id: string; replacementExternalId?: string }>> = []
  readonly listExistingArgs: Array<{ accountId: string; fromDate: IsoDate | null }> = []
  /** simulate INSERT OR IGNORE swallowing inserts (cross-account id collision) */
  swallowInserts = 0

  listExisting(accountId: string, fromDate: IsoDate | null): ExistingTxn[] {
    this.listExistingArgs.push({ accountId, fromDate })
    return [...this.existing]
  }
  listPending(_accountId: string): ExistingTxn[] {
    return [...this.pending]
  }
  applyDecisions(_accountId: string, outcome: ReconcileOutcome): ApplyCounts {
    this.ops.push('apply')
    this.applied.push(outcome)
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
    return new Set(this.known)
  }
}

export class StubPagedClient implements SyncClientPort {
  readonly calls: Array<{ accountId: string; opts?: { count?: number; fromId?: string } }> = []
  constructor(private readonly pages: TellerTransaction[][]) {}
  async listTransactions(
    accountId: string,
    opts?: { count?: number; fromId?: string },
  ): Promise<TellerTransaction[]> {
    this.calls.push({ accountId, opts })
    return this.pages[this.calls.length - 1] ?? []
  }
}

export class ThrowingClient implements SyncClientPort {
  constructor(private readonly err: Error) {}
  async listTransactions(): Promise<TellerTransaction[]> {
    throw this.err
  }
}

/** simple stand-in for the real reconciler (built in parallel): match on externalId */
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

export function makeEngine(opts: {
  pages?: TellerTransaction[][]
  repo?: FakeRepo
  pageSize?: number
  stopAfterKnown?: number
}): {
  engine: SyncEngine
  repo: FakeRepo
  client: StubPagedClient
  reconcileCalls: Array<{ incoming: TxnDraft[]; existing: ExistingTxn[] }>
} {
  const repo = opts.repo ?? new FakeRepo()
  const client = new StubPagedClient(opts.pages ?? [])
  const { fn, calls } = recordingReconcile()
  const engine = new SyncEngine({
    client,
    repo,
    clock: new FixedClock('2026-07-06'),
    reconcile: fn,
    pageSize: opts.pageSize,
    stopAfterKnown: opts.stopAfterKnown,
  })
  return { engine, repo, client, reconcileCalls: calls }
}
