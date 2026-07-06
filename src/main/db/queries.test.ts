import { describe, expect, it } from 'vitest'
import { getTxnRow, insertAccount, insertTxn, makeRepo } from './testSupport'

describe('SqliteRepo.listTransactions', () => {
  it('returns non-tombstoned rows newest first with a total count', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const a = insertTxn(db, acct, { txnDate: '2026-06-01' })
    const b = insertTxn(db, acct, { txnDate: '2026-06-15' })
    const gone = insertTxn(db, acct, { txnDate: '2026-06-20' })
    db.prepare('UPDATE transactions SET tombstone = 1 WHERE id = ?').run(gone)

    const { rows, total } = repo.listTransactions({})
    expect(total).toBe(2)
    expect(rows.map((r) => r.id)).toEqual([b, a])
  })

  it('maps TransactionDto fields including joined category name', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    insertTxn(db, acct, {
      txnDate: '2026-06-02',
      amountCents: -775,
      importedPayee: 'Blue Bottle',
      rawDescription: 'BLUE BOTTLE COFFEE #42',
      categoryId: 'food_and_drink',
      categorySource: 'cache',
      sourceCategory: 'Food & Drink',
      notes: 'oat latte',
    })
    const { rows } = repo.listTransactions({})
    expect(rows[0]).toMatchObject({
      accountId: acct,
      txnDate: '2026-06-02',
      amountCents: -775,
      payee: 'Blue Bottle',
      rawDescription: 'BLUE BOTTLE COFFEE #42',
      categoryId: 'food_and_drink',
      categoryName: 'Dining & Drinks',
      categorySource: 'cache',
      sourceCategory: 'Food & Drink',
      notes: 'oat latte',
    })
  })

  it('filters by accountId, categoryId and status', () => {
    const { db, repo } = makeRepo()
    const a1 = insertAccount(db)
    const a2 = insertAccount(db)
    const t1 = insertTxn(db, a1, { categoryId: 'travel' })
    const t2 = insertTxn(db, a1, { categoryId: 'medical', status: 'pending' })
    insertTxn(db, a2, { categoryId: 'travel' })

    expect(repo.listTransactions({ accountId: a1 }).total).toBe(2)
    const byCat = repo.listTransactions({ accountId: a1, categoryId: 'travel' })
    expect(byCat.rows.map((r) => r.id)).toEqual([t1])
    const byStatus = repo.listTransactions({ accountId: a1, status: 'pending' })
    expect(byStatus.rows.map((r) => r.id)).toEqual([t2])
  })

  it('filters by inclusive txn_date range', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    insertTxn(db, acct, { txnDate: '2026-05-31' })
    const mid = insertTxn(db, acct, { txnDate: '2026-06-01' })
    const end = insertTxn(db, acct, { txnDate: '2026-06-30' })
    insertTxn(db, acct, { txnDate: '2026-07-01' })

    const { rows } = repo.listTransactions({ from: '2026-06-01', to: '2026-06-30' })
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([mid, end]))
  })

  it('text filter matches payee OR raw description, case-insensitively', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const byPayee = insertTxn(db, acct, { importedPayee: 'Blue Bottle', rawDescription: 'X' })
    const byRaw = insertTxn(db, acct, { importedPayee: 'Y', rawDescription: 'TST* BLUEBOTTLE OAK' })
    insertTxn(db, acct, { importedPayee: 'Chipotle', rawDescription: 'CHIPOTLE 1234' })

    const { rows } = repo.listTransactions({ text: 'blue' })
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([byPayee, byRaw]))
  })

  it('text filter treats LIKE wildcards as literals', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const literal = insertTxn(db, acct, { importedPayee: '100% Juice', rawDescription: 'X' })
    insertTxn(db, acct, { importedPayee: '1000 Juice', rawDescription: 'X' })
    const { rows } = repo.listTransactions({ text: '100% j' })
    expect(rows.map((r) => r.id)).toEqual([literal])

    const under = insertTxn(db, acct, { importedPayee: 'A_B Market', rawDescription: 'X' })
    insertTxn(db, acct, { importedPayee: 'AXB Market', rawDescription: 'X' })
    expect(repo.listTransactions({ text: 'A_B' }).rows.map((r) => r.id)).toEqual([under])
  })

  it('paginates with limit/offset while total reflects the full match count', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    for (let i = 1; i <= 5; i++) {
      insertTxn(db, acct, { txnDate: `2026-06-0${i}`, importedPayee: `P${i}` })
    }
    const page1 = repo.listTransactions({ limit: 2, offset: 0 })
    const page2 = repo.listTransactions({ limit: 2, offset: 2 })
    expect(page1.total).toBe(5)
    expect(page1.rows.map((r) => r.payee)).toEqual(['P5', 'P4'])
    expect(page2.rows.map((r) => r.payee)).toEqual(['P3', 'P2'])
  })

  it('rejects malformed dates and non-positive limits', () => {
    const { repo } = makeRepo()
    expect(() => repo.listTransactions({ from: '06/01/2026' })).toThrow(/date/i)
    expect(() => repo.listTransactions({ to: 'yesterday' })).toThrow(/date/i)
    expect(() => repo.listTransactions({ limit: 0 })).toThrow(/limit/i)
    expect(() => repo.listTransactions({ offset: -1 })).toThrow(/offset/i)
  })
})

