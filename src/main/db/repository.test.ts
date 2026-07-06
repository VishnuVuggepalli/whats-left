import { describe, expect, it } from 'vitest'
import type { ReconcileOutcome } from '../core/ports'
import { draft, getTxnRow, insertAccount, insertTxn, makeRepo } from './testSupport'

function emptyOutcome(decisions: ReconcileOutcome['decisions']): ReconcileOutcome {
  return { decisions, inserted: 0, matched: 0, skipped: 0 }
}

describe('SqliteRepo accounts', () => {
  it('createAccount persists and is readable via getAccount/listAccounts', () => {
    const { repo } = makeRepo()
    const created = repo.createAccount({
      name: 'Chase Credit',
      institution: 'chase',
      sourceKind: 'csv_only',
      type: 'credit',
      mask: '4321',
    })
    expect(created.id).toBeTruthy()
    expect(created).toMatchObject({
      name: 'Chase Credit',
      institution: 'chase',
      sourceKind: 'csv_only',
      type: 'credit',
      mask: '4321',
      status: 'ok',
      closed: false,
    })
    expect(repo.getAccount(created.id)).toEqual(created)
    expect(repo.listAccounts()).toEqual([created])
  })

  it('createAccount validates input', () => {
    const { repo } = makeRepo()
    expect(() =>
      repo.createAccount({ name: '  ', institution: 'chase', sourceKind: 'csv_only', type: 'credit' }),
    ).toThrow(/name/i)
    expect(() =>
      repo.createAccount({
        name: 'X',
        // @ts-expect-error bad institution must be rejected at runtime too
        institution: 'citi',
        sourceKind: 'csv_only',
        type: 'credit',
      }),
    ).toThrow(/institution/i)
  })

  it('updateAccountStatus updates and throws on unknown account', () => {
    const { repo } = makeRepo()
    const acct = repo.createAccount({
      name: 'A',
      institution: 'amex',
      sourceKind: 'teller',
      type: 'credit',
    })
    repo.updateAccountStatus(acct.id, 'reconnect_required')
    expect(repo.getAccount(acct.id)?.status).toBe('reconnect_required')
    expect(() => repo.updateAccountStatus('nope', 'ok')).toThrow(/nope/)
  })

  it('listAccounts and getAccount exclude tombstoned accounts', () => {
    const { db, repo } = makeRepo()
    const id = insertAccount(db)
    db.prepare('UPDATE accounts SET tombstone = 1 WHERE id = ?').run(id)
    expect(repo.listAccounts()).toEqual([])
    expect(repo.getAccount(id)).toBeNull()
  })
})

describe('SqliteRepo.linkCsvHistory', () => {
  it('moves transactions to the teller account, tombstones the csv account, returns count', () => {
    const { db, repo } = makeRepo()
    const csvId = insertAccount(db, { sourceKind: 'csv_only' })
    const tellerId = insertAccount(db, { sourceKind: 'teller' })
    const t1 = insertTxn(db, csvId)
    const t2 = insertTxn(db, csvId)
    insertTxn(db, tellerId, { source: 'teller' })

    const moved = repo.linkCsvHistory(csvId, tellerId)
    expect(moved).toBe(2)
    expect(getTxnRow(db, t1)['account_id']).toBe(tellerId)
    expect(getTxnRow(db, t2)['account_id']).toBe(tellerId)
    expect(repo.getAccount(csvId)).toBeNull()
    expect(repo.getAccount(tellerId)).not.toBeNull()
  })

  it('rejects a source account that is not csv_only', () => {
    const { db, repo } = makeRepo()
    const a = insertAccount(db, { sourceKind: 'teller' })
    const b = insertAccount(db, { sourceKind: 'teller' })
    expect(() => repo.linkCsvHistory(a, b)).toThrow(/csv_only/)
  })

  it('throws on unknown accounts', () => {
    const { db, repo } = makeRepo()
    const csvId = insertAccount(db, { sourceKind: 'csv_only' })
    expect(() => repo.linkCsvHistory('ghost', csvId)).toThrow(/ghost/)
    expect(() => repo.linkCsvHistory(csvId, 'ghost')).toThrow(/ghost/)
  })
})

