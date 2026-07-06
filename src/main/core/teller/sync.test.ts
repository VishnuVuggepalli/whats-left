import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { TellerTransaction } from './types'
import { mapTellerTxn, tellerImportHash } from './sync'
import { ACCOUNT, FakeRepo, fixtureTxns, makeEngine, mkPending, mkTxn } from './syncTestSupport'

describe('mapTellerTxn', () => {
  const byId = new Map(fixtureTxns.map((t) => [t.id, t]))

  it('maps a posted transaction (amount string → cents, postDate, counterparty payee)', () => {
    const coffee = byId.get('txn_cc_coffee_a')
    if (!coffee) throw new Error('fixture missing txn_cc_coffee_a')
    const draft = mapTellerTxn(coffee)
    expect(draft).toEqual({
      source: 'teller',
      externalId: 'txn_cc_coffee_a',
      importHash: createHash('sha256').update('txn_cc_coffee_a').digest('hex'),
      txnDate: '2026-06-27',
      postDate: '2026-06-27',
      amountCents: -675,
      status: 'posted',
      rawDescription: 'TST* COFFEE HOUSE 0042 SEATTLE WA',
      importedPayee: 'Coffee House',
      sourceCategory: 'dining',
      counterparty: 'Coffee House',
      typeCode: 'card_payment',
    })
  })

  it('maps a pending transaction: null postDate, payee falls back to description', () => {
    const pending = byId.get('txn_pending_new1')
    if (!pending) throw new Error('fixture missing txn_pending_new1')
    const draft = mapTellerTxn(pending)
    expect(draft.postDate).toBeNull()
    expect(draft.status).toBe('pending')
    expect(draft.amountCents).toBe(-4200)
    expect(draft.importedPayee).toBe('TST* THAI KITCHEN SEATTLE WA')
    expect(draft.counterparty).toBeNull()
    expect(draft.sourceCategory).toBeNull()
  })

  it('maps a positive (payment) amount without sign loss', () => {
    const payment = byId.get('txn_cc_payment')
    if (!payment) throw new Error('fixture missing txn_cc_payment')
    expect(mapTellerTxn(payment).amountCents).toBe(84355)
    expect(mapTellerTxn(payment).typeCode).toBe('payment')
  })

  it('tellerImportHash is deterministic sha256 hex of the teller id', () => {
    const expected = createHash('sha256').update('txn_x', 'utf8').digest('hex')
    expect(tellerImportHash('txn_x')).toBe(expected)
    expect(tellerImportHash('txn_x')).toBe(tellerImportHash('txn_x'))
    expect(tellerImportHash('txn_y')).not.toBe(tellerImportHash('txn_x'))
  })
})

describe('SyncEngine — fixture sync', () => {
  it('fresh sync inserts every fixture txn', async () => {
    const { engine, repo, client, reconcileCalls } = makeEngine({ pages: [fixtureTxns] })
    const result = await engine.syncAccount(ACCOUNT)
    expect(result).toEqual({
      fetched: 6, inserted: 6, matched: 0, gcPending: 0, warning: null, error: null,
    })
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]?.accountId).toBe('acc_chase_cc_1')
    expect(reconcileCalls[0]?.incoming.map((d) => d.externalId)).toContain('txn_cc_united')
    expect(repo.applied).toHaveLength(1)
    expect(repo.gcArgs).toHaveLength(0) // nothing pending locally → no GC call
  })

  it('asks the repo for existing rows from the oldest fetched date', async () => {
    const { engine, repo } = makeEngine({ pages: [fixtureTxns] })
    await engine.syncAccount(ACCOUNT)
    expect(repo.listExistingArgs).toEqual([{ accountId: ACCOUNT.id, fromDate: '2026-06-14' }])
  })

  it('reports DB-actual counts + warning when INSERT OR IGNORE swallows inserts', async () => {
    const repo = new FakeRepo()
    repo.swallowInserts = 2 // cross-account external-id collision
    const { engine } = makeEngine({ pages: [fixtureTxns], repo })
    const result = await engine.syncAccount(ACCOUNT)
    expect(result.fetched).toBe(6)
    expect(result.inserted).toBe(4) // what the DB actually wrote, not the reconciler's 6
    expect(result.warning).toMatch(/2 transaction\(s\) were not inserted/)
  })

  it('re-sync of fully known data yields matches, not inserts', async () => {
    const repo = new FakeRepo()
    repo.known = new Set(fixtureTxns.map((t) => t.id))
    repo.existing = fixtureTxns.map((t, i) =>
      mkPending({ id: `local_${i}`, externalId: t.id, status: 'posted', txnDate: t.date }),
    )
    const { engine } = makeEngine({ pages: [fixtureTxns], repo })
    const result = await engine.syncAccount(ACCOUNT)
    expect(result.fetched).toBe(6)
    expect(result.inserted).toBe(0)
    expect(result.matched).toBe(6)
  })
})

