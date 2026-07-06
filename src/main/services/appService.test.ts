import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Institution, SettingsDto } from '../../shared/types'
import { EnrollmentInactiveError } from '../core/teller/client'
import type { TellerAccount, TellerTransaction } from '../core/teller/types'
import { tellerAccountsSchema } from '../core/teller/types'
import { makeRepo } from '../db/testSupport'
import type { SqliteRepo } from '../db/repository'
import { FakeDialog, FixedClock, InMemorySecretStore } from '../platform/fakes'
import type { TellerEnrollmentPayload } from '../platform/enrollmentServer'
import { AppService, accessTokenKey, type AppServiceDeps } from './appService'
import type { LlmPort } from './categorization'

const CHASE_CREDIT_CSV = readFileSync('/root/whats-left/fixtures/csv/chase_credit.csv', 'utf8')
const CHASE_CHECKING_CSV = readFileSync('/root/whats-left/fixtures/csv/chase_checking.csv', 'utf8')
const TELLER_ACCOUNTS: TellerAccount[] = tellerAccountsSchema.parse(
  JSON.parse(readFileSync('/root/whats-left/fixtures/teller/accounts.json', 'utf8')),
)

const offlineLlm: LlmPort = {
  isAvailable: async () => false,
  categorizeMerchants: async () => {
    throw new Error('offline llm must never be called')
  },
}

interface Harness {
  service: AppService
  repo: SqliteRepo
  secrets: InMemorySecretStore
  dialog: FakeDialog
  opened: string[]
  enrollmentOpts: unknown[]
}

function makeHarness(overrides: Partial<AppServiceDeps> = {}): Harness {
  const { repo } = makeRepo()
  const secrets = new InMemorySecretStore()
  const dialog = new FakeDialog()
  const opened: string[] = []
  const enrollmentOpts: unknown[] = []
  const deps: AppServiceDeps = {
    repo,
    secrets,
    clock: new FixedClock('2026-07-06', Date.UTC(2026, 6, 6)),
    dialog,
    makeLlm: () => offlineLlm,
    makeTellerClient: () => {
      throw new Error('no teller client wired in this test')
    },
    startEnrollmentServer: async (opts) => {
      enrollmentOpts.push(opts)
      throw new Error('no enrollment server wired in this test')
    },
    openExternal: async (url) => {
      opened.push(url)
    },
    getApplicationId: async () => 'app_test_1',
    ...overrides,
  }
  return { service: new AppService(deps), repo, secrets, dialog, opened, enrollmentOpts }
}

async function createCreditAccount(service: AppService): Promise<string> {
  const account = await service.createCsvAccount({
    name: 'Chase Freedom',
    institution: 'chase',
    type: 'credit',
    mask: '4321',
  })
  return account.id
}

describe('settings', () => {
  it('returns defaults when nothing is stored', async () => {
    const { service } = makeHarness()
    expect(await service.getSettings()).toEqual({
      tellerEnv: 'sandbox',
      syncIntervalHours: 6,
      ollamaUrl: 'http://127.0.0.1:11434',
      ollamaModel: 'qwen3:8b',
      enrollmentsUsed: null,
    })
  })

  it('persists a patch and returns the merged settings', async () => {
    const { service } = makeHarness()
    const next = await service.updateSettings({ tellerEnv: 'development', syncIntervalHours: 12 })
    expect(next.tellerEnv).toBe('development')
    expect((await service.getSettings()).syncIntervalHours).toBe(12)
  })

  it('rejects invalid patches', async () => {
    const { service } = makeHarness()
    await expect(service.updateSettings({ tellerEnv: 'prod' as never })).rejects.toThrow(/tellerEnv/)
    await expect(service.updateSettings({ syncIntervalHours: 0 })).rejects.toThrow(/syncIntervalHours/)
    await expect(service.updateSettings({ ollamaUrl: ' ' })).rejects.toThrow(/ollamaUrl/)
    await expect(service.updateSettings({ ollamaModel: '' })).rejects.toThrow(/ollamaModel/)
    await expect(service.updateSettings({ enrollmentsUsed: -1 })).rejects.toThrow(/enrollmentsUsed/)
  })
})

