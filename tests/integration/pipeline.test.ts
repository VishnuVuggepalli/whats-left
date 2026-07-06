import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppService, accessTokenKey, type AppServiceDeps } from '../../src/main/services/appService'
import type { LlmPort } from '../../src/main/services/categorization'
import type { SqliteRepo } from '../../src/main/db/repository'
import type { Db } from '../../src/main/db/db'
import { makeRepo } from '../../src/main/db/testSupport'
import { FakeDialog, FixedClock, InMemorySecretStore } from '../../src/main/platform/fakes'
import { tellerTransactionsSchema, type TellerTransaction } from '../../src/main/core/teller/types'

/**
 * THE end-to-end logic test (no electron): CSV backfill → categorization →
 * link history onto the Teller account → Teller sync over a fake transport →
 * dashboard truths (plan §5c required tests + §5d integrity + pending
 * semantics), all through the public AppService Api.
 */

const CHASE_CREDIT_CSV = readFileSync('/root/whats-left/fixtures/csv/chase_credit.csv', 'utf8')
const CHASE_CHECKING_CSV = readFileSync('/root/whats-left/fixtures/csv/chase_checking.csv', 'utf8')
const TELLER_TXNS: TellerTransaction[] = tellerTransactionsSchema.parse(
  JSON.parse(readFileSync('/root/whats-left/fixtures/teller/transactions_chase_cc.json', 'utf8')),
)

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
  tokensSeen: string[]
}

function makeWorld(): World {
  const { db, repo } = makeRepo()
  const secrets = new InMemorySecretStore()
  const tokensSeen: string[] = []
  const deps: AppServiceDeps = {
    repo,
    secrets,
    clock: new FixedClock('2026-07-06', Date.UTC(2026, 6, 6, 12)),
    dialog: new FakeDialog(),
    makeLlm: () => offlineLlm,
    // FAKE transport: serves the sanitized Teller fixture in one page
    makeTellerClient: (accessToken) => {
      tokensSeen.push(accessToken)
      return {
        listAccounts: async () => [],
        listTransactions: async (accountId: string) => {
          if (accountId !== 'acc_chase_cc_1') {
            throw new Error(`fixture has no transactions for ${accountId}`)
          }
          return TELLER_TXNS
        },
      }
    },
    startEnrollmentServer: async () => {
      throw new Error('enrollment not exercised here')
    },
    openExternal: async () => {},
    getApplicationId: async () => 'app_test',
  }
  return { service: new AppService(deps), repo, db, secrets, tokensSeen }
}