describe('SqliteRepo categorization support', () => {
  it('setTxnCategory writes category, source, confidence', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const id = insertTxn(db, acct)
    repo.setTxnCategory(id, 'entertainment', 'llm', 0.55)
    expect(getTxnRow(db, id)).toMatchObject({
      category_id: 'entertainment',
      category_source: 'llm',
      llm_confidence: 0.55,
    })
    repo.setTxnCategory(id, 'travel', 'user')
    expect(getTxnRow(db, id)).toMatchObject({
      category_id: 'travel',
      category_source: 'user',
      llm_confidence: null,
    })
  })

  it('setTxnCategory validates txn, category, and confidence range', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const id = insertTxn(db, acct)
    expect(() => repo.setTxnCategory('ghost', 'travel', 'user')).toThrow(/ghost/)
    expect(() => repo.setTxnCategory(id, 'not_a_category', 'user')).toThrow(/not_a_category/)
    expect(() => repo.setTxnCategory(id, 'travel', 'llm', 1.5)).toThrow(/confidence/i)
  })

  it('listUncategorized returns only live rows with NULL category', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const uncat = insertTxn(db, acct, { importedPayee: 'Mystery Shop' })
    insertTxn(db, acct, { categoryId: 'travel', categorySource: 'rule' })
    const gone = insertTxn(db, acct)
    db.prepare('UPDATE transactions SET tombstone = 1 WHERE id = ?').run(gone)

    const rows = repo.listUncategorized()
    expect(rows.map((r) => r.id)).toEqual([uncat])
    expect(rows[0]).toMatchObject({ importedPayee: 'Mystery Shop', accountId: acct })
  })

  it('listReviewQueue surfaces NULL-category rows as uncategorized at confidence 0', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const uncat = insertTxn(db, acct, {
      txnDate: '2026-06-11',
      amountCents: -1200,
      importedPayee: 'Mystery Shop',
      rawDescription: 'MYSTERY*SHOP',
    })
    insertTxn(db, acct, { categoryId: 'travel', categorySource: 'user' })
    const tomb = insertTxn(db, acct)
    db.prepare('UPDATE transactions SET tombstone = 1 WHERE id = ?').run(tomb)

    const queue = repo.listReviewQueue()
    expect(queue).toEqual([
      {
        txnId: uncat,
        payee: 'Mystery Shop',
        rawDescription: 'MYSTERY*SHOP',
        amountCents: -1200,
        txnDate: '2026-06-11',
        suggestedCategoryId: 'uncategorized',
        confidence: 0,
      },
    ])
  })

  it('listReviewQueue returns low-confidence LLM rows only', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const low = insertTxn(db, acct, {
      txnDate: '2026-06-10',
      amountCents: -2350,
      importedPayee: 'Vague Vendor',
      rawDescription: 'VAGUE*VENDOR',
      categoryId: 'general_services',
      categorySource: 'llm',
      llmConfidence: 0.4,
    })
    insertTxn(db, acct, { categoryId: 'travel', categorySource: 'llm', llmConfidence: 0.9 })
    insertTxn(db, acct, { categoryId: 'travel', categorySource: 'user' })
    const tomb = insertTxn(db, acct, {
      categoryId: 'travel',
      categorySource: 'llm',
      llmConfidence: 0.2,
    })
    db.prepare('UPDATE transactions SET tombstone = 1 WHERE id = ?').run(tomb)

    const queue = repo.listReviewQueue()
    expect(queue).toEqual([
      {
        txnId: low,
        payee: 'Vague Vendor',
        rawDescription: 'VAGUE*VENDOR',
        amountCents: -2350,
        txnDate: '2026-06-10',
        suggestedCategoryId: 'general_services',
        confidence: 0.4,
      },
    ])
  })
})