describe('SyncEngine — cursor pagination', () => {
  it('stops after K=15 consecutive already-known ids (default K)', async () => {
    const news = [mkTxn({ id: 'new_1', date: '2026-07-05' }), mkTxn({ id: 'new_2', date: '2026-07-05' })]
    const knowns = Array.from({ length: 18 }, (_, i) => mkTxn({ id: `known_${i}`, date: '2026-07-01' }))
    const page1 = [...news, ...knowns.slice(0, 8)] // 2 new + 8 known
    const page2 = knowns.slice(8, 18) // 10 known → 18 consecutive ≥ 15
    const page3 = [mkTxn({ id: 'must_not_fetch', date: '2026-06-01' })]
    const repo = new FakeRepo()
    repo.known = new Set(knowns.map((t) => t.id))
    const { engine, client } = makeEngine({ pages: [page1, page2, page3], repo, pageSize: 10 })
    const result = await engine.syncAccount(ACCOUNT)
    expect(client.calls).toHaveLength(2)
    expect(result.fetched).toBe(20)
  })

  it('passes count=pageSize and from_id=last id of the previous page', async () => {
    const page1 = Array.from({ length: 3 }, (_, i) => mkTxn({ id: `a_${i}` }))
    const page2 = [mkTxn({ id: 'b_0' })]
    const { engine, client } = makeEngine({ pages: [page1, page2], pageSize: 3 })
    await engine.syncAccount(ACCOUNT)
    expect(client.calls[0]?.opts).toEqual({ count: 3, fromId: undefined })
    expect(client.calls[1]?.opts).toEqual({ count: 3, fromId: 'a_2' })
  })

  it('resets the consecutive-known counter when an unknown id appears', async () => {
    const known = (i: number, date: string): TellerTransaction => mkTxn({ id: `k_${i}`, date })
    const page1 = [
      ...Array.from({ length: 8 }, (_, i) => known(i, '2026-07-03')),
      mkTxn({ id: 'fresh_backdated', date: '2026-07-02' }),
      known(8, '2026-07-02'),
    ]
    const page2 = Array.from({ length: 10 }, (_, i) => known(9 + i, '2026-07-01')) // consecutive 11
    const page3 = Array.from({ length: 10 }, (_, i) => known(19 + i, '2026-06-30')) // consecutive 21 → stop
    const page4 = [mkTxn({ id: 'must_not_fetch' })]
    const repo = new FakeRepo()
    repo.known = new Set(Array.from({ length: 29 }, (_, i) => `k_${i}`))
    const { engine, client } = makeEngine({ pages: [page1, page2, page3, page4], repo, pageSize: 10 })
    await engine.syncAccount(ACCOUNT)
    expect(client.calls).toHaveLength(3)
  })

  it('stops when a short page signals no more history', async () => {
    const page1 = [mkTxn({ id: 'only_one' })]
    const { engine, client } = makeEngine({ pages: [page1], pageSize: 100 })
    const result = await engine.syncAccount(ACCOUNT)
    expect(client.calls).toHaveLength(1)
    expect(result.fetched).toBe(1)
  })

  it('counts overlapping ids across pages only once', async () => {
    const shared = mkTxn({ id: 'dup_edge' })
    const page1 = [mkTxn({ id: 'p1_a' }), shared]
    const page2 = [shared, mkTxn({ id: 'p2_b' })]
    const { engine, reconcileCalls } = makeEngine({ pages: [page1, page2], pageSize: 2 })
    const result = await engine.syncAccount(ACCOUNT)
    expect(result.fetched).toBe(3)
    expect(reconcileCalls[0]?.incoming.map((d) => d.externalId).sort()).toEqual([
      'dup_edge',
      'p1_a',
      'p2_b',
    ])
  })

  it('keeps paging past K known ids until the window covers the oldest local pending', async () => {
    const pages = [
      Array.from({ length: 5 }, (_, i) => mkTxn({ id: `jul_${i}`, date: '2026-07-01' })),
      Array.from({ length: 5 }, (_, i) => mkTxn({ id: `jun_${i}`, date: '2026-06-10' })),
      Array.from({ length: 5 }, (_, i) => mkTxn({ id: `apr_${i}`, date: '2026-04-30' })),
      [mkTxn({ id: 'must_not_fetch' })],
    ]
    const allIds = pages.slice(0, 3).flatMap((p) => p.map((t) => t.id))

    // without pendings: K=3 consecutive known stops after page 1
    const repoA = new FakeRepo()
    repoA.known = new Set(allIds)
    const a = makeEngine({ pages, repo: repoA, pageSize: 5, stopAfterKnown: 3 })
    await a.engine.syncAccount(ACCOUNT)
    expect(a.client.calls).toHaveLength(1)

    // with a pending dated 2026-05-01: page until oldest fetched date < 2026-05-01
    const repoB = new FakeRepo()
    repoB.known = new Set(allIds)
    repoB.pending = [mkPending({ id: 'p_old', externalId: 'txn_p_old', txnDate: '2026-05-01' })]
    const b = makeEngine({ pages, repo: repoB, pageSize: 5, stopAfterKnown: 3 })
    await b.engine.syncAccount(ACCOUNT)
    expect(b.client.calls).toHaveLength(3)
  })
})