describe('end-to-end pipeline: CSV backfill → link → Teller sync → dashboard', () => {
  let world: World
  let creditCsvId: string
  let checkingId: string
  let tellerAccountId: string

  beforeEach(async () => {
    world = makeWorld()
    const { service, repo, secrets } = world

    // 1) CSV backfill into a csv-only credit account
    const creditCsv = await service.createCsvAccount({
      name: 'Chase Freedom (CSV)',
      institution: 'chase',
      type: 'credit',
      mask: '4321',
    })
    creditCsvId = creditCsv.id
    const report = await service.importCsv({
      accountId: creditCsvId,
      fileName: 'Chase4321_Activity.csv',
      content: CHASE_CREDIT_CSV,
      commit: true,
    })
    expect(report).toMatchObject({ parsed: 9, newCount: 9, matchedCount: 0, committed: true })

    // checking side too, so §5d payments integrity has both legs
    const checking = await service.createCsvAccount({
      name: 'Chase Checking',
      institution: 'chase',
      type: 'depository',
    })
    checkingId = checking.id
    await service.importCsv({
      accountId: checkingId,
      fileName: 'Chase_Checking.csv',
      content: CHASE_CHECKING_CSV,
      commit: true,
    })

    // 2) a Teller-linked account appears (as the enrollment flow would create it)
    tellerAccountId = repo.createAccount({
      name: 'Chase Freedom',
      institution: 'chase',
      sourceKind: 'teller',
      type: 'credit',
      mask: '4321',
      tellerAccountId: 'acc_chase_cc_1',
      tellerEnrollmentId: 'enr_chase_1',
    }).id
    await secrets.set(accessTokenKey('enr_chase_1'), 'tok_test')

    // 3) pull the CSV history onto it
    const linked = await service.linkCsvHistory(creditCsvId, tellerAccountId)
    expect(linked.moved).toBe(9)
  })

  it('CSV import categorized the payment row via default rules, the rest via source labels', async () => {
    const { rows } = await world.service.listTransactions({ accountId: tellerAccountId })
    expect(rows).toHaveLength(9)
    const payment = rows.find((r) => r.rawDescription.includes('Payment Thank You'))
    expect(payment).toMatchObject({ categoryId: 'loan_payments', categorySource: 'rule' })
    expect(rows.filter((r) => r.categoryId === null)).toEqual([])
  })

  it('syncNow reconciles the Teller window against the linked CSV history without duplicating', async () => {
    const { service, tokensSeen } = world
    const report = await service.syncNow()

    expect(tokensSeen).toEqual(['tok_test'])
    expect(report.accounts).toEqual([
      {
        accountId: tellerAccountId,
        fetched: 6,
        inserted: 1, // only the new pending row
        matched: 5, // every posted fixture txn found its CSV twin
        gcPending: 0,
        error: null,
      },
    ])

    // the two identical same-day coffees matched 1:1 — 2 rows, not 4, distinct teller ids
    const coffees = (await service.listTransactions({ accountId: tellerAccountId, text: 'COFFEE' })).rows
    expect(coffees).toHaveLength(2)
    expect(new Set(coffees.map((c) => c.externalId))).toEqual(
      new Set(['txn_cc_coffee_a', 'txn_cc_coffee_b']),
    )
    // date precedence: CSV transaction date (Jun 25) beats Teller posting date (Jun 27)
    for (const coffee of coffees) {
      expect(coffee.txnDate).toBe('2026-06-25')
      expect(coffee.status).toBe('posted')
    }

    // total rows: 9 CSV + 1 new pending
    expect((await service.listTransactions({ accountId: tellerAccountId })).total).toBe(10)

    // the pending transaction is present, uncategorized (LLM offline), pendingCents set
    const pending = (
      await service.listTransactions({ accountId: tellerAccountId, status: 'pending' })
    ).rows
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      externalId: 'txn_pending_new1',
      amountCents: -4200,
      txnDate: '2026-07-05',
      categoryId: null,
    })
    expect((await service.getDashboard('2026-07')).pendingCents).toBe(-4200)

    // sync_log row was written
    const log = world.db
      .prepare('SELECT * FROM sync_log ORDER BY ran_at')
      .all() as Array<Record<string, unknown>>
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      source: 'teller',
      account_id: tellerAccountId,
      fetched: 6,
      inserted: 1,
      matched: 5,
      errors: null,
    })
  })

  it('a second syncNow is idempotent — no new rows, nothing tombstoned', async () => {
    const { service } = world
    await service.syncNow()
    const before = (await service.listTransactions({ accountId: tellerAccountId })).total
    const second = await service.syncNow()
    expect(second.accounts[0]!.inserted).toBe(0)
    expect(second.accounts[0]!.gcPending).toBe(0)
    expect((await service.listTransactions({ accountId: tellerAccountId })).total).toBe(before)
  })

  it('dashboard month totals are correct and payments integrity does not diverge', async () => {
    const { service } = world
    await service.syncNow()
    const dash = await service.getDashboard('2026-06')

    const byCategory = new Map(dash.byCategory.map((c) => [c.categoryId, c.netCents]))
    expect(byCategory.get('food_and_drink')).toBe(-1350) // 2 coffees, counted once each
    expect(byCategory.get('groceries')).toBe(-9241)
    expect(byCategory.get('transportation')).toBe(-4810)
    expect(byCategory.get('general_merchandise')).toBe(-12999 + 6499) // refund nets down
    expect(byCategory.get('rent_and_utilities')).toBe(-1549)
    expect(byCategory.get('travel')).toBe(-41260)
    // transfers/payments/income never appear as spend categories
    expect(byCategory.has('loan_payments')).toBe(false)
    expect(byCategory.has('income')).toBe(false)

    const june = dash.trend.find((t) => t.month === '2026-06')
    expect(june).toEqual({ month: '2026-06', spendCents: -64710, incomeCents: 250000 })

    // §5d: card autopay leaving checking ≈ payment received on the card
    expect(dash.paymentsIntegrity).toEqual({
      checkingSideCents: 84355,
      cardSideCents: 84355,
      diverges: false,
    })

    // June pendings: none (the pending fixture row is July)
    expect(dash.pendingCents).toBe(0)

    const top = dash.topMerchants[0]
    expect(top?.netCents).toBe(-41260) // United flight dominates June
  })

  it('month totals are stable regardless of import order (CSV date precedence held)', async () => {
    // sync FIRST on a fresh world, then import the CSV — June must look identical
    const fresh = makeWorld()
    const teller = fresh.repo.createAccount({
      name: 'Chase Freedom',
      institution: 'chase',
      sourceKind: 'teller',
      type: 'credit',
      tellerAccountId: 'acc_chase_cc_1',
      tellerEnrollmentId: 'enr_chase_1',
    })
    await fresh.secrets.set(accessTokenKey('enr_chase_1'), 'tok_test')
    const syncReport = await fresh.service.syncNow()
    expect(syncReport.accounts[0]).toMatchObject({ fetched: 6, inserted: 6, matched: 0 })

    const csvReport = await fresh.service.importCsv({
      accountId: teller.id,
      fileName: 'Chase4321_Activity.csv',
      content: CHASE_CREDIT_CSV,
      commit: true,
    })
    // 5 CSV rows match the synced Teller rows; the 4 CSV-only rows insert
    expect(csvReport.matchedCount).toBe(5)
    expect(csvReport.newCount).toBe(4)
    expect((await fresh.service.listTransactions({ accountId: teller.id })).total).toBe(10)

    // the coffee pair still lands in June on the CSV transaction date
    const coffees = (
      await fresh.service.listTransactions({ accountId: teller.id, text: 'COFFEE' })
    ).rows
    expect(coffees.map((c) => c.txnDate)).toEqual(['2026-06-25', '2026-06-25'])
  })
})
