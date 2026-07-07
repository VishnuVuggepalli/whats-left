import { describe, expect, it, vi } from 'vitest'
import type { TxnDraft } from '../../shared/types'
import { normalizePayee } from '../core/categorize/normalizer'
import type { ExistingTxn, ReconcileOutcome } from '../core/ports'
import { reconcile } from '../core/reconcile/reconciler'
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

  it('createAccount defaults feedEnv to null and persists a provided feedEnv', () => {
    const { repo } = makeRepo()
    const csv = repo.createAccount({
      name: 'CSV Card',
      institution: 'chase',
      sourceKind: 'csv_only',
      type: 'credit',
    })
    expect(csv.feedEnv).toBeNull()
    const feed = repo.createAccount({
      name: 'Prod Checking',
      institution: 'chase',
      sourceKind: 'teller',
      type: 'depository',
      feedEnv: 'production',
    })
    expect(feed.feedEnv).toBe('production')
    expect(repo.getAccount(feed.id)?.feedEnv).toBe('production')
  })

  it('createAccount rejects an invalid feedEnv', () => {
    const { repo } = makeRepo()
    expect(() =>
      repo.createAccount({
        name: 'X',
        institution: 'chase',
        sourceKind: 'teller',
        type: 'depository',
        // @ts-expect-error bad feedEnv must be rejected at runtime too
        feedEnv: 'development',
      }),
    ).toThrow(/feedEnv/i)
  })

  it('setAccountFeedEnv persists, validates, and throws on unknown account', () => {
    const { repo } = makeRepo()
    const acct = repo.createAccount({
      name: 'A',
      institution: 'amex',
      sourceKind: 'teller',
      type: 'credit',
    })
    expect(acct.feedEnv).toBeNull()
    repo.setAccountFeedEnv(acct.id, 'sandbox')
    expect(repo.getAccount(acct.id)?.feedEnv).toBe('sandbox')
    expect(() => repo.setAccountFeedEnv('nope', 'sandbox')).toThrow(/nope/)
    expect(() => repo.setAccountFeedEnv(acct.id, 'development' as never)).toThrow(/feedEnv/i)
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
  const reconcileFn = (incoming: TxnDraft[], existing: ExistingTxn[]): ReconcileOutcome =>
    reconcile(incoming, existing, { normalize: normalizePayee })

  it('moves transactions to the teller account, tombstones the csv account, returns counts', () => {
    const { db, repo } = makeRepo()
    const csvId = insertAccount(db, { sourceKind: 'csv_only' })
    const tellerId = insertAccount(db, { sourceKind: 'teller' })
    const t1 = insertTxn(db, csvId, { txnDate: '2026-06-01', amountCents: -100 })
    const t2 = insertTxn(db, csvId, { txnDate: '2026-05-01', amountCents: -200 })

    const result = repo.linkCsvHistory(csvId, tellerId, reconcileFn)
    expect(result).toEqual({ moved: 2, matched: 0 }) // no teller rows yet → nothing pairs
    expect(getTxnRow(db, t1)['account_id']).toBe(tellerId)
    expect(getTxnRow(db, t2)['account_id']).toBe(tellerId)
    expect(repo.getAccount(csvId)).toBeNull()
    expect(repo.getAccount(tellerId)).not.toBeNull()
  })

  it('reconciles moved rows against teller rows: updates + carry + tombstoned twin', () => {
    const { db, repo } = makeRepo()
    const csvId = insertAccount(db, { sourceKind: 'csv_only' })
    const tellerId = insertAccount(db, { sourceKind: 'teller' })
    const twin = insertTxn(db, csvId, {
      source: 'chase_csv',
      txnDate: '2026-06-25',
      postDate: '2026-06-27',
      amountCents: -675,
      importedPayee: 'Coffee House',
      notes: 'with sam',
      categoryId: 'food_and_drink',
      categorySource: 'user',
    })
    const unmatched = insertTxn(db, csvId, { txnDate: '2026-04-01', amountCents: -5000 })
    const tellerRow = insertTxn(db, tellerId, {
      source: 'teller',
      externalId: 'txn_coffee',
      txnDate: '2026-06-27',
      postDate: '2026-06-27',
      amountCents: -675,
      importedPayee: 'Coffee House',
    })

    const result = repo.linkCsvHistory(csvId, tellerId, reconcileFn)
    expect(result).toEqual({ moved: 2, matched: 1 })
    // the teller row took earliest txnDate + linkedSourceId + the user's edits
    expect(getTxnRow(db, tellerRow)).toMatchObject({
      txn_date: '2026-06-25',
      reconciled: 1,
      notes: 'with sam',
      category_id: 'food_and_drink',
      category_source: 'user',
    })
    // the redundant csv twin is tombstoned; the unmatched csv row lives on
    expect(getTxnRow(db, twin)['tombstone']).toBe(1)
    expect(getTxnRow(db, unmatched)).toMatchObject({ account_id: tellerId, tombstone: 0 })
  })

  it('rejects a source account that is not csv_only', () => {
    const { db, repo } = makeRepo()
    const a = insertAccount(db, { sourceKind: 'teller' })
    const b = insertAccount(db, { sourceKind: 'teller' })
    expect(() => repo.linkCsvHistory(a, b, reconcileFn)).toThrow(/csv_only/)
  })

  it('throws on unknown accounts', () => {
    const { db, repo } = makeRepo()
    const csvId = insertAccount(db, { sourceKind: 'csv_only' })
    expect(() => repo.linkCsvHistory('ghost', csvId, reconcileFn)).toThrow(/ghost/)
    expect(() => repo.linkCsvHistory(csvId, 'ghost', reconcileFn)).toThrow(/ghost/)
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

  it('knownExternalIds is account-scoped, source-agnostic, and skips NULLs', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const other = insertAccount(db)
    insertTxn(db, acct, { source: 'teller', externalId: 'txn_1' })
    // a csv row that ADOPTED a teller id via a fuzzy merge must count as known
    insertTxn(db, acct, { source: 'chase_csv', externalId: 'txn_adopted' })
    insertTxn(db, acct, { source: 'amex_csv', externalId: 'ref_9' })
    insertTxn(db, acct, { source: 'teller', externalId: null })
    insertTxn(db, other, { source: 'teller', externalId: 'txn_2' })

    expect(repo.knownExternalIds(acct)).toEqual(new Set(['txn_1', 'txn_adopted', 'ref_9']))
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

  it('carries notes and user category onto the replacement, resolved by its TELLER id', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const stale = insertTxn(db, acct, {
      status: 'pending',
      notes: 'tip adjusted',
      categoryId: 'food_and_drink',
      categorySource: 'user',
    })
    const replacement = insertTxn(db, acct, {
      status: 'posted',
      source: 'teller',
      externalId: 'txn_replacement_1',
    })
    repo.gcPending([{ id: stale, replacementExternalId: 'txn_replacement_1' }])
    const row = getTxnRow(db, replacement)
    expect(row).toMatchObject({
      notes: 'tip adjusted',
      category_id: 'food_and_drink',
      category_source: 'user',
    })
    expect(getTxnRow(db, stale)['tombstone']).toBe(1)
  })

  it('resolves the replacement within the pending row’s own account', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const other = insertAccount(db)
    const stale = insertTxn(db, acct, { status: 'pending', notes: 'mine' })
    // same-shaped teller row on ANOTHER account must never receive the carry
    const foreign = insertTxn(db, other, {
      status: 'posted',
      source: 'teller',
      externalId: 'txn_foreign',
    })
    expect(() => repo.gcPending([{ id: stale, replacementExternalId: 'txn_foreign' }])).toThrow(
      /txn_foreign/,
    )
    expect(getTxnRow(db, foreign)['notes']).toBeNull()
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
    insertTxn(db, acct, { status: 'posted', source: 'teller', externalId: 'txn_repl_2' })
    repo.gcPending([{ id: stale, replacementExternalId: 'txn_repl_2' }])
    const rows = db
      .prepare(`SELECT * FROM transactions WHERE external_id = 'txn_repl_2'`)
      .all() as Array<Record<string, unknown>>
    expect(rows[0]).toMatchObject({ notes: 'note', category_id: null, category_source: null })
  })

  it('throws on unknown pending id or unresolvable replacement (when a carry is due)', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const stale = insertTxn(db, acct, { status: 'pending', notes: 'n' })
    expect(() => repo.gcPending([{ id: 'ghost' }])).toThrow(/ghost/)
    expect(() =>
      repo.gcPending([{ id: stale, replacementExternalId: 'txn_ghost' }]),
    ).toThrow(/txn_ghost/)
    // failed batch rolled back: stale row not tombstoned
    expect(getTxnRow(db, stale)['tombstone']).toBe(0)
  })

  it('a missing replacement is tolerated when the pending carries no edits', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const stale = insertTxn(db, acct, { status: 'pending' })
    repo.gcPending([{ id: stale, replacementExternalId: 'txn_ghost' }])
    expect(getTxnRow(db, stale)['tombstone']).toBe(1)
  })

  it('carries edits onto a PLAID replacement (pending_transaction_id flow)', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const stale = insertTxn(db, acct, {
      status: 'pending',
      source: 'plaid',
      externalId: 'plaid-txn-pending-1',
      notes: 'tip pending',
      categoryId: 'food_and_drink',
      categorySource: 'user',
    })
    const replacement = insertTxn(db, acct, {
      status: 'posted',
      source: 'plaid',
      externalId: 'plaid-txn-posted-1',
    })
    repo.gcPending([{ id: stale, replacementExternalId: 'plaid-txn-posted-1' }])
    expect(getTxnRow(db, replacement)).toMatchObject({
      notes: 'tip pending',
      category_id: 'food_and_drink',
      category_source: 'user',
    })
    expect(getTxnRow(db, stale)['tombstone']).toBe(1)
  })
})

