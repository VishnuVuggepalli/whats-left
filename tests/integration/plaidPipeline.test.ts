import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import type { PlaidSyncResponse, PlaidTransaction } from '../../src/main/core/plaid/types'
import type { Db } from '../../src/main/db/db'
import type { SqliteRepo } from '../../src/main/db/repository'
import { makeRepo } from '../../src/main/db/testSupport'
import { FakeDialog, FixedClock, InMemorySecretStore } from '../../src/main/platform/fakes'
import {
  AppService,
  plaidAccessTokenKey,
  plaidCursorKey,
  type AppServiceDeps,
} from '../../src/main/services/appService'
import type { LlmPort } from '../../src/main/services/categorization'

/**
 * The Plaid twin of pipeline.test.ts: CSV backfill → link history onto the
 * Plaid-fed account → plaid sync of the OVERLAPPING window → no double count.
 * The plaid transactions overlap 3 rows of the chase_credit.csv fixture
 * (2 identical same-day coffees + groceries) and add 1 new pending row.
 */

const CHASE_CREDIT_CSV = readFileSync('/root/whats-left/fixtures/csv/chase_credit.csv', 'utf8')

function plaidTxn(over: Partial<PlaidTransaction> & { transaction_id: string }): PlaidTransaction {
  return {
    account_id: 'plaid-acc-cc-1',
    amount: 10,
    iso_currency_code: 'USD',
    date: '2026-06-27',
    authorized_date: null,
    name: 'TXN',
    merchant_name: null,
    pending: false,
    pending_transaction_id: null,
    personal_finance_category: null,
    ...over,
  }
}

// overlaps chase_credit.csv: coffees -6.75 (txn 06-25, post 06-27), groceries
// -92.41 (txn 06-24, post 06-25); plus one new pending. Plaid sign: + = out.
const OVERLAP_TXNS: PlaidTransaction[] = [
  plaidTxn({
    transaction_id: 'plaid-cc-coffee-a',
    amount: 6.75,
    date: '2026-06-27',
    authorized_date: '2026-06-25',
    name: 'TST* COFFEE HOUSE 0042 SEATTLE WA',
    merchant_name: 'Coffee House',
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE', confidence_level: 'VERY_HIGH' },
  }),
  plaidTxn({
    transaction_id: 'plaid-cc-coffee-b',
    amount: 6.75,
    date: '2026-06-27',
    authorized_date: '2026-06-25',
    name: 'TST* COFFEE HOUSE 0042 SEATTLE WA',
    merchant_name: 'Coffee House',
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE', confidence_level: 'VERY_HIGH' },
  }),
  plaidTxn({
    transaction_id: 'plaid-cc-groceries',
    amount: 92.41,
    date: '2026-06-25',
    authorized_date: '2026-06-24',
    name: 'WHOLEFDS SEA 10221 SEATTLE WA',
    merchant_name: 'Whole Foods Market',
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES', confidence_level: 'VERY_HIGH' },
  }),
  plaidTxn({
    transaction_id: 'plaid-cc-pending-thai',
    amount: 42,
    date: '2026-07-05',
    authorized_date: '2026-07-04',
    name: 'TST* THAI KITCHEN SEATTLE WA',
    merchant_name: 'Thai Kitchen',
    pending: true,
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT', confidence_level: 'HIGH' },
  }),
]

const BATCH_CURSOR = 'plaid-cursor-batch-1'

const offlineLlm: LlmPort = {
  isAvailable: async () => false,
  categorizeMerchants: async () => {
    throw new Error('llm offline')
  },
}

interface World {
  service: AppService
  repo: SqliteRepo
  db: Db
  secrets: InMemorySecretStore
}

function makeWorld(): World {
  const { db, repo } = makeRepo()
  const secrets = new InMemorySecretStore()
  const deps: AppServiceDeps = {
    repo,
    secrets,
    clock: new FixedClock('2026-07-06', Date.UTC(2026, 6, 6, 12)),
    dialog: new FakeDialog(),
    makeLlm: () => offlineLlm,
    makeTellerClient: () => {
      throw new Error('teller not exercised here')
    },
    // FAKE plaid client: one batch, then an empty tail for the stored cursor
    makePlaidClient: () => ({
      createLinkToken: async () => {
        throw new Error('enrollment not exercised here')
      },
      exchangePublicToken: async () => {
        throw new Error('enrollment not exercised here')
      },
      getAccounts: async () => {
        throw new Error('enrollment not exercised here')
      },
      transactionsSync: async (_token: string, cursor?: string): Promise<PlaidSyncResponse> => {
        if (cursor === BATCH_CURSOR) {
          return { added: [], modified: [], removed: [], next_cursor: BATCH_CURSOR, has_more: false }
        }
        return {
          added: OVERLAP_TXNS,
          modified: [],
          removed: [],
          next_cursor: BATCH_CURSOR,
          has_more: false,
        }
      },
    }),
    startEnrollmentServer: async () => {
      throw new Error('enrollment not exercised here')
    },
    startPlaidLinkServer: async () => {
      throw new Error('plaid link not exercised here')
    },
    openExternal: async () => {},
    getApplicationId: async () => 'app_test',
  }
  return { service: new AppService(deps), repo, db, secrets }
}