describe('SqliteRepo TxnRepoPort reads', () => {
  it('listExisting maps rows and normalizedPayee mirrors imported_payee', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    insertTxn(db, acct, {
      importedPayee: 'Blue Bottle',
      txnDate: '2026-06-02',
      amountCents: -775,
      categorySource: 'user',
      categoryId: 'food_and_drink',
    })
    const rows = repo.listExisting(acct, null)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      accountId: acct,
      normalizedPayee: 'Blue Bottle',
      txnDate: '2026-06-02',
      amountCents: -775,
      categorySource: 'user',
      status: 'posted',
    })
  })

  it('listExisting fromDate keeps rows whose txn_date OR post_date is >= fromDate', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const old = insertTxn(db, acct, { txnDate: '2026-01-05', postDate: '2026-01-06' })
    const byTxnDate = insertTxn(db, acct, { txnDate: '2026-06-01', postDate: null })
    const byPostDate = insertTxn(db, acct, { txnDate: '2026-05-30', postDate: '2026-06-02' })
    const tombstoned = insertTxn(db, acct, { txnDate: '2026-06-09' })
    db.prepare('UPDATE transactions SET tombstone = 1 WHERE id = ?').run(tombstoned)

    const ids = repo.listExisting(acct, '2026-06-01').map((r) => r.id)
    expect(ids).toContain(byTxnDate)
    expect(ids).toContain(byPostDate)
    expect(ids).not.toContain(old)
    expect(ids).not.toContain(tombstoned)
    expect(repo.listExisting(acct, null)).toHaveLength(3)
  })

  it('listPending returns only non-tombstoned pending rows for the account', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const other = insertAccount(db)
    const pending = insertTxn(db, acct, { status: 'pending' })
    insertTxn(db, acct, { status: 'posted' })
    insertTxn(db, other, { status: 'pending' })
    const gone = insertTxn(db, acct, { status: 'pending' })
    db.prepare('UPDATE transactions SET tombstone = 1 WHERE id = ?').run(gone)

    expect(repo.listPending(acct).map((r) => r.id)).toEqual([pending])
  })

  it('knownExternalIds is scoped to account + source and skips NULLs', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const other = insertAccount(db)
    insertTxn(db, acct, { source: 'teller', externalId: 'txn_1' })
    insertTxn(db, acct, { source: 'amex_csv', externalId: 'ref_9' })
    insertTxn(db, acct, { source: 'teller', externalId: null })
    insertTxn(db, other, { source: 'teller', externalId: 'txn_2' })

    expect(repo.knownExternalIds(acct, 'teller')).toEqual(new Set(['txn_1']))
    expect(repo.knownExternalIds(acct, 'amex_csv')).toEqual(new Set(['ref_9']))
  })
})

describe('SqliteRepo.applyDecisions', () => {
  it('inserts drafts with generated ids and persists all draft fields', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const d = draft({
      source: 'amex_csv',
      externalId: 'ref_1',
      txnDate: '2026-06-03',
      postDate: '2026-06-04',
      amountCents: -5000,
      importedPayee: 'Amazon',
      sourceCategory: 'Merchandise',
    })
    const counts = repo.applyDecisions(acct, emptyOutcome([{ kind: 'insert', draft: d }]))
    expect(counts).toEqual({ inserted: 1, matched: 0, skipped: 0 })

    const rows = repo.listExisting(acct, null)
    expect(rows).toHaveLength(1)
    const row = getTxnRow(db, rows[0]!.id)
    expect(row).toMatchObject({
      account_id: acct,
      source: 'amex_csv',
      external_id: 'ref_1',
      import_hash: d.importHash,
      txn_date: '2026-06-03',
      post_date: '2026-06-04',
      amount_cents: -5000,
      status: 'posted',
      imported_payee: 'Amazon',
      raw_description: 'RAW DESC',
      source_category: 'Merchandise',
      category_id: null,
      reconciled: 0,
      tombstone: 0,
    })
  })

  it('counts skip_duplicate decisions without writing', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const counts = repo.applyDecisions(
      acct,
      emptyOutcome([{ kind: 'skip_duplicate', draft: draft(), existingId: 'whatever' }]),
    )
    expect(counts).toEqual({ inserted: 0, matched: 0, skipped: 1 })
    expect(repo.listExisting(acct, null)).toHaveLength(0)
  })

  it('a unique race on import_hash is counted as skipped, never a crash', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const d = draft({ source: 'chase_csv' })
    insertTxn(db, acct, { source: 'chase_csv', importHash: d.importHash })

    const counts = repo.applyDecisions(acct, emptyOutcome([{ kind: 'insert', draft: d }]))
    expect(counts).toEqual({ inserted: 0, matched: 0, skipped: 1 })
    expect(repo.listExisting(acct, null)).toHaveLength(1)
  })

  it('a unique race on (source, external_id) is counted as skipped', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    insertTxn(db, acct, { source: 'teller', externalId: 'txn_dup' })
    const counts = repo.applyDecisions(
      acct,
      emptyOutcome([{ kind: 'insert', draft: draft({ source: 'teller', externalId: 'txn_dup' }) }]),
    )
    expect(counts).toEqual({ inserted: 0, matched: 0, skipped: 1 })
  })

  it('match applies ONLY updates + linked_source_id + reconciled — category/payee survive (invariant 5)', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const existing = insertTxn(db, acct, {
      source: 'chase_csv',
      txnDate: '2026-01-30',
      postDate: null,
      amountCents: -4200,
      importedPayee: 'Corner Store',
      categoryId: 'groceries',
      categorySource: 'user',
      notes: 'my note',
    })
    const d = draft({ source: 'teller', externalId: 'txn_55', importedPayee: 'CORNER STORE #12' })
    const counts = repo.applyDecisions(
      acct,
      emptyOutcome([
        {
          kind: 'match',
          existingId: existing,
          draft: d,
          updates: {
            postDate: '2026-02-02',
            status: 'posted',
            externalId: 'txn_55',
            linkedSourceId: 'teller:txn_55',
          },
        },
      ]),
    )
    expect(counts).toEqual({ inserted: 0, matched: 1, skipped: 0 })
    const row = getTxnRow(db, existing)
    expect(row).toMatchObject({
      txn_date: '2026-01-30', // not in updates → untouched (date precedence held upstream)
      post_date: '2026-02-02',
      external_id: 'txn_55',
      linked_source_id: 'teller:txn_55',
      reconciled: 1,
      // never touched by a match:
      category_id: 'groceries',
      category_source: 'user',
      imported_payee: 'Corner Store',
      amount_cents: -4200,
      notes: 'my note',
    })
  })

  it('wraps the whole outcome in a transaction — a bad match rolls back sibling inserts', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    expect(() =>
      repo.applyDecisions(
        acct,
        emptyOutcome([
          { kind: 'insert', draft: draft() },
          { kind: 'match', existingId: 'missing-row', draft: draft(), updates: { status: 'posted' } },
        ]),
      ),
    ).toThrow(/missing-row/)
    expect(repo.listExisting(acct, null)).toHaveLength(0)
  })
})

