import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ItemLoginRequiredError } from './client'
import { draftsForAccount, mapPlaidTxn, plaidAmountToCents, plaidImportHash } from './sync'
import {
  FakePlaidRepo,
  fixturePage1,
  fixturePage2,
  ITEM,
  makeEngine,
  MemoryCursorStore,
  mkPage,
  mkPending,
  mkPlaidTxn,
} from './syncTestSupport'

describe('plaidAmountToCents — sign inversion + float→cents rounding', () => {
  it('inverts Plaid positive (money out) to our negative', () => {
    expect(plaidAmountToCents(87.1)).toBe(-8710) // 87.10*100 === 8709.999… without rounding
    expect(plaidAmountToCents(6.75)).toBe(-675)
  })

  it('survives the 4.10*100 float trap', () => {
    expect(4.1 * 100).not.toBe(410) // the trap is real
    expect(plaidAmountToCents(4.1)).toBe(-410)
  })

  it('inverts Plaid negative (money in) to our positive', () => {
    expect(plaidAmountToCents(-2500)).toBe(250000)
    expect(plaidAmountToCents(-0.01)).toBe(1)
  })
})

describe('mapPlaidTxn', () => {
  const byId = new Map(
    [...fixturePage1.added, ...fixturePage2.added].map((t) => [t.transaction_id, t]),
  )

  it('maps a posted transaction (inversion, dates, merchant payee, PFC detailed)', () => {
    const groceries = byId.get('plaid-txn-groceries-02')
    if (!groceries) throw new Error('fixture missing plaid-txn-groceries-02')
    expect(mapPlaidTxn(groceries)).toEqual({
      source: 'plaid',
      externalId: 'plaid-txn-groceries-02',
      importHash: createHash('sha256').update('plaid:plaid-txn-groceries-02').digest('hex'),
      txnDate: '2026-06-27', // authorized (swipe) date wins over posted date
      postDate: '2026-06-28',
      amountCents: -8710,
      status: 'posted',
      rawDescription: 'WHOLEFDS SEA 10221 SEATTLE WA',
      importedPayee: 'Whole Foods Market',
      sourceCategory: 'FOOD_AND_DRINK_GROCERIES',
      counterparty: 'Whole Foods Market',
      typeCode: null,
    })
  })

  it('maps a pending transaction: null postDate, pending status, float-trap cents', () => {
    const pending = byId.get('plaid-txn-pending-coffee-01')
    if (!pending) throw new Error('fixture missing plaid-txn-pending-coffee-01')
    const draft = mapPlaidTxn(pending)
    expect(draft.status).toBe('pending')
    expect(draft.postDate).toBeNull()
    expect(draft.txnDate).toBe('2026-07-04')
    expect(draft.amountCents).toBe(-410) // 4.10 dollars out, rounded not truncated
  })

  it('falls back to date and name when authorized_date/merchant_name are null', () => {
    const payroll = fixturePage1.added.find((t) => t.transaction_id === 'plaid-txn-payroll-03')
    if (!payroll) throw new Error('fixture missing plaid-txn-payroll-03')
    const draft = mapPlaidTxn(payroll)
    expect(draft.txnDate).toBe('2026-06-26')
    expect(draft.importedPayee).toBe('ACME CORP PAYROLL 260626')
    expect(draft.counterparty).toBeNull()
    expect(draft.amountCents).toBe(250000) // money in
  })

  it('sourceCategory falls back detailed → primary → null', () => {
    const base = mkPlaidTxn({ transaction_id: 'plaid-t1' })
    expect(mapPlaidTxn(base).sourceCategory).toBeNull()
    const primaryOnly = mkPlaidTxn({
      transaction_id: 'plaid-t2',
      personal_finance_category: { primary: 'TRAVEL', detailed: 'TRAVEL_FLIGHTS', confidence_level: null },
    })
    expect(mapPlaidTxn(primaryOnly).sourceCategory).toBe('TRAVEL_FLIGHTS')
  })

  it('plaidImportHash is deterministic and namespaced away from teller hashes', () => {
    expect(plaidImportHash('x')).toBe(plaidImportHash('x'))
    expect(plaidImportHash('x')).not.toBe(plaidImportHash('y'))
    // teller hashes sha256(id); plaid hashes sha256('plaid:'+id) — same bank id
    // string can never produce a colliding import hash across providers
    expect(plaidImportHash('x')).not.toBe(createHash('sha256').update('x').digest('hex'))
  })
})

