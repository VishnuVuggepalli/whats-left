/**
 * Plan §5c required scenarios: idempotency, cross-source matching,
 * namespace-scoped strictIdChecking, candidate consumption, ±7-day window.
 */
import { describe, expect, it } from 'vitest'
import { idNamespace, reconcile } from './reconciler'
import { decisionAt, deepFreeze, expectMatch, makeDraft, makeExisting } from './testSupport'

describe('reconcile — §5c test (a): CSV backfill then Teller drafts', () => {
  it('matches every Teller draft into the CSV rows: 0 inserts, N matches', () => {
    const rowCoffee = makeExisting({ txnDate: '2026-01-05', postDate: '2026-01-06', amountCents: -1234, normalizedPayee: 'starbucks' })
    const rowGas = makeExisting({ txnDate: '2026-01-10', postDate: '2026-01-11', amountCents: -5000, normalizedPayee: 'shell oil' })
    const rowRefund = makeExisting({ txnDate: '2026-01-15', postDate: '2026-01-16', amountCents: 2500, normalizedPayee: 'refund co' })
    const drafts = [
      makeDraft({ externalId: 'tel_1', txnDate: '2026-01-06', postDate: '2026-01-06', amountCents: -1234, importedPayee: 'Starbucks' }),
      makeDraft({ externalId: 'tel_2', txnDate: '2026-01-11', postDate: '2026-01-11', amountCents: -5000, importedPayee: 'Shell Oil' }),
      makeDraft({ externalId: 'tel_3', txnDate: '2026-01-16', postDate: '2026-01-16', amountCents: 2500, importedPayee: 'Refund Co' }),
    ]
    const out = reconcile(drafts, [rowCoffee, rowGas, rowRefund])
    expect(out.inserted).toBe(0)
    expect(out.matched).toBe(3)
    expect(out.skipped).toBe(0)
    const matchedIds = out.decisions.map((d) => (d.kind === 'match' ? d.existingId : null))
    expect(matchedIds).toEqual([rowCoffee.id, rowGas.id, rowRefund.id])
    for (const d of out.decisions) {
      const m = expectMatch(d)
      expect(m.updates.linkedSourceId).toBe(m.draft.externalId)
      expect(m.updates.externalId).toBe(m.draft.externalId) // existing had none → upgraded
    }
  })
})

describe('reconcile — §5c test (b): candidate consumption', () => {
  it('pairs 2 identical same-day CSV coffees with 2 identical Teller coffees 1:1', () => {
    const rows = [
      makeExisting({ txnDate: '2026-03-01', amountCents: -450, normalizedPayee: 'blue bottle' }),
      makeExisting({ txnDate: '2026-03-01', amountCents: -450, normalizedPayee: 'blue bottle' }),
    ]
    const drafts = [
      makeDraft({ externalId: 'tel_a', txnDate: '2026-03-01', amountCents: -450 }),
      makeDraft({ externalId: 'tel_b', txnDate: '2026-03-01', amountCents: -450 }),
    ]
    const out = reconcile(drafts, rows)
    expect(out.matched).toBe(2)
    expect(out.inserted).toBe(0)
    const ids = out.decisions.map((d) => (d.kind === 'match' ? d.existingId : '?'))
    expect(new Set(ids).size).toBe(2) // never 2x2 onto one row, never 0
  })

  it('one existing row absorbs at most one of two identical drafts; the other inserts', () => {
    const rows = [makeExisting({ txnDate: '2026-03-01', amountCents: -450 })]
    const drafts = [
      makeDraft({ externalId: 'tel_a', txnDate: '2026-03-01', amountCents: -450 }),
      makeDraft({ externalId: 'tel_b', txnDate: '2026-03-01', amountCents: -450 }),
    ]
    const out = reconcile(drafts, rows)
    expect(decisionAt(out, 0).kind).toBe('match')
    expect(decisionAt(out, 1).kind).toBe('insert')
  })

  it('pass-0 duplicate claims its row before a fuzzy near-miss in the same batch', () => {
    const row = makeExisting({ importHash: 'H', txnDate: '2026-04-01', amountCents: -500, normalizedPayee: 'cafe' })
    const nearMiss = makeDraft({ source: 'chase_csv', importHash: 'H2', txnDate: '2026-04-01', amountCents: -500, importedPayee: 'Cafe' })
    const exactDup = makeDraft({ source: 'chase_csv', importHash: 'H', txnDate: '2026-04-01', amountCents: -500, importedPayee: 'Cafe' })
    const out = reconcile([nearMiss, exactDup], [row])
    expect(decisionAt(out, 1)).toMatchObject({ kind: 'skip_duplicate', existingId: row.id })
    expect(decisionAt(out, 0).kind).toBe('insert') // row already consumed by its exact duplicate
  })
})