describe('SqliteRepo.gcPending', () => {
  it('tombstones stale pendings without a replacement', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const stale = insertTxn(db, acct, { status: 'pending' })
    repo.gcPending([{ id: stale }])
    expect(getTxnRow(db, stale)['tombstone']).toBe(1)
    expect(repo.listPending(acct)).toEqual([])
  })

  it('carries notes and user category onto the replacement row', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const stale = insertTxn(db, acct, {
      status: 'pending',
      notes: 'tip adjusted',
      categoryId: 'food_and_drink',
      categorySource: 'user',
    })
    const replacement = insertTxn(db, acct, { status: 'posted' })
    repo.gcPending([{ id: stale, replacementId: replacement }])
    const row = getTxnRow(db, replacement)
    expect(row).toMatchObject({
      notes: 'tip adjusted',
      category_id: 'food_and_drink',
      category_source: 'user',
    })
    expect(getTxnRow(db, stale)['tombstone']).toBe(1)
  })

  it('does NOT carry non-user categorization; notes still carry', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const stale = insertTxn(db, acct, {
      status: 'pending',
      notes: 'note',
      categoryId: 'entertainment',
      categorySource: 'llm',
      llmConfidence: 0.9,
    })
    const replacement = insertTxn(db, acct, { status: 'posted' })
    repo.gcPending([{ id: stale, replacementId: replacement }])
    const row = getTxnRow(db, replacement)
    expect(row).toMatchObject({ notes: 'note', category_id: null, category_source: null })
  })

  it('throws on unknown pending id or unknown replacement id', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const stale = insertTxn(db, acct, { status: 'pending', notes: 'n' })
    expect(() => repo.gcPending([{ id: 'ghost' }])).toThrow(/ghost/)
    expect(() => repo.gcPending([{ id: stale, replacementId: 'ghost' }])).toThrow(/ghost/)
    // failed batch rolled back: stale row not tombstoned
    expect(getTxnRow(db, stale)['tombstone']).toBe(0)
  })
})

describe('SqliteRepo settings + sync log', () => {
  it('settings round-trip JSON values and overwrite on set', () => {
    const { repo } = makeRepo()
    expect(repo.getSetting('syncIntervalHours')).toBeNull()
    repo.setSetting('syncIntervalHours', 6)
    expect(repo.getSetting<number>('syncIntervalHours')).toBe(6)
    repo.setSetting('syncIntervalHours', 12)
    expect(repo.getSetting<number>('syncIntervalHours')).toBe(12)
    repo.setSetting('ollama', { url: 'http://localhost:11434', model: 'qwen3:8b' })
    expect(repo.getSetting('ollama')).toEqual({ url: 'http://localhost:11434', model: 'qwen3:8b' })
    expect(() => repo.setSetting('bad', undefined)).toThrow(/undefined/)
  })

  it('insertSyncLog persists a row and returns its id', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const id = repo.insertSyncLog({
      ranAt: '2026-07-06T12:00:00Z',
      source: 'teller',
      accountId: acct,
      fetched: 40,
      inserted: 3,
      matched: 2,
      gcPending: 1,
      errors: null,
    })
    const row = db.prepare('SELECT * FROM sync_log WHERE id = ?').get(id)
    expect(row).toMatchObject({
      ran_at: '2026-07-06T12:00:00Z',
      source: 'teller',
      account_id: acct,
      fetched: 40,
      inserted: 3,
      matched: 2,
      gc_pending: 1,
      errors: null,
    })
  })
})