describe('plaid pipeline: CSV backfill → link → plaid sync overlap → no double count', () => {
  let world: World
  let feedAccountId: string

  beforeEach(async () => {
    world = makeWorld()
    const { service, repo, secrets } = world
    // provider defaults to plaid; only credentials are needed
    await service.updateSettings({ plaidClientId: 'client-1', plaidSecret: 'secret-1' })

    // 1) CSV backfill into a csv-only account
    const csvAccount = await service.createCsvAccount({
      name: 'Chase Freedom (CSV)',
      institution: 'chase',
      type: 'credit',
      mask: '4321',
    })
    const report = await service.importCsv({
      accountId: csvAccount.id,
      fileName: 'Chase4321_Activity.csv',
      content: CHASE_CREDIT_CSV,
      commit: true,
    })
    expect(report).toMatchObject({ parsed: 9, newCount: 9, committed: true })

    // 2) the Plaid-fed account appears (as the enrollment flow would create it)
    feedAccountId = repo.createAccount({
      name: 'Chase Freedom',
      institution: 'chase',
      sourceKind: 'teller', // = bank feed; plaid ids ride the teller_* columns
      type: 'credit',
      mask: '4321',
      tellerAccountId: 'plaid-acc-cc-1',
      tellerEnrollmentId: 'plaid-item-cc-1',
    }).id
    await secrets.set(plaidAccessTokenKey('sandbox', 'plaid-item-cc-1'), 'access-1')

    // 3) pull the CSV history onto it
    const linked = await service.linkCsvHistory(csvAccount.id, feedAccountId)
    expect(linked.moved).toBe(9)
  })

  it('syncNow reconciles the overlap against the CSV history without duplicating', async () => {
    const { service } = world
    const report = await service.syncNow()

    expect(report.accounts).toEqual([
      {
        accountId: feedAccountId,
        fetched: 4,
        inserted: 1, // only the new pending row
        matched: 3, // both coffees + groceries found their CSV twins
        gcPending: 0,
        uncategorized: 0, // pending Thai resolves via its PFC label — no LLM needed
        warning: null,
        error: null,
      },
    ])

    // two identical same-day coffees matched 1:1 — 2 rows, not 4, distinct plaid ids
    const coffees = (await service.listTransactions({ accountId: feedAccountId, text: 'COFFEE' })).rows
    expect(coffees).toHaveLength(2)
    expect(new Set(coffees.map((c) => c.externalId))).toEqual(
      new Set(['plaid-cc-coffee-a', 'plaid-cc-coffee-b']),
    )
    // date precedence held: CSV/authorized transaction date, not the post date
    for (const coffee of coffees) expect(coffee.txnDate).toBe('2026-06-25')

    // total rows: 9 CSV + 1 new pending
    expect((await service.listTransactions({ accountId: feedAccountId })).total).toBe(10)

    // the pending is present with INVERTED sign and a PFC-derived category
    const pending = (
      await service.listTransactions({ accountId: feedAccountId, status: 'pending' })
    ).rows
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      externalId: 'plaid-cc-pending-thai',
      amountCents: -4200,
      txnDate: '2026-07-04',
      categoryId: 'food_and_drink',
    })

    // cursor persisted after the successful batch; sync_log carries source plaid
    expect(world.repo.getSetting<string>(plaidCursorKey('plaid-item-cc-1'))).toBe(BATCH_CURSOR)
    const log = world.db.prepare('SELECT * FROM sync_log').all() as Array<Record<string, unknown>>
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ source: 'plaid', fetched: 4, inserted: 1, matched: 3, errors: null })
  })

  it('a second syncNow resumes at the cursor and is idempotent', async () => {
    const { service } = world
    await service.syncNow()
    const before = (await service.listTransactions({ accountId: feedAccountId })).total
    const second = await service.syncNow()
    expect(second.accounts[0]).toMatchObject({ fetched: 0, inserted: 0, matched: 0, error: null })
    expect((await service.listTransactions({ accountId: feedAccountId })).total).toBe(before)
  })

  it('dashboard June spend counts the overlap exactly once', async () => {
    const { service } = world
    await service.syncNow()
    const dash = await service.getDashboard('2026-06')
    const byCategory = new Map(dash.byCategory.map((c) => [c.categoryId, c.netCents]))
    expect(byCategory.get('food_and_drink')).toBe(-1350) // 2 coffees, once each
    expect(byCategory.get('groceries')).toBe(-9241) // one groceries row, not two
    // July pending is excluded from June and from historical totals
    expect(dash.pendingCents).toBe(0)
  })
})