describe('reconcile — §5c test (c): date precedence stable in both import orders', () => {
  const JAN30 = '2026-01-30'
  const FEB2 = '2026-02-02'

  it('order 1: CSV row exists, Teller draft arrives → txnDate stays Jan-30', () => {
    const row = makeExisting({ txnDate: JAN30, postDate: '2026-02-01', amountCents: -7800 })
    const draft = makeDraft({ externalId: 'tel_c', txnDate: FEB2, postDate: FEB2, amountCents: -7800 })
    const m = expectMatch(decisionAt(reconcile([draft], [row]), 0))
    expect(m.updates.txnDate).toBeUndefined() // never overwrite Jan-30 with a later date
  })

  it('order 2: Teller row exists, CSV draft arrives → txnDate updated to Jan-30', () => {
    const row = makeExisting({ source: 'teller', externalId: 'tel_c', txnDate: FEB2, postDate: FEB2, amountCents: -7800 })
    const draft = makeDraft({ source: 'chase_csv', externalId: null, txnDate: JAN30, postDate: '2026-02-01', amountCents: -7800 })
    const m = expectMatch(decisionAt(reconcile([draft], [row]), 0))
    expect(m.updates.txnDate).toBe(JAN30)
  })
})

describe('reconcile — §5c test (d): re-reconcile of already-ingested drafts', () => {
  it('re-imported CSV drafts all skip via (source, importHash): 0 inserts, 0 matches', () => {
    const draft1 = makeDraft({ source: 'chase_csv', importHash: 'h1', txnDate: '2026-05-01', amountCents: -100 })
    const draft2 = makeDraft({ source: 'chase_csv', importHash: 'h2', txnDate: '2026-05-02', amountCents: -200 })
    const row1 = makeExisting({ source: 'chase_csv', importHash: 'h1', txnDate: '2026-05-01', amountCents: -100 })
    const row2 = makeExisting({ source: 'chase_csv', importHash: 'h2', txnDate: '2026-05-02', amountCents: -200 })
    const out = reconcile([draft1, draft2], [row1, row2])
    expect(out).toMatchObject({ inserted: 0, matched: 0, skipped: 2 })
    expect(decisionAt(out, 0)).toMatchObject({ kind: 'skip_duplicate', existingId: row1.id })
    expect(decisionAt(out, 1)).toMatchObject({ kind: 'skip_duplicate', existingId: row2.id })
  })

  it('re-synced Teller drafts skip via same-namespace externalId even when importHash differs', () => {
    const row = makeExisting({ source: 'teller', externalId: 'tel_9', importHash: 'old_hash', txnDate: '2026-05-03', amountCents: -300 })
    const draft = makeDraft({ source: 'teller', externalId: 'tel_9', importHash: 'new_hash', txnDate: '2026-05-03', amountCents: -300 })
    const out = reconcile([draft], [row])
    expect(decisionAt(out, 0)).toMatchObject({ kind: 'skip_duplicate', existingId: row.id })
    expect(out).toMatchObject({ inserted: 0, matched: 0, skipped: 1 })
  })
})