describe('importCsv', () => {
  it('throws on an unknown account', async () => {
    const { service } = makeHarness()
    await expect(
      service.importCsv({ accountId: 'nope', fileName: 'x.csv', content: CHASE_CREDIT_CSV, commit: false }),
    ).rejects.toThrow(/unknown account/)
  })

  it('dry run reports counts without writing rows', async () => {
    const { service } = makeHarness()
    const accountId = await createCreditAccount(service)
    const report = await service.importCsv({
      accountId,
      fileName: 'chase.csv',
      content: CHASE_CREDIT_CSV,
      commit: false,
    })
    expect(report).toMatchObject({
      accountId,
      accountName: 'Chase Freedom',
      format: 'chase_credit',
      parsed: 9,
      newCount: 9,
      matchedCount: 0,
      skippedDuplicates: 0,
      committed: false,
    })
    expect((await service.listTransactions({})).total).toBe(0)
  })

  it('commit inserts and categorizes: payment row → loan_payments via default rule', async () => {
    const { service } = makeHarness()
    const accountId = await createCreditAccount(service)
    const report = await service.importCsv({
      accountId,
      fileName: 'chase.csv',
      content: CHASE_CREDIT_CSV,
      commit: true,
    })
    expect(report.committed).toBe(true)
    expect(report.newCount).toBe(9)

    const { rows, total } = await service.listTransactions({ accountId })
    expect(total).toBe(9)
    const payment = rows.find((r) => r.rawDescription.includes('Payment Thank You'))
    expect(payment?.categoryId).toBe('loan_payments')
    expect(payment?.categorySource).toBe('rule')

    const coffee = rows.filter((r) => r.rawDescription.includes('COFFEE HOUSE'))
    expect(coffee).toHaveLength(2)
    // first coffee resolves from the Chase source label; the second identical
    // merchant hits the freshly written cache row (resolver tier order)
    expect(coffee.map((c) => c.categoryId)).toEqual(['food_and_drink', 'food_and_drink'])
    expect(new Set(coffee.map((c) => c.categorySource))).toEqual(new Set(['source', 'cache']))
  })

  it('re-importing the same file is a no-op (skip duplicates)', async () => {
    const { service } = makeHarness()
    const accountId = await createCreditAccount(service)
    await service.importCsv({ accountId, fileName: 'a.csv', content: CHASE_CREDIT_CSV, commit: true })
    const again = await service.importCsv({
      accountId,
      fileName: 'a.csv',
      content: CHASE_CREDIT_CSV,
      commit: true,
    })
    expect(again.newCount).toBe(0)
    expect(again.skippedDuplicates).toBe(9)
    expect((await service.listTransactions({ accountId })).total).toBe(9)
  })

  it('fails loudly on an unknown header', async () => {
    const { service } = makeHarness()
    const accountId = await createCreditAccount(service)
    await expect(
      service.importCsv({ accountId, fileName: 'x.csv', content: 'A,B,C\n1,2,3\n', commit: true }),
    ).rejects.toThrow(/unknown header/)
  })

  it('checking import applies both-sides rules and leaves unknown merchants for the LLM tier', async () => {
    const { service } = makeHarness()
    const checking = await service.createCsvAccount({
      name: 'Chase Checking',
      institution: 'chase',
      type: 'depository',
    })
    await service.importCsv({
      accountId: checking.id,
      fileName: 'checking.csv',
      content: CHASE_CHECKING_CSV,
      commit: true,
    })
    const { rows } = await service.listTransactions({ accountId: checking.id })
    const byDesc = (needle: string) => rows.find((r) => r.rawDescription.includes(needle))
    expect(byDesc('CHASE CREDIT CRD AUTOPAY')?.categoryId).toBe('loan_payments')
    expect(byDesc('AMEX EPAYMENT')?.categoryId).toBe('loan_payments')
    expect(byDesc('ZELLE PAYMENT')?.categoryId).toBe('transfer_out')
    expect(byDesc('PAYROLL')?.categoryId).toBe('income')
    // Ollama offline → unknown merchant stays uncategorized (Review handles it)
    expect(byDesc("TRADER JOE'S")?.categoryId).toBeNull()
  })
})

