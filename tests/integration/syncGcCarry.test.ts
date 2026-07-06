import { describe, expect, it } from 'vitest'
import { normalizePayee } from '../../src/main/core/categorize/normalizer'
import { reconcile } from '../../src/main/core/reconcile/reconciler'
import { SyncEngine } from '../../src/main/core/teller/sync'
import type { SyncClientPort } from '../../src/main/core/teller/sync'
import type { TellerTransaction } from '../../src/main/core/teller/types'
import { insertAccount, makeRepo } from '../../src/main/db/testSupport'
import { FixedClock } from '../../src/main/platform/fakes'

/**
 * Finding 0/5 (CRITICAL) regression test: the SyncEngine ↔ SqliteRepo boundary
 * for presence-based pending GC. A user-edited pending replaced by a
 * tip-adjusted posted row under a NEW Teller id must carry note + user
 * category onto the new row — with the REAL repository, not a fake.
 */

function tellerTxn(over: Partial<TellerTransaction> & { id: string }): TellerTransaction {
  return {
    account_id: 'acc_1',
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

/** one-page client whose contents can be swapped between syncs */
function makeMutableClient(): { client: SyncClientPort; setPage: (p: TellerTransaction[]) => void } {
  let page: TellerTransaction[] = []
  return {
    client: { listTransactions: async () => page },
    setPage: (p) => {
      page = p
    },
  }
}

describe('SyncEngine + SqliteRepo — pending GC carry-over (integration)', () => {
  it('tip-adjusted replacement: note + user category land on the new posted row, no error', async () => {
    const { db, repo } = makeRepo()
    const accountId = insertAccount(db, { sourceKind: 'teller', type: 'credit' })
    const { client, setPage } = makeMutableClient()
    const engine = new SyncEngine({
      client,
      repo,
      clock: new FixedClock('2026-07-06'),
      reconcile: (incoming, existing) =>
        reconcile([...incoming], [...existing], { normalize: normalizePayee }),
    })

    // sync 1: a -$50.00 pending restaurant charge
    setPage([
      tellerTxn({ id: 'txn_pending_old', date: '2026-07-01', amount: '-50.00', status: 'pending' }),
    ])
    const first = await engine.syncAccount({ id: accountId, tellerAccountId: 'acc_1' })
    expect(first.error).toBeNull()
    expect(first.inserted).toBe(1)

    // user notes it and sets a category by hand
    const pendingRow = db
      .prepare(`SELECT id FROM transactions WHERE external_id = 'txn_pending_old'`)
      .get() as { id: string }
    db.prepare(
      `UPDATE transactions SET notes = ?, category_id = 'food_and_drink', category_source = 'user'
       WHERE id = ?`,
    ).run('anniversary dinner', pendingRow.id)

    // sync 2: the charge posts tip-adjusted at -$60.00 under a NEW Teller id
    setPage([
      tellerTxn({ id: 'txn_posted_new', date: '2026-07-02', amount: '-60.00', status: 'posted' }),
    ])
    const second = await engine.syncAccount({ id: accountId, tellerAccountId: 'acc_1' })
    expect(second.error).toBeNull() // the old bug threw 'gcPending: unknown replacement'
    expect(second.gcPending).toBe(1)

    // the stale pending is tombstoned; the edits live on the posted row
    const stale = db
      .prepare('SELECT tombstone FROM transactions WHERE id = ?')
      .get(pendingRow.id) as { tombstone: number }
    expect(stale.tombstone).toBe(1)

    const live = db
      .prepare(`SELECT * FROM transactions WHERE tombstone = 0 AND account_id = ?`)
      .all(accountId) as Array<Record<string, unknown>>
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({
      external_id: 'txn_posted_new',
      status: 'posted',
      amount_cents: -6000,
      notes: 'anniversary dinner',
      category_id: 'food_and_drink',
      category_source: 'user',
    })
  })

  it('a pending with NO edits is tombstoned without error when replaced', async () => {
    const { db, repo } = makeRepo()
    const accountId = insertAccount(db, { sourceKind: 'teller', type: 'credit' })
    const { client, setPage } = makeMutableClient()
    const engine = new SyncEngine({
      client,
      repo,
      clock: new FixedClock('2026-07-06'),
      reconcile: (incoming, existing) =>
        reconcile([...incoming], [...existing], { normalize: normalizePayee }),
    })

    setPage([tellerTxn({ id: 'txn_p1', date: '2026-07-01', amount: '-50.00', status: 'pending' })])
    await engine.syncAccount({ id: accountId, tellerAccountId: 'acc_1' })
    setPage([tellerTxn({ id: 'txn_p2', date: '2026-07-02', amount: '-55.00', status: 'posted' })])
    const result = await engine.syncAccount({ id: accountId, tellerAccountId: 'acc_1' })

    expect(result.error).toBeNull()
    expect(result.gcPending).toBe(1)
    const live = db
      .prepare('SELECT external_id FROM transactions WHERE tombstone = 0')
      .all() as Array<{ external_id: string }>
    expect(live.map((r) => r.external_id)).toEqual(['txn_p2'])
  })
})