describe('PlaidSyncEngine — fixture batch across two pages', () => {
  it('accumulates pages via the cursor chain and reports per-account counts', async () => {
    const { engine, repo, client, reconcileCalls } = makeEngine({
      pages: [fixturePage1, fixturePage2],
    })
    const result = await engine.syncItem(ITEM)

    // cursor chain: first call without cursor, second with page1's next_cursor
    expect(client.calls).toEqual([
      { accessToken: 'access-token-01', cursor: undefined },
      { accessToken: 'access-token-01', cursor: 'plaid-cursor-page-1' },
    ])

    expect(result.error).toBeNull()
    const chase = result.accounts.find((a) => a.accountId === 'app_acc_chase')
    const amex = result.accounts.find((a) => a.accountId === 'app_acc_amex')
    expect(chase).toMatchObject({ fetched: 1, inserted: 1, matched: 0, gcPending: 0 })
    // amex: pending coffee + groceries (deduped added+modified) + posted coffee
    // + 1 removed; gcPending = replaced pending + removed tombstone
    expect(amex).toMatchObject({ fetched: 4, inserted: 3, matched: 0, gcPending: 2 })

    // reconcile ran once per account with only that account's drafts
    expect(reconcileCalls).toHaveLength(2)
    expect(repo.listExistingArgs.map((a) => a.accountId).sort()).toEqual([
      'app_acc_amex',
      'app_acc_chase',
    ])
  })

  it('a MODIFIED entry updates amount/dates/status by external id — later page wins the draft too', async () => {
    const { engine, repo } = makeEngine({ pages: [fixturePage1, fixturePage2] })
    await engine.syncItem(ITEM)

    expect(repo.stateUpdates).toEqual([
      {
        accountId: 'app_acc_amex',
        externalId: 'plaid-txn-groceries-02',
        state: {
          amountCents: -9241, // the MODIFIED amount, not the original -8710
          txnDate: '2026-06-27',
          postDate: '2026-06-28',
          status: 'posted',
        },
      },
    ])
    // the draft handed to the reconciler already carries the modified amount
    const amexApply = repo.applied.find((a) => a.accountId === 'app_acc_amex')
    const groceriesDraft = amexApply?.outcome.decisions
      .map((d) => d.draft)
      .find((d) => d.externalId === 'plaid-txn-groceries-02')
    expect(groceriesDraft?.amountCents).toBe(-9241)
  })

  it('pending_transaction_id → gcPending(local pending id, replacement bank id) — no presence heuristics', async () => {
    const { engine, repo } = makeEngine({ pages: [fixturePage1, fixturePage2] })
    await engine.syncItem(ITEM)

    expect(repo.gcArgs).toEqual([
      [
        {
          id: 'inserted_plaid-txn-pending-coffee-01',
          replacementExternalId: 'plaid-txn-posted-coffee-04',
        },
      ],
    ])
    // gc runs AFTER applyDecisions so the replacement row already exists
    const amexOps = repo.ops.filter((op) => op === 'apply:app_acc_amex' || op === 'gc')
    expect(amexOps).toEqual(['apply:app_acc_amex', 'gc'])
  })

  it('an absent pending (never seen locally) is NOT gc-ed — nothing presence-based happens', async () => {
    const page = mkPage({
      added: [
        mkPlaidTxn({
          transaction_id: 'plaid-posted-1',
          pending_transaction_id: 'plaid-pending-unknown',
        }),
      ],
    })
    const { engine, repo } = makeEngine({ pages: [page] })
    // a stale LOCAL pending exists but Plaid said nothing about it → untouched
    repo.pending.set('app_acc_amex', [
      mkPending({ id: 'local_p1', externalId: 'plaid-other-pending', accountId: 'app_acc_amex' }),
    ])
    const result = await engine.syncItem(ITEM)
    expect(repo.gcArgs).toEqual([])
    expect(result.accounts.find((a) => a.accountId === 'app_acc_amex')?.gcPending).toBe(0)
  })

  it('removed[] entries are tombstoned by external id on the owning account', async () => {
    const { engine, repo } = makeEngine({ pages: [fixturePage1, fixturePage2] })
    await engine.syncItem(ITEM)
    expect(repo.tombstoned).toEqual([
      { accountId: 'app_acc_amex', externalId: 'plaid-txn-voided-hold-05' },
    ])
  })

  it('a removed[] entry without account_id is tried across the item accounts until it lands', async () => {
    const page = mkPage({ removed: [{ transaction_id: 'plaid-txn-somewhere' }] })
    const { engine, repo } = makeEngine({ pages: [page] })
    repo.tombstoneResult = 1 // first attempt already tombstones
    await engine.syncItem(ITEM)
    expect(repo.tombstoned).toEqual([
      { accountId: 'app_acc_chase', externalId: 'plaid-txn-somewhere' },
    ])
  })

  it('reports DB-actual counts + warning when INSERT OR IGNORE swallows inserts', async () => {
    const repo = new FakePlaidRepo()
    repo.swallowInserts = 1
    const { engine } = makeEngine({ pages: [fixturePage1, fixturePage2], repo })
    const result = await engine.syncItem(ITEM)
    const chase = result.accounts.find((a) => a.accountId === 'app_acc_chase')
    expect(chase?.inserted).toBe(0) // what the DB actually wrote
    expect(chase?.warning).toMatch(/1 transaction\(s\) were not inserted/)
  })
})