describe('SqliteRepo.recategorize', () => {
  it("scope 'txn' updates only the row and writes no cache entry", () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const id = insertTxn(db, acct, {
      importedPayee: 'Blue Bottle',
      categoryId: 'general_merchandise',
      categorySource: 'llm',
      llmConfidence: 0.5,
    })
    const twin = insertTxn(db, acct, {
      importedPayee: 'Blue Bottle',
      categoryId: 'general_merchandise',
      categorySource: 'llm',
    })
    const res = repo.recategorize(
      { txnId: id, categoryId: 'food_and_drink', scope: 'txn' },
      'blue bottle',
    )
    expect(res).toEqual({ updated: 1 })
    expect(getTxnRow(db, id)).toMatchObject({
      category_id: 'food_and_drink',
      category_source: 'user',
      llm_confidence: null,
    })
    expect(getTxnRow(db, twin)['category_id']).toBe('general_merchandise')
    expect(repo.get('blue bottle')).toBeNull()
  })

  it("scope 'merchant' updates the row and writes a locked user cache entry", () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const id = insertTxn(db, acct, { importedPayee: 'Blue Bottle' })
    const res = repo.recategorize(
      { txnId: id, categoryId: 'food_and_drink', scope: 'merchant' },
      'blue bottle',
    )
    expect(res).toEqual({ updated: 1 })
    expect(repo.get('blue bottle')).toEqual({ categoryId: 'food_and_drink', locked: true })
    const cacheRow = db
      .prepare('SELECT * FROM merchant_category_cache WHERE normalized_merchant = ?')
      .get('blue bottle')
    expect(cacheRow).toMatchObject({ source: 'user', locked: 1 })
  })

  it('applyToExisting bulk-updates the passed ids, never touching user-categorized rows', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const target = insertTxn(db, acct, { importedPayee: 'Blue Bottle', categorySource: 'llm', categoryId: 'general_merchandise' })
    const llmTwin = insertTxn(db, acct, { importedPayee: 'SQ *BLUE BOTTLE', categorySource: 'llm', categoryId: 'general_merchandise', llmConfidence: 0.6 })
    const uncatTwin = insertTxn(db, acct, { importedPayee: 'BLUE BOTTLE OAKLAND CA' })
    const userTwin = insertTxn(db, acct, { importedPayee: 'Blue Bottle', categorySource: 'user', categoryId: 'entertainment' })
    const otherPayee = insertTxn(db, acct, { importedPayee: 'Chipotle', categorySource: 'llm', categoryId: 'general_merchandise' })

    // caller (AppService) resolved the same-merchant ids through normalizePayee;
    // userTwin is passed in on purpose — the SQL guard must protect it anyway
    const res = repo.recategorize(
      { txnId: target, categoryId: 'food_and_drink', scope: 'merchant', applyToExisting: true },
      'Blue Bottle',
      [llmTwin, uncatTwin, userTwin],
    )
    // target + llmTwin + uncatTwin
    expect(res).toEqual({ updated: 3 })
    expect(getTxnRow(db, target)).toMatchObject({ category_id: 'food_and_drink', category_source: 'user' })
    expect(getTxnRow(db, llmTwin)).toMatchObject({
      category_id: 'food_and_drink',
      category_source: 'cache',
      llm_confidence: null,
    })
    expect(getTxnRow(db, uncatTwin)).toMatchObject({ category_id: 'food_and_drink', category_source: 'cache' })
    // user rows are immune (invariant 5), even when their id is passed in
    expect(getTxnRow(db, userTwin)).toMatchObject({ category_id: 'entertainment', category_source: 'user' })
    expect(getTxnRow(db, otherPayee)['category_id']).toBe('general_merchandise')
  })

  it('listMerchantCandidates returns live non-user rows with their raw payees', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const target = insertTxn(db, acct, { importedPayee: 'Blue Bottle' })
    const candidate = insertTxn(db, acct, { importedPayee: 'SQ *BLUE BOTTLE', categorySource: 'llm', categoryId: 'general_merchandise' })
    insertTxn(db, acct, { importedPayee: 'Blue Bottle', categorySource: 'user', categoryId: 'entertainment' })
    const tomb = insertTxn(db, acct, { importedPayee: 'Blue Bottle' })
    db.prepare('UPDATE transactions SET tombstone = 1 WHERE id = ?').run(tomb)

    const candidates = repo.listMerchantCandidates(target)
    expect(candidates).toEqual([{ id: candidate, importedPayee: 'SQ *BLUE BOTTLE' }])
  })

  it('validates txn id, category id, and merchant name for merchant scope', () => {
    const { db, repo } = makeRepo()
    const acct = insertAccount(db)
    const id = insertTxn(db, acct)
    expect(() =>
      repo.recategorize({ txnId: 'ghost', categoryId: 'travel', scope: 'txn' }, 'm'),
    ).toThrow(/ghost/)
    expect(() =>
      repo.recategorize({ txnId: id, categoryId: 'nope', scope: 'txn' }, 'm'),
    ).toThrow(/nope/)
    expect(() =>
      repo.recategorize({ txnId: id, categoryId: 'travel', scope: 'merchant' }, '  '),
    ).toThrow(/merchant/i)
  })
})

