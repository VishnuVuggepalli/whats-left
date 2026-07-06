import { describe, expect, it } from 'vitest'
import { FixedClock } from '../../platform/fakes'
import { EnrollmentInactiveError, RateLimitError } from './client'
import { SyncEngine } from './sync'
import {
  ACCOUNT,
  FakeRepo,
  fixtureTxns,
  makeEngine,
  mkPending,
  mkTxn,
  recordingReconcile,
  ThrowingClient,
} from './syncTestSupport'

describe('SyncEngine — presence-based pending GC', () => {
  it('does not GC a pending that is still present in the fetched window', async () => {
    const repo = new FakeRepo()
    repo.known = new Set(['txn_pending_new1'])
    repo.pending = [
      mkPending({ id: 'local_p1', externalId: 'txn_pending_new1', txnDate: '2026-07-05', amountCents: -4200 }),
    ]
    const { engine, repo: r } = makeEngine({ pages: [fixtureTxns], repo })
    const result = await engine.syncAccount(ACCOUNT)
    expect(result.gcPending).toBe(0)
    expect(r.gcArgs).toHaveLength(0)
  })

  it('voided pre-auth: absent pending with no replacement → plain tombstone', async () => {
    const repo = new FakeRepo()
    repo.pending = [
      mkPending({ id: 'local_void', externalId: 'txn_gone', txnDate: '2026-06-20', amountCents: -3000 }),
    ]
    // fetched posted row is far away in amount AND date — not a replacement
    const pages = [[mkTxn({ id: 'txn_other', date: '2026-07-01', amount: '-99.00' })]]
    const { engine, repo: r } = makeEngine({ pages, repo })
    const result = await engine.syncAccount(ACCOUNT)
    expect(result.gcPending).toBe(1)
    expect(r.gcArgs).toEqual([[{ id: 'local_void' }]])
  })

  it('tip-adjusted: -50.00 pending replaced by -60.00 posted under a new id', async () => {
    const repo = new FakeRepo()
    repo.pending = [
      mkPending({ id: 'local_tip', externalId: 'txn_pending_meal', txnDate: '2026-07-01', amountCents: -5000 }),
    ]
    const pages = [[mkTxn({ id: 'txn_posted_meal', date: '2026-07-02', amount: '-60.00', status: 'posted' })]]
    const { engine, repo: r } = makeEngine({ pages, repo })
    const result = await engine.syncAccount(ACCOUNT)
    expect(result.gcPending).toBe(1)
    expect(r.gcArgs).toEqual([[{ id: 'local_tip', replacementId: 'txn_posted_meal' }]])
  })

  it('replacement boundaries: exactly ±5 days and ±20% qualify; one step past does not', async () => {
    const cases = [
      { date: '2026-06-25', amount: '-60.00', expectReplacement: true }, // 5 days, 20% — inclusive
      { date: '2026-06-26', amount: '-60.00', expectReplacement: false }, // 6 days
      { date: '2026-06-25', amount: '-60.01', expectReplacement: false }, // 20% + 1 cent
    ]
    for (const c of cases) {
      const repo = new FakeRepo()
      repo.pending = [
        mkPending({ id: 'local_b', externalId: 'txn_pending_b', txnDate: '2026-06-20', amountCents: -5000 }),
      ]
      const pages = [[mkTxn({ id: 'txn_candidate', date: c.date, amount: c.amount, status: 'posted' })]]
      const { engine, repo: r } = makeEngine({ pages, repo })
      await engine.syncAccount(ACCOUNT)
      expect(r.gcArgs).toEqual([
        [c.expectReplacement ? { id: 'local_b', replacementId: 'txn_candidate' } : { id: 'local_b' }],
      ])
    }
  })

  it('pending-status fetched rows are never replacement candidates', async () => {
    const repo = new FakeRepo()
    repo.pending = [
      mkPending({ id: 'local_pp', externalId: 'txn_gone_p', txnDate: '2026-07-01', amountCents: -5000 }),
    ]
    const pages = [[mkTxn({ id: 'txn_new_pending', date: '2026-07-01', amount: '-50.00', status: 'pending' })]]
    const { engine, repo: r } = makeEngine({ pages, repo })
    await engine.syncAccount(ACCOUNT)
    expect(r.gcArgs).toEqual([[{ id: 'local_pp' }]])
  })

  it('an already-known posted row is not treated as the replacement', async () => {
    const repo = new FakeRepo()
    repo.known = new Set(['txn_old_posted'])
    repo.pending = [
      mkPending({ id: 'local_k', externalId: 'txn_gone_k', txnDate: '2026-07-01', amountCents: -5000 }),
    ]
    const pages = [[mkTxn({ id: 'txn_old_posted', date: '2026-07-01', amount: '-50.00', status: 'posted' })]]
    const { engine, repo: r } = makeEngine({ pages, repo })
    await engine.syncAccount(ACCOUNT)
    expect(r.gcArgs).toEqual([[{ id: 'local_k' }]])
  })

  it('a replacement candidate is consumed at most once', async () => {
    const repo = new FakeRepo()
    repo.pending = [
      mkPending({ id: 'local_1', externalId: 'txn_g1', txnDate: '2026-07-01', amountCents: -5000 }),
      mkPending({ id: 'local_2', externalId: 'txn_g2', txnDate: '2026-07-01', amountCents: -5000 }),
    ]
    const pages = [[mkTxn({ id: 'txn_single', date: '2026-07-02', amount: '-50.00', status: 'posted' })]]
    const { engine, repo: r } = makeEngine({ pages, repo })
    const result = await engine.syncAccount(ACCOUNT)
    expect(result.gcPending).toBe(2)
    expect(r.gcArgs).toEqual([[{ id: 'local_1', replacementId: 'txn_single' }, { id: 'local_2' }]])
  })

  it('non-teller pendings are ignored by GC', async () => {
    const repo = new FakeRepo()
    repo.pending = [
      mkPending({ id: 'local_csv', externalId: 'ref_123', source: 'amex_csv', txnDate: '2026-07-01' }),
    ]
    const { engine, repo: r } = makeEngine({ pages: [[mkTxn({ id: 'txn_a' })]], repo })
    const result = await engine.syncAccount(ACCOUNT)
    expect(result.gcPending).toBe(0)
    expect(r.gcArgs).toHaveLength(0)
  })

  it('GC runs AFTER reconcile decisions are applied (replacement row exists first)', async () => {
    const repo = new FakeRepo()
    repo.pending = [
      mkPending({ id: 'local_o', externalId: 'txn_gone_o', txnDate: '2026-07-01', amountCents: -5000 }),
    ]
    const pages = [[mkTxn({ id: 'txn_repl', date: '2026-07-02', amount: '-55.00', status: 'posted' })]]
    const { engine, repo: r } = makeEngine({ pages, repo })
    await engine.syncAccount(ACCOUNT)
    expect(r.ops).toEqual(['apply', 'gc'])
  })

  it('an empty (but successful) fetch tombstones absent pendings', async () => {
    const repo = new FakeRepo()
    repo.pending = [mkPending({ id: 'local_e', externalId: 'txn_gone_e', txnDate: '2026-07-04' })]
    const { engine, repo: r } = makeEngine({ pages: [[]], repo })
    const result = await engine.syncAccount(ACCOUNT)
    expect(result).toEqual({ fetched: 0, inserted: 0, matched: 0, gcPending: 1, error: null })
    expect(r.gcArgs).toEqual([[{ id: 'local_e' }]])
    expect(r.applied).toHaveLength(0) // nothing to reconcile
  })
})