describe('PlaidSyncEngine — cursor persistence discipline', () => {
  it('persists the final next_cursor exactly once, only after the whole batch applied', async () => {
    const { engine, cursors, repo } = makeEngine({ pages: [fixturePage1, fixturePage2] })
    await engine.syncItem(ITEM)
    expect(cursors.sets).toEqual([{ itemId: 'plaid-item-01', cursor: 'plaid-cursor-page-2' }])
    // …and after every repo write
    expect(repo.ops.length).toBeGreaterThan(0)
  })

  it('resumes from the stored cursor', async () => {
    const cursors = new MemoryCursorStore()
    cursors.store.set('plaid-item-01', 'stored-cursor-7')
    const { engine, client } = makeEngine({ pages: [mkPage()], cursors })
    await engine.syncItem(ITEM)
    expect(client.calls[0]?.cursor).toBe('stored-cursor-7')
  })

  it('a mid-batch apply failure propagates and the cursor does NOT advance', async () => {
    const repo = new FakePlaidRepo()
    repo.failApplyFor = 'app_acc_amex'
    const cursors = new MemoryCursorStore()
    cursors.store.set('plaid-item-01', 'cursor-before')
    const { engine } = makeEngine({ pages: [fixturePage1, fixturePage2], repo, cursors })
    await expect(engine.syncItem(ITEM)).rejects.toThrow(/simulated/)
    expect(cursors.sets).toEqual([]) // never advanced — the batch will be re-fetched
    expect(cursors.get('plaid-item-01')).toBe('cursor-before')
  })

  it('ITEM_LOGIN_REQUIRED → reconnect_required for every account, no writes, cursor untouched', async () => {
    const repo = new FakePlaidRepo()
    const cursors = new MemoryCursorStore()
    const client = {
      transactionsSync: async () => {
        throw new ItemLoginRequiredError('reconnect')
      },
    }
    const { fn } = await import('./syncTestSupport').then((m) => m.recordingReconcile())
    const { PlaidSyncEngine } = await import('./sync')
    const engine = new PlaidSyncEngine({ client, repo, reconcile: fn, cursors })
    const result = await engine.syncItem(ITEM)
    expect(result.error).toBe('reconnect_required')
    expect(result.accounts).toHaveLength(2)
    for (const account of result.accounts) {
      expect(account).toMatchObject({ fetched: 0, inserted: 0, error: 'reconnect_required' })
    }
    expect(repo.ops).toEqual([])
    expect(cursors.sets).toEqual([])
  })

  it('other client failures propagate (caller flags the accounts)', async () => {
    const repo = new FakePlaidRepo()
    const client = {
      transactionsSync: async () => {
        throw new Error('ECONNRESET')
      },
    }
    const { recordingReconcile } = await import('./syncTestSupport')
    const { PlaidSyncEngine } = await import('./sync')
    const engine = new PlaidSyncEngine({
      client,
      repo,
      reconcile: recordingReconcile().fn,
      cursors: new MemoryCursorStore(),
    })
    await expect(engine.syncItem(ITEM)).rejects.toThrow('ECONNRESET')
  })
})

describe('draftsForAccount (categorization seam)', () => {
  it('returns the deduped added+modified drafts of one account, later pages winning', () => {
    const amex = draftsForAccount([fixturePage1, fixturePage2], 'plaid-acc-amex-01')
    expect(amex.map((d) => d.externalId).sort()).toEqual([
      'plaid-txn-groceries-02',
      'plaid-txn-pending-coffee-01',
      'plaid-txn-posted-coffee-04',
    ])
    expect(amex.find((d) => d.externalId === 'plaid-txn-groceries-02')?.amountCents).toBe(-9241)

    const chase = draftsForAccount([fixturePage1, fixturePage2], 'plaid-acc-chase-01')
    expect(chase.map((d) => d.externalId)).toEqual(['plaid-txn-payroll-03'])
  })
})