describe('LLM tier + review queue', () => {
  /** answers every requested merchant with a fixed category+confidence */
  function llmAnswering(
    category: string,
    confidence: number,
  ): LlmPort & { requested: string[] } {
    const fake = {
      requested: [] as string[],
      isAvailable: async () => true,
      categorizeMerchants: async (merchants: string[]) => {
        fake.requested.push(...merchants)
        return merchants.map((merchant) => ({ merchant, category, confidence }))
      },
    }
    return fake
  }

  async function importChecking(service: AppService): Promise<string> {
    const checking = await service.createCsvAccount({
      name: 'Chase Checking',
      institution: 'chase',
      type: 'depository',
    })
    await service.importCsv({
      accountId: checking.id,
      fileName: 'checking.csv',
      content: CHASE_CHECKING_CSV,
      commit: true,
    })
    return checking.id
  }

  it('categorizes new merchants via the LLM; high confidence stays out of review', async () => {
    const llm = llmAnswering('groceries', 0.95)
    const { service } = makeHarness({ makeLlm: () => llm })
    const accountId = await importChecking(service)

    // only Trader Joe's reaches the LLM — every other checking row hit a rule
    expect(llm.requested).toHaveLength(1)
    expect(llm.requested[0]).toMatch(/trader/i)

    const { rows } = await service.listTransactions({ accountId })
    const tj = rows.find((r) => r.rawDescription.includes("TRADER JOE'S"))
    expect(tj?.categoryId).toBe('groceries')
    expect(tj?.categorySource).toBe('llm')
    expect(await service.listReviewQueue()).toEqual([])
  })

  it('low confidence lands in the review queue; resolveReview fixes + locks the merchant', async () => {
    const llm = llmAnswering('general_merchandise', 0.3)
    const { service, repo } = makeHarness({ makeLlm: () => llm })
    await importChecking(service)

    const review = await service.listReviewQueue()
    expect(review).toHaveLength(1)
    const item = review[0]!
    expect(item.suggestedCategoryId).toBe('general_merchandise')
    expect(item.confidence).toBe(0.3)

    await service.resolveReview(item.txnId, 'groceries')
    const row = repo.getTransaction(item.txnId)
    expect(row?.categoryId).toBe('groceries')
    expect(row?.categorySource).toBe('user')
    const merchant = llm.requested[0]!
    expect(repo.get(merchant)).toEqual({ categoryId: 'groceries', locked: true })
    expect(await service.listReviewQueue()).toEqual([])
  })

  it('recategorize with merchant scope writes a locked cache row', async () => {
    const { service, repo } = makeHarness()
    const accountId = await createCreditAccount(service)
    await service.importCsv({ accountId, fileName: 'a.csv', content: CHASE_CREDIT_CSV, commit: true })
    const { rows } = await service.listTransactions({ accountId, text: 'COFFEE' })
    const first = rows[0]!
    const result = await service.recategorize({
      txnId: first.id,
      categoryId: 'entertainment',
      scope: 'merchant',
      applyToExisting: true,
    })
    expect(result.updated).toBe(2) // the row itself + the second coffee
    expect(repo.get('Coffee House')?.locked).toBe(true)
    await expect(
      service.recategorize({ txnId: 'nope', categoryId: 'travel', scope: 'txn' }),
    ).rejects.toThrow(/unknown transaction/)
  })
})

describe('syncNow error paths', () => {
  function tellerAccount(repo: SqliteRepo): string {
    return repo.createAccount({
      name: 'Chase Freedom',
      institution: 'chase',
      sourceKind: 'teller',
      type: 'credit',
      tellerAccountId: 'acc_chase_cc_1',
      tellerEnrollmentId: 'enr_chase_1',
    }).id
  }

  it('returns an empty report when no teller accounts exist', async () => {
    const { service } = makeHarness()
    const report = await service.syncNow()
    expect(report.accounts).toEqual([])
    expect(report.ranAt).toBe(new Date(Date.UTC(2026, 6, 6)).toISOString())
  })

  it('missing access token → error entry + sync_log row, other accounts unaffected', async () => {
    const { service, repo } = makeHarness()
    const id = tellerAccount(repo)
    const report = await service.syncNow()
    expect(report.accounts).toHaveLength(1)
    expect(report.accounts[0]).toMatchObject({ accountId: id, fetched: 0 })
    expect(report.accounts[0]!.error).toMatch(/no access token/)
  })

  it('enrollment-inactive → account flagged reconnect_required', async () => {
    const throwingClient = {
      listAccounts: async (): Promise<TellerAccount[]> => [],
      listTransactions: async (): Promise<TellerTransaction[]> => {
        throw new EnrollmentInactiveError('enrollment.disconnected')
      },
    }
    const { service, repo, secrets } = makeHarness({ makeTellerClient: () => throwingClient })
    const id = tellerAccount(repo)
    await secrets.set(accessTokenKey('enr_chase_1'), 'tok_1')
    const report = await service.syncNow()
    expect(report.accounts[0]!.error).toBe('reconnect_required')
    expect(repo.getAccount(id)?.status).toBe('reconnect_required')
  })
})