describe('SyncEngine — error handling', () => {
  it('EnrollmentInactiveError → reconnect_required marker, no repo writes, no throw', async () => {
    const repo = new FakeRepo()
    repo.pending = [mkPending({ id: 'local_x', externalId: 'txn_x', txnDate: '2026-07-01' })]
    const { fn } = recordingReconcile()
    const engine = new SyncEngine({
      client: new ThrowingClient(new EnrollmentInactiveError('enrollment.disconnected')),
      repo,
      clock: new FixedClock('2026-07-06'),
      reconcile: fn,
    })
    const result = await engine.syncAccount(ACCOUNT)
    expect(result).toEqual({ fetched: 0, inserted: 0, matched: 0, gcPending: 0, error: 'reconnect_required' })
    expect(repo.ops).toEqual([]) // partial window must never trigger GC or writes
  })

  it('rate-limit exhaustion is rethrown', async () => {
    const { fn } = recordingReconcile()
    const engine = new SyncEngine({
      client: new ThrowingClient(new RateLimitError('rate limited after 3 attempts')),
      repo: new FakeRepo(),
      clock: new FixedClock('2026-07-06'),
      reconcile: fn,
    })
    await expect(engine.syncAccount(ACCOUNT)).rejects.toBeInstanceOf(RateLimitError)
  })

  it('unexpected errors are rethrown, never swallowed', async () => {
    const { fn } = recordingReconcile()
    const engine = new SyncEngine({
      client: new ThrowingClient(new Error('boom')),
      repo: new FakeRepo(),
      clock: new FixedClock('2026-07-06'),
      reconcile: fn,
    })
    await expect(engine.syncAccount(ACCOUNT)).rejects.toThrow('boom')
  })
})