describe('reconcile — namespace-scoped strictIdChecking', () => {
  it('never merges two different Teller ids with the same amount/date', () => {
    const row = makeExisting({ source: 'teller', externalId: 'tel_a', txnDate: '2026-06-01', amountCents: -999 })
    const draft = makeDraft({ source: 'teller', externalId: 'tel_b', txnDate: '2026-06-01', amountCents: -999 })
    const out = reconcile([draft], [row])
    expect(decisionAt(out, 0).kind).toBe('insert')
    expect(out.matched).toBe(0)
  })

  it('never merges two different Amex References (same namespace)', () => {
    const row = makeExisting({ source: 'amex_csv', externalId: 'REF_1', txnDate: '2026-06-01', amountCents: -999 })
    const draft = makeDraft({ source: 'amex_csv', externalId: 'REF_2', txnDate: '2026-06-01', amountCents: -999 })
    expect(decisionAt(reconcile([draft], [row]), 0).kind).toBe('insert')
  })

  it('cross-namespace pairs merge even when BOTH carry bank-issued ids', () => {
    const row = makeExisting({ source: 'amex_csv', externalId: 'REF_1', txnDate: '2026-06-01', amountCents: -999 })
    const draft = makeDraft({ source: 'teller', externalId: 'tel_z', txnDate: '2026-06-01', amountCents: -999 })
    const m = expectMatch(decisionAt(reconcile([draft], [row]), 0))
    expect(m.existingId).toBe(row.id)
    expect(m.updates.externalId).toBeUndefined() // existing id is never overwritten
  })

  it('same-source hash-only row is fuzzy-eligible (synthesized importHash is NOT an id)', () => {
    const row = makeExisting({ source: 'amex_csv', externalId: null, importHash: 'hash_only', txnDate: '2026-06-02', amountCents: -777 })
    const draft = makeDraft({ source: 'amex_csv', externalId: 'REF_9', importHash: 'other_hash', txnDate: '2026-06-02', amountCents: -777 })
    const m = expectMatch(decisionAt(reconcile([draft], [row]), 0))
    expect(m.updates.externalId).toBe('REF_9') // same-source upgrade case
  })

  it('two different Plaid ids on plaid-source rows never fuzzy-merge', () => {
    // Plaid transaction_ids have NO reliable prefix, so idNamespace() calls
    // them 'unknown' — the same-source fallback guard blocks the merge because
    // every plaid row shares source 'plaid'. This is what keeps a posted txn
    // (new id, pending_transaction_id set) from swallowing its pending twin:
    // the pending is tombstoned via gcPending instead.
    expect(idNamespace('plaid-txn-abc123')).toBe('unknown')
    const row = makeExisting({ source: 'plaid', externalId: 'plaid-txn-a', txnDate: '2026-06-01', amountCents: -999 })
    const draft = makeDraft({ source: 'plaid', externalId: 'plaid-txn-b', txnDate: '2026-06-01', amountCents: -999 })
    const out = reconcile([draft], [row])
    expect(decisionAt(out, 0).kind).toBe('insert')
    expect(out.matched).toBe(0)
  })

  it('plaid ↔ hash-only csv rows stay fuzzy-eligible (cross-source backfill overlap)', () => {
    const row = makeExisting({ source: 'chase_csv', externalId: null, importHash: 'csv_hash', txnDate: '2026-06-01', amountCents: -999 })
    const draft = makeDraft({ source: 'plaid', externalId: 'plaid-txn-c', txnDate: '2026-06-01', amountCents: -999 })
    const m = expectMatch(decisionAt(reconcile([draft], [row]), 0))
    expect(m.existingId).toBe(row.id)
    expect(m.updates.externalId).toBe('plaid-txn-c') // csv twin adopts the plaid id
  })
})

