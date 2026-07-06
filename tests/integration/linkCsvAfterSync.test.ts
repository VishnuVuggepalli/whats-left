import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tellerTransactionsSchema, type TellerTransaction } from '../../src/main/core/teller/types'
import type { Db } from '../../src/main/db/db'
import type { SqliteRepo } from '../../src/main/db/repository'
import { makeRepo } from '../../src/main/db/testSupport'
import { FakeDialog, FixedClock, InMemorySecretStore } from '../../src/main/platform/fakes'
import { AppService, accessTokenKey, type AppServiceDeps } from '../../src/main/services/appService'
import type { LlmPort } from '../../src/main/services/categorization'

/**
 * Finding 6 (HIGH) regression test — plan §5b: linkCsvHistory must actually
 * reconcile after moving rows. Onboarding order: Teller enrolled FIRST (sync
 * inserts teller rows), CSV imported into a csv_only account SECOND, then
 * linked. Without the reconcile pass the merged account double-counts.
 */

const CHASE_CREDIT_CSV = readFileSync('/root/whats-left/fixtures/csv/chase_credit.csv', 'utf8')
const TELLER_TXNS: TellerTransaction[] = tellerTransactionsSchema.parse(
  JSON.parse(readFileSync('/root/whats-left/fixtures/teller/transactions_chase_cc.json', 'utf8')),
)

const offlineLlm: LlmPort = {
  isAvailable: async () => false,
  categorizeMerchants: async () => {
    throw new Error('llm offline')
  },
}

function makeWorld(): { service: AppService; repo: SqliteRepo; db: Db; secrets: InMemorySecretStore } {
  const { db, repo } = makeRepo()
  const secrets = new InMemorySecretStore()
  const deps: AppServiceDeps = {
    repo,
    secrets,
    clock: new FixedClock('2026-07-06', Date.UTC(2026, 6, 6, 12)),
    dialog: new FakeDialog(),
    makeLlm: () => offlineLlm,
    makeTellerClient: () => ({
      listAccounts: async () => [],
      listTransactions: async () => TELLER_TXNS,
    }),
    startEnrollmentServer: async () => {
      throw new Error('enrollment not exercised here')
    },
    openExternal: async () => {},
    getApplicationId: async () => 'app_test',
  }
  return { service: new AppService(deps), repo, db, secrets }
}

describe('linkCsvHistory AFTER a Teller sync (integration)', () => {
  it('pairs teller rows with their moved csv twins: real matched count, no double-counting', async () => {
    const { service, repo, db, secrets } = makeWorld()

    // 1) Teller enrolled first: sync inserts the 6 fixture rows
    const teller = repo.createAccount({
      name: 'Chase Freedom',
      institution: 'chase',
      sourceKind: 'teller',
      type: 'credit',
      tellerAccountId: 'acc_chase_cc_1',
      tellerEnrollmentId: 'enr_chase_1',
    })
    await secrets.set(accessTokenKey('enr_chase_1'), 'tok_test')
    const syncReport = await service.syncNow()
    expect(syncReport.accounts[0]).toMatchObject({ fetched: 6, inserted: 6, matched: 0 })

    // 2) the overlapping CSV lands in a separate csv_only account
    const csvAcct = await service.createCsvAccount({
      name: 'Chase Freedom (CSV)',
      institution: 'chase',
      type: 'credit',
    })
    await service.importCsv({
      accountId: csvAcct.id,
      fileName: 'Chase4321_Activity.csv',
      content: CHASE_CREDIT_CSV,
      commit: true,
    })

    // user annotates one overlapping CSV row before linking
    const csvUnited = db
      .prepare(
        `SELECT id FROM transactions
         WHERE account_id = ? AND raw_description LIKE '%UNITED%' AND tombstone = 0`,
      )
      .get(csvAcct.id) as { id: string }
    db.prepare(
      `UPDATE transactions SET notes = 'work trip', category_id = 'travel', category_source = 'user'
       WHERE id = ?`,
    ).run(csvUnited.id)

    // 3) link the history — the reconcile pass must run over the merged account
    const linked = await service.linkCsvHistory(csvAcct.id, teller.id)
    expect(linked.moved).toBe(9)
    expect(linked.matched).toBe(5) // the 5 posted fixture txns found their CSV twins

    // 10 live rows: 9 CSV + 6 teller − 5 tombstoned twins
    expect((await service.listTransactions({ accountId: teller.id })).total).toBe(10)

    // the two same-day coffees are 2 rows, not 4
    const coffees = (await service.listTransactions({ accountId: teller.id, text: 'COFFEE' })).rows
    expect(coffees).toHaveLength(2)
    // date precedence: earliest (CSV transaction date) wins on the surviving teller rows
    expect(coffees.map((c) => c.txnDate)).toEqual(['2026-06-25', '2026-06-25'])

    // user note + category carried from the tombstoned csv twin onto the teller row
    const united = (await service.listTransactions({ accountId: teller.id, text: 'UNITED' })).rows
    expect(united).toHaveLength(1)
    expect(united[0]).toMatchObject({
      notes: 'work trip',
      categoryId: 'travel',
      categorySource: 'user',
    })

    // dashboard is NOT double-counted: 2 coffees once each
    const dash = await service.getDashboard('2026-06')
    const byCategory = new Map(dash.byCategory.map((c) => [c.categoryId, c.netCents]))
    expect(byCategory.get('food_and_drink')).toBe(-1350)

    // a follow-up sync stays idempotent
    const again = await service.syncNow()
    expect(again.accounts[0]).toMatchObject({ inserted: 0, gcPending: 0, error: null })
    expect((await service.listTransactions({ accountId: teller.id })).total).toBe(10)
  })

  it('linking BEFORE any sync still works and reports matched 0', async () => {
    const { service, repo } = makeWorld()
    const teller = repo.createAccount({
      name: 'Chase Freedom',
      institution: 'chase',
      sourceKind: 'teller',
      type: 'credit',
      tellerAccountId: 'acc_chase_cc_1',
      tellerEnrollmentId: 'enr_chase_1',
    })
    const csvAcct = await service.createCsvAccount({
      name: 'CSV',
      institution: 'chase',
      type: 'credit',
    })
    await service.importCsv({
      accountId: csvAcct.id,
      fileName: 'a.csv',
      content: CHASE_CREDIT_CSV,
      commit: true,
    })
    const linked = await service.linkCsvHistory(csvAcct.id, teller.id)
    expect(linked).toEqual({ moved: 9, matched: 0 })
    expect((await service.listTransactions({ accountId: teller.id })).total).toBe(9)
  })
})