describe('SqliteRepo.updateTxnStateByExternalId (plaid MODIFIED entries)', () => {
  it('updates amount/dates/status and NEVER touches categorization or notes', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const id = insertTxn(db, acct, {
      source: 'plaid',
      externalId: 'plaid-txn-mod-1',
      amountCents: -8710,
      txnDate: '2026-06-27',
      postDate: null,
      status: 'pending',
      categoryId: 'groceries',
      categorySource: 'user',
      notes: 'weekly shop',
    })
    const changed = repo.updateTxnStateByExternalId(acct, 'plaid-txn-mod-1', {
      amountCents: -9241,
      txnDate: '2026-06-27',
      postDate: '2026-06-28',
      status: 'posted',
    })
    expect(changed).toBe(1)
    expect(getTxnRow(db, id)).toMatchObject({
      amount_cents: -9241,
      txn_date: '2026-06-27',
      post_date: '2026-06-28',
      status: 'posted',
      // invariant 5: user categorization + notes survive the state update
      category_id: 'groceries',
      category_source: 'user',
      notes: 'weekly shop',
    })
  })

  it('returns 0 for an unknown external id or a tombstoned row (never throws)', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const state = { amountCents: -1, txnDate: '2026-01-01', postDate: null, status: 'posted' as const }
    expect(repo.updateTxnStateByExternalId(acct, 'plaid-ghost', state)).toBe(0)
    const dead = insertTxn(db, acct, { source: 'plaid', externalId: 'plaid-dead' })
    db.prepare('UPDATE transactions SET tombstone = 1 WHERE id = ?').run(dead)
    expect(repo.updateTxnStateByExternalId(acct, 'plaid-dead', state)).toBe(0)
  })

  it('is scoped to the given account', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const other = insertAccount(db)
    const foreign = insertTxn(db, other, { source: 'plaid', externalId: 'plaid-elsewhere', amountCents: -500 })
    const changed = repo.updateTxnStateByExternalId(acct, 'plaid-elsewhere', {
      amountCents: -999,
      txnDate: '2026-01-01',
      postDate: null,
      status: 'posted',
    })
    expect(changed).toBe(0)
    expect(getTxnRow(db, foreign)['amount_cents']).toBe(-500)
  })
})