describe('SqliteRepo merchant cache (MerchantCachePort)', () => {
  it('get returns null for a miss and the entry after set', () => {
    const { repo } = makeRepo()
    expect(repo.get('starbucks')).toBeNull()
    repo.set({
      normalizedMerchant: 'starbucks',
      categoryId: 'food_and_drink',
      source: 'llm',
      confidence: 0.8,
      locked: false,
    })
    expect(repo.get('starbucks')).toEqual({ categoryId: 'food_and_drink', locked: false })
  })

  it('set does not overwrite a locked row unless source is user', () => {
    const { db, repo } = makeRepo()
    repo.set({
      normalizedMerchant: 'starbucks',
      categoryId: 'food_and_drink',
      source: 'user',
      confidence: null,
      locked: true,
    })
    repo.set({
      normalizedMerchant: 'starbucks',
      categoryId: 'entertainment',
      source: 'llm',
      confidence: 0.99,
      locked: false,
    })
    expect(repo.get('starbucks')).toEqual({ categoryId: 'food_and_drink', locked: true })
    const row = db
      .prepare('SELECT * FROM merchant_category_cache WHERE normalized_merchant = ?')
      .get('starbucks')
    expect(row).toMatchObject({ source: 'user', locked: 1 })

    // incoming user write CAN update a locked row
    repo.set({
      normalizedMerchant: 'starbucks',
      categoryId: 'entertainment',
      source: 'user',
      confidence: null,
      locked: true,
    })
    expect(repo.get('starbucks')).toEqual({ categoryId: 'entertainment', locked: true })
  })

  it('set overwrites unlocked rows from any source', () => {
    const { repo } = makeRepo()
    repo.set({
      normalizedMerchant: 'acme',
      categoryId: 'general_merchandise',
      source: 'chase',
      confidence: null,
      locked: false,
    })
    repo.set({
      normalizedMerchant: 'acme',
      categoryId: 'home_improvement',
      source: 'llm',
      confidence: 0.7,
      locked: false,
    })
    expect(repo.get('acme')).toEqual({ categoryId: 'home_improvement', locked: false })
  })
})