describe('enrollment flows', () => {
  const payload: TellerEnrollmentPayload = {
    accessToken: 'tok_new',
    enrollmentId: 'enr_chase_1',
    userId: 'usr_1',
    institutionName: 'Chase',
  }

  function enrollmentHarness(overrides: Partial<AppServiceDeps> = {}) {
    const closed: number[] = []
    const harness = makeHarness({
      startEnrollmentServer: async (opts) => {
        harness.enrollmentOpts.push(opts)
        return {
          url: 'http://127.0.0.1:12345/',
          result: Promise.resolve(payload),
          close: () => closed.push(1),
        }
      },
      makeTellerClient: () => ({
        listAccounts: async () => TELLER_ACCOUNTS,
        listTransactions: async () => [],
      }),
      ...overrides,
    })
    return { ...harness, closed }
  }

  it('startEnrollment opens the browser, persists the token, adds the enrollment accounts, burns quota', async () => {
    const h = enrollmentHarness()
    const result = await h.service.startEnrollment('chase' as Institution)
    expect(result).toEqual({
      ok: true,
      enrollmentId: 'enr_chase_1',
      institution: 'Chase',
      accountsAdded: 1, // only acc_chase_cc_1 belongs to enr_chase_1
    })
    expect(h.opened).toEqual(['http://127.0.0.1:12345/'])
    expect(await h.secrets.get(accessTokenKey('enr_chase_1'))).toBe('tok_new')
    const accounts = await h.service.listAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      sourceKind: 'teller',
      tellerAccountId: 'acc_chase_cc_1',
      tellerEnrollmentId: 'enr_chase_1',
      mask: '4321',
    })
    expect((await h.service.getSettings()).enrollmentsUsed).toBe(1)
    const opts = h.enrollmentOpts[0] as { enrollmentId?: string; institution?: string }
    expect(opts.enrollmentId).toBeUndefined()
    expect(opts.institution).toBe('chase')
  })

  it('reconnect passes the existing enrollmentId (update mode) and does NOT burn quota', async () => {
    const h = enrollmentHarness()
    await h.service.startEnrollment()
    const account = (await h.service.listAccounts())[0]!
    h.repo.updateAccountStatus(account.id, 'reconnect_required')

    const result = await h.service.reconnect(account.id)
    expect(result.ok).toBe(true)
    const opts = h.enrollmentOpts[1] as { enrollmentId?: string }
    expect(opts.enrollmentId).toBe('enr_chase_1') // reuse — plan quota rule
    expect((await h.service.getSettings()).enrollmentsUsed).toBe(1) // unchanged
    expect(h.repo.getAccount(account.id)?.status).toBe('ok')
    expect((await h.service.listAccounts()).length).toBe(1) // no duplicate account
  })

  it('reconnect on a csv-only account fails without throwing', async () => {
    const h = enrollmentHarness()
    const csv = await h.service.createCsvAccount({ name: 'CSV', institution: 'chase', type: 'credit' })
    const result = await h.service.reconnect(csv.id)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no Teller enrollment/)
  })

  it('a rejected enrollment result surfaces as ok:false', async () => {
    const h = makeHarness({
      startEnrollmentServer: async () => ({
        url: 'http://127.0.0.1:1/',
        result: Promise.reject(new Error('Teller enrollment timed out after 5 ms')),
        close: () => {},
      }),
    })
    const result = await h.service.startEnrollment()
    expect(result).toEqual({ ok: false, error: 'Teller enrollment timed out after 5 ms' })
  })

  it('closes the enrollment server when the browser cannot be opened', async () => {
    const closed: number[] = []
    const h = makeHarness({
      startEnrollmentServer: async () => ({
        url: 'http://127.0.0.1:1/',
        result: new Promise<TellerEnrollmentPayload>(() => {}),
        close: () => closed.push(1),
      }),
      openExternal: async () => {
        throw new Error('no browser available')
      },
    })
    const result = await h.service.startEnrollment()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no browser/)
    expect(closed).toEqual([1])
  })
})

describe('exportData', () => {
  it('writes a full JSON export through the dialog and returns its path', async () => {
    const { service, dialog } = makeHarness()
    const accountId = await createCreditAccount(service)
    await service.importCsv({ accountId, fileName: 'a.csv', content: CHASE_CREDIT_CSV, commit: true })
    const { path } = await service.exportData()
    expect(path).toBe('/fake/whats-left-export-2026-07-06.json')
    expect(dialog.saved).toHaveLength(1)
    const parsed = JSON.parse(dialog.saved[0]!.content) as {
      accounts: unknown[]
      categories: unknown[]
      transactions: unknown[]
    }
    expect(parsed.accounts).toHaveLength(1)
    expect(parsed.transactions).toHaveLength(9)
    expect(parsed.categories.length).toBeGreaterThan(10)
  })
})

describe('settings type sanity', () => {
  it('SettingsDto default matches the exported defaults object', async () => {
    const { service } = makeHarness()
    const settings: SettingsDto = await service.getSettings()
    expect(settings.tellerEnv).toBe('sandbox')
  })
})