describe('reconcile — ±7 day fuzzy window on post-or-txn date', () => {
  const base = makeExisting({ postDate: '2026-03-10', txnDate: '2026-03-10', amountCents: -1500 })

  it.each([
    ['2026-03-17', 'match'], // +7 days: inside
    ['2026-03-03', 'match'], // -7 days: inside
    ['2026-03-18', 'insert'], // +8 days: outside
    ['2026-03-02', 'insert'], // -8 days: outside
  ])('draft dated %s → %s', (date, kind) => {
    const draft = makeDraft({ externalId: 'tel_w', txnDate: date, postDate: date, amountCents: -1500 })
    expect(decisionAt(reconcile([draft], [base]), 0).kind).toBe(kind)
  })

  it('uses postDate as the anchor when present, not txnDate', () => {
    const row = makeExisting({ txnDate: '2026-01-01', postDate: '2026-01-20', amountCents: -2000 })
    const draft = makeDraft({ externalId: 'tel_p', txnDate: '2026-01-22', postDate: null, amountCents: -2000 })
    expect(decisionAt(reconcile([draft], [row]), 0).kind).toBe('match') // 2 days from postDate; 21 from txnDate
  })

  it('falls back to txnDate as anchor when postDate is null', () => {
    const row = makeExisting({ txnDate: '2026-01-01', postDate: null, amountCents: -2000 })
    const draft = makeDraft({ externalId: 'tel_q', txnDate: '2026-01-22', postDate: null, amountCents: -2000 })
    expect(decisionAt(reconcile([draft], [row]), 0).kind).toBe('insert')
  })

  it('requires EXACT amount equality — one cent or sign flip means insert', () => {
    const row = makeExisting({ txnDate: '2026-03-10', amountCents: -450 })
    const offByOne = makeDraft({ txnDate: '2026-03-10', amountCents: -451 })
    const signFlip = makeDraft({ txnDate: '2026-03-10', amountCents: 450 })
    const out = reconcile([offByOne, signFlip], [row])
    expect(out.decisions.map((d) => d.kind)).toEqual(['insert', 'insert'])
  })
})

describe('reconcile — pass 0 same-id state delta (ids often survive pending→posted)', () => {
  it('same teller id, pending→posted: emits a match that upgrades status and fills postDate', () => {
    const row = makeExisting({
      source: 'teller', externalId: 'txn_same', importHash: 'H_same',
      status: 'pending', postDate: null, txnDate: '2026-07-01', amountCents: -640,
    })
    const draft = makeDraft({
      source: 'teller', externalId: 'txn_same', importHash: 'H_same',
      status: 'posted', postDate: '2026-07-03', txnDate: '2026-07-01', amountCents: -640,
    })
    const out = reconcile([draft], [row])
    const m = expectMatch(decisionAt(out, 0))
    expect(m.existingId).toBe(row.id)
    expect(m.updates.status).toBe('posted')
    expect(m.updates.postDate).toBe('2026-07-03')
    expect(out).toMatchObject({ inserted: 0, matched: 1, skipped: 0 })
  })

  it('same-id dup with an earlier draft txnDate: match carrying txnDate = min', () => {
    const row = makeExisting({ source: 'teller', externalId: 'txn_d', importHash: 'H_d', txnDate: '2026-07-05', amountCents: -100 })
    const draft = makeDraft({ source: 'teller', externalId: 'txn_d', importHash: 'H_d', txnDate: '2026-07-02', amountCents: -100 })
    const m = expectMatch(decisionAt(reconcile([draft], [row]), 0))
    expect(m.updates.txnDate).toBe('2026-07-02')
  })

  it('same-id dup with NO state delta stays a skip_duplicate', () => {
    const row = makeExisting({ source: 'teller', externalId: 'txn_n', importHash: 'H_n', status: 'posted', txnDate: '2026-07-01', postDate: '2026-07-01', amountCents: -100 })
    const draft = makeDraft({ source: 'teller', externalId: 'txn_n', importHash: 'H_n', status: 'posted', txnDate: '2026-07-01', postDate: '2026-07-01', amountCents: -100 })
    const out = reconcile([draft], [row])
    expect(decisionAt(out, 0)).toMatchObject({ kind: 'skip_duplicate', existingId: row.id })
    expect(out).toMatchObject({ inserted: 0, matched: 0, skipped: 1 })
  })
})