describe('SqliteRepo.tombstoneByExternalId (plaid removed[] entries)', () => {
  it('tombstones the live row — never deletes it', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const id = insertTxn(db, acct, { source: 'plaid', externalId: 'plaid-txn-removed-1' })
    expect(repo.tombstoneByExternalId(acct, 'plaid-txn-removed-1')).toBe(1)
    const row = getTxnRow(db, id) // the row still exists
    expect(row['tombstone']).toBe(1)
  })

  it('is idempotent: a second call (or an unknown id) is a 0-change no-op', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    insertTxn(db, acct, { source: 'plaid', externalId: 'plaid-txn-removed-2' })
    expect(repo.tombstoneByExternalId(acct, 'plaid-txn-removed-2')).toBe(1)
    expect(repo.tombstoneByExternalId(acct, 'plaid-txn-removed-2')).toBe(0)
    expect(repo.tombstoneByExternalId(acct, 'plaid-never-seen')).toBe(0)
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

  it('a corrupt settings row degrades to null (logged) and self-heals on the next write', () => {
    const { db, repo } = makeRepo()
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('app_settings', '{not json')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(repo.getSetting('app_settings')).toBeNull() // never a SyntaxError
      expect(errSpy).toHaveBeenCalledOnce()
    } finally {
      errSpy.mockRestore()
    }
    // next write overwrites the corrupt row — full recovery without external tooling
    repo.setSetting('app_settings', { syncIntervalHours: 6 })
    expect(repo.getSetting('app_settings')).toEqual({ syncIntervalHours: 6 })
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