describe('reconcile — adopted external ids (id value is the namespace, not row.source)', () => {
  it('pass 0 catches a teller draft whose id was adopted by a csv-source row: no duplicate insert', () => {
    const row = makeExisting({
      source: 'chase_csv', externalId: 'txn_adopted', importHash: 'csv_h',
      status: 'posted', txnDate: '2026-06-25', postDate: '2026-06-27', amountCents: -675,
    })
    const draft = makeDraft({
      source: 'teller', externalId: 'txn_adopted', importHash: 'teller_h',
      status: 'posted', txnDate: '2026-06-27', postDate: '2026-06-27', amountCents: -675,
    })
    const out = reconcile([draft], [row])
    expect(out.inserted).toBe(0)
    expect(decisionAt(out, 0)).toMatchObject({ kind: 'skip_duplicate', existingId: row.id })
  })

  it('two DIFFERENT teller ids never fuzzy-merge, even when one sits on a csv-source row', () => {
    const row = makeExisting({ source: 'chase_csv', externalId: 'txn_aaa', txnDate: '2026-06-01', amountCents: -999 })
    const draft = makeDraft({ source: 'teller', externalId: 'txn_bbb', txnDate: '2026-06-01', amountCents: -999 })
    const out = reconcile([draft], [row])
    expect(decisionAt(out, 0).kind).toBe('insert')
    expect(out.matched).toBe(0)
  })

  it('an amex-namespace id on a csv row still merges with a teller-id draft (cross-namespace)', () => {
    const row = makeExisting({ source: 'amex_csv', externalId: '320261234567890', txnDate: '2026-06-01', amountCents: -999 })
    const draft = makeDraft({ source: 'teller', externalId: 'txn_zzz', txnDate: '2026-06-01', amountCents: -999 })
    expect(decisionAt(reconcile([draft], [row]), 0).kind).toBe('match')
  })
})

describe('reconcile — status transitions', () => {
  it('pending existing + posted draft → status update to posted', () => {
    const row = makeExisting({ source: 'teller', externalId: 'tel_p1', status: 'pending', txnDate: '2026-07-01', amountCents: -640 })
    const draft = makeDraft({ source: 'chase_csv', externalId: null, status: 'posted', txnDate: '2026-07-02', postDate: '2026-07-02', amountCents: -640 })
    const m = expectMatch(decisionAt(reconcile([draft], [row]), 0))
    expect(m.updates.status).toBe('posted')
  })

  it('posted existing + pending draft → never downgraded', () => {
    const row = makeExisting({ status: 'posted', txnDate: '2026-07-01', amountCents: -640 })
    const draft = makeDraft({ externalId: 'tel_p2', status: 'pending', txnDate: '2026-07-01', amountCents: -640 })
    const m = expectMatch(decisionAt(reconcile([draft], [row]), 0))
    expect(m.updates.status).toBeUndefined()
  })
})

describe('reconcile — boundaries and invariants', () => {
  it('throws when existing rows span multiple accounts', () => {
    const rows = [makeExisting({ accountId: 'acct_1' }), makeExisting({ accountId: 'acct_2' })]
    expect(() => reconcile([], rows)).toThrow(/account/i)
  })

  it('handles empty inputs', () => {
    expect(reconcile([], [])).toEqual({ decisions: [], inserted: 0, matched: 0, skipped: 0 })
  })

  it('inserts everything when there are no existing rows', () => {
    const drafts = [makeDraft(), makeDraft({ amountCents: -900 })]
    const out = reconcile(drafts, [])
    expect(out).toMatchObject({ inserted: 2, matched: 0, skipped: 0 })
    expect(out.decisions.map((d) => d.kind)).toEqual(['insert', 'insert'])
  })

  it('never mutates its inputs (deep-frozen inputs do not throw)', () => {
    const row = makeExisting({ txnDate: '2026-03-01', amountCents: -450, status: 'pending' })
    const rows = deepFreeze([row])
    const drafts = deepFreeze([
      makeDraft({ externalId: 'tel_f', txnDate: '2026-03-02', postDate: '2026-03-02', amountCents: -450 }),
      makeDraft({ amountCents: -111 }),
    ])
    const out = reconcile(drafts, rows)
    expect(out.matched).toBe(1)
    expect(out.inserted).toBe(1)
    expect(row.txnDate).toBe('2026-03-01')
    expect(row.status).toBe('pending')
  })

  it('match updates never contain categorization fields (invariant 5)', () => {
    const row = makeExisting({ txnDate: '2026-03-01', amountCents: -450, categorySource: 'user' })
    const draft = makeDraft({ externalId: 'tel_g', txnDate: '2026-03-01', amountCents: -450 })
    const m = expectMatch(decisionAt(reconcile([draft], [row]), 0))
    const allowed = new Set(['txnDate', 'postDate', 'status', 'linkedSourceId', 'externalId'])
    for (const key of Object.keys(m.updates)) {
      expect(allowed.has(key)).toBe(true)
    }
  })
})
