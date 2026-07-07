import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Institution, SettingsDto } from '../../shared/types'
import { ItemLoginRequiredError } from '../core/plaid/client'
import { plaidAccountsGetResponseSchema, plaidSyncResponseSchema } from '../core/plaid/types'
import { EnrollmentInactiveError } from '../core/teller/client'
import type { TellerAccount, TellerTransaction } from '../core/teller/types'
import { tellerAccountsSchema, tellerTransactionsSchema } from '../core/teller/types'
import { makeRepo } from '../db/testSupport'
import type { SqliteRepo } from '../db/repository'
import { FakeDialog, FixedClock, InMemorySecretStore } from '../platform/fakes'
import type { TellerEnrollmentPayload } from '../platform/enrollmentServer'
import type { PlaidLinkPayload } from '../platform/plaidLinkServer'
import {
  AppService,
  accessTokenKey,
  plaidAccessTokenKey,
  plaidCursorKey,
  SETTINGS_KEY,
  type AppServiceDeps,
  type PlaidClientConfig,
} from './appService'
import type { LlmPort } from './categorization'

const CHASE_CREDIT_CSV = readFileSync('/root/whats-left/fixtures/csv/chase_credit.csv', 'utf8')
const CHASE_CHECKING_CSV = readFileSync('/root/whats-left/fixtures/csv/chase_checking.csv', 'utf8')
const AMEX_EXTENDED_CSV = readFileSync('/root/whats-left/fixtures/csv/amex_extended.csv', 'utf8')
const TELLER_ACCOUNTS: TellerAccount[] = tellerAccountsSchema.parse(
  JSON.parse(readFileSync('/root/whats-left/fixtures/teller/accounts.json', 'utf8')),
)
const FIXTURE_TELLER_TXNS: TellerTransaction[] = tellerTransactionsSchema.parse(
  JSON.parse(readFileSync('/root/whats-left/fixtures/teller/transactions_chase_cc.json', 'utf8')),
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
  db: ReturnType<typeof makeRepo>['db']
  secrets: InMemorySecretStore
  dialog: FakeDialog
  opened: string[]
  enrollmentOpts: unknown[]
}

function makeHarness(overrides: Partial<AppServiceDeps> = {}): Harness {
  const { db, repo } = makeRepo()
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
    makePlaidClient: () => {
      throw new Error('no plaid client wired in this test')
    },
    startEnrollmentServer: async (opts) => {
      enrollmentOpts.push(opts)
      throw new Error('no enrollment server wired in this test')
    },
    startPlaidLinkServer: async () => {
      throw new Error('no plaid link server wired in this test')
    },
    openExternal: async (url) => {
      opened.push(url)
    },
    getApplicationId: async () => 'app_test_1',
    ...overrides,
  }
  return { service: new AppService(deps), repo, db, secrets, dialog, opened, enrollmentOpts }
}

/** teller-era harness: pins provider='teller' (the default flipped to plaid) */
function tellerHarness(overrides: Partial<AppServiceDeps> = {}): Harness {
  const harness = makeHarness(overrides)
  harness.repo.setSetting(SETTINGS_KEY, { provider: 'teller' })
  return harness
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
  it('returns defaults when nothing is stored (Plaid is the default provider)', async () => {
    const { service } = makeHarness()
    expect(await service.getSettings()).toEqual({
      provider: 'plaid',
      tellerEnv: 'sandbox',
      plaidEnv: 'sandbox',
      plaidClientId: null,
      plaidSecretSet: false,
      syncIntervalHours: 6,
      ollamaUrl: 'http://127.0.0.1:11434',
      ollamaModel: 'qwen3:8b',
      enrollmentsUsed: null,
      plaidItemsUsed: null,
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
    await expect(service.updateSettings({ provider: 'mint' as never })).rejects.toThrow(/provider/)
    await expect(service.updateSettings({ plaidEnv: 'dev' as never })).rejects.toThrow(/plaidEnv/)
    await expect(service.updateSettings({ plaidClientId: ' ' })).rejects.toThrow(/plaidClientId/)
    await expect(service.updateSettings({ plaidSecret: ' ' })).rejects.toThrow(/plaidSecret/)
    await expect(service.updateSettings({ plaidItemsUsed: -1 })).rejects.toThrow(/plaidItemsUsed/)
  })

  it('plaidSecret is write-only: stored per env in the SecretStore, never echoed back', async () => {
    const { service, secrets } = makeHarness()
    const next = await service.updateSettings({ plaidClientId: 'client_1', plaidSecret: 's3cret' })
    expect(next.plaidSecretSet).toBe(true)
    expect(JSON.stringify(next)).not.toContain('s3cret')
    expect(await secrets.get('plaid:secret:sandbox')).toBe('s3cret')

    // the settings ROW never holds the secret either
    const settings = await service.getSettings()
    expect(settings.plaidSecretSet).toBe(true)
    expect(JSON.stringify(settings)).not.toContain('s3cret')

    // per-env: production has no secret yet
    const prod = await service.updateSettings({ plaidEnv: 'production' })
    expect(prod.plaidSecretSet).toBe(false)
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

describe('importCsv reports DB-actual counts (cross-account id collisions)', () => {
  it('the same Amex file into a second account reports 0 new + a warning, never a lie', async () => {
    const { service } = makeHarness()
    const a = await service.createCsvAccount({ name: 'Amex Gold', institution: 'amex', type: 'credit' })
    const b = await service.createCsvAccount({ name: 'Amex Plat', institution: 'amex', type: 'credit' })

    const first = await service.importCsv({
      accountId: a.id,
      fileName: 'amex.csv',
      content: AMEX_EXTENDED_CSV,
      commit: true,
    })
    expect(first.newCount).toBeGreaterThan(0)
    expect(first.warnings).toEqual([])

    // wrong-account re-import: every insert is swallowed by ux_txn_external
    const second = await service.importCsv({
      accountId: b.id,
      fileName: 'amex.csv',
      content: AMEX_EXTENDED_CSV,
      commit: true,
    })
    expect(second.newCount).toBe(0) // what the DB wrote — not the reconciler's plan
    expect(second.warnings.some((w) => /already exist on another account/.test(w))).toBe(true)
    expect((await service.listTransactions({ accountId: b.id })).total).toBe(0)
  })
})

describe('uncategorized visibility (LLM offline)', () => {
  it('importCsv reports the uncategorized count and the rows appear in Review', async () => {
    const { service } = makeHarness()
    const checking = await service.createCsvAccount({
      name: 'Chase Checking',
      institution: 'chase',
      type: 'depository',
    })
    const report = await service.importCsv({
      accountId: checking.id,
      fileName: 'checking.csv',
      content: CHASE_CHECKING_CSV,
      commit: true,
    })
    expect(report.uncategorized).toBe(1) // Trader Joe's — no rule/cache/source hit

    const review = await service.listReviewQueue()
    expect(review).toHaveLength(1)
    expect(review[0]).toMatchObject({
      suggestedCategoryId: 'uncategorized',
      confidence: 0,
    })
    expect(review[0]!.payee).toMatch(/trader/i)
  })

  it('a dry run reports uncategorized 0 (nothing was categorized)', async () => {
    const { service } = makeHarness()
    const accountId = await createCreditAccount(service)
    const report = await service.importCsv({
      accountId,
      fileName: 'chase.csv',
      content: CHASE_CREDIT_CSV,
      commit: false,
    })
    expect(report.uncategorized).toBe(0)
  })
})

describe('degraded Ollama results never poison the merchant cache', () => {
  /** simulates an OllamaClient content-failure fallback batch */
  function degradedLlm(): LlmPort & { requested: string[] } {
    const fake = {
      requested: [] as string[],
      isAvailable: async () => true,
      categorizeMerchants: async (merchants: string[]) => {
        fake.requested.push(...merchants)
        return merchants.map((merchant) => ({
          merchant,
          category: 'uncategorized',
          confidence: 0,
          warning: 'model output was not valid JSON',
        }))
      },
    }
    return fake
  }

  it('fallback entries: cache stays empty, rows stay NULL for retry, count surfaced', async () => {
    const llm = degradedLlm()
    const { service, repo } = makeHarness({ makeLlm: () => llm })
    const checking = await service.createCsvAccount({
      name: 'Chase Checking',
      institution: 'chase',
      type: 'depository',
    })
    const report = await service.importCsv({
      accountId: checking.id,
      fileName: 'checking.csv',
      content: CHASE_CHECKING_CSV,
      commit: true,
    })
    expect(llm.requested).toHaveLength(1) // Trader Joe's reached the LLM tier

    // NOT counted as categorized; surfaced in the report
    expect(report.uncategorized).toBe(1)
    // NO cache row was written — the merchant will be retried next batch
    expect(repo.get(llm.requested[0]!)).toBeNull()
    // the row itself stays NULL (not 'uncategorized' with source llm)
    const { rows } = await service.listTransactions({ accountId: checking.id, text: 'TRADER' })
    expect(rows[0]).toMatchObject({ categoryId: null, categorySource: null })
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

  it('applyToExisting matches rows through normalizePayee, not raw payee equality', async () => {
    const { service, repo } = makeHarness()
    const account = await service.createCsvAccount({
      name: 'Card',
      institution: 'chase',
      type: 'credit',
    })
    // two raw payee variants of the SAME merchant (both normalize to 'Starbucks')
    const mkDraft = (importHash: string, importedPayee: string, txnDate: string) => ({
      source: 'chase_csv' as const,
      externalId: null,
      importHash,
      txnDate,
      postDate: null,
      amountCents: -500,
      status: 'posted' as const,
      rawDescription: importedPayee,
      importedPayee,
      sourceCategory: null,
      counterparty: null,
      typeCode: null,
    })
    const drafts = [
      mkDraft('h1', 'STARBUCKS #552', '2026-06-01'),
      mkDraft('h2', 'STARBUCKS 800-782-7282', '2026-06-15'),
    ]
    repo.applyDecisions(account.id, {
      decisions: drafts.map((draft) => ({ kind: 'insert' as const, draft })),
      inserted: 2,
      matched: 0,
      skipped: 0,
    })

    const { rows } = await service.listTransactions({ accountId: account.id })
    expect(rows).toHaveLength(2)
    const target = rows.find((r) => r.payee === 'STARBUCKS #552')!
    const result = await service.recategorize({
      txnId: target.id,
      categoryId: 'food_and_drink',
      scope: 'merchant',
      applyToExisting: true,
    })
    expect(result.updated).toBe(2) // BOTH raw variants — one merchant, one decision
    const after = await service.listTransactions({ accountId: account.id })
    expect(after.rows.map((r) => r.categoryId)).toEqual(['food_and_drink', 'food_and_drink'])
    // the cache row is keyed on the normalized merchant, matching future rows too
    expect(repo.get('Starbucks')).toEqual({ categoryId: 'food_and_drink', locked: true })
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
    const { service } = tellerHarness()
    const report = await service.syncNow()
    expect(report.accounts).toEqual([])
    expect(report.ranAt).toBe(new Date(Date.UTC(2026, 6, 6)).toISOString())
  })

  it('missing access token → error entry + sync_log row + account flagged error', async () => {
    const { service, repo } = tellerHarness()
    const id = tellerAccount(repo)
    const report = await service.syncNow()
    expect(report.accounts).toHaveLength(1)
    expect(report.accounts[0]).toMatchObject({ accountId: id, fetched: 0 })
    expect(report.accounts[0]!.error).toMatch(/no access token/)
    // the Accounts screen renders 'error' as a danger badge — never a green 'ok'
    expect(repo.getAccount(id)?.status).toBe('error')
  })

  it('a mid-sync transport failure flags the account status error', async () => {
    const failingClient = {
      listAccounts: async (): Promise<TellerAccount[]> => [],
      listTransactions: async (): Promise<TellerTransaction[]> => {
        throw new Error('ECONNRESET')
      },
    }
    const { service, repo, secrets } = tellerHarness({ makeTellerClient: () => failingClient })
    const id = tellerAccount(repo)
    await secrets.set(accessTokenKey('enr_chase_1'), 'tok_1')
    const report = await service.syncNow()
    expect(report.accounts[0]!.error).toBe('ECONNRESET')
    expect(repo.getAccount(id)?.status).toBe('error')
  })

  it('a categorization-phase throw keeps the REAL fetched/inserted counts and flags error', async () => {
    const fixtureClient = {
      listAccounts: async (): Promise<TellerAccount[]> => [],
      listTransactions: async (): Promise<TellerTransaction[]> => FIXTURE_TELLER_TXNS,
    }
    const explodingLlm: LlmPort = {
      isAvailable: async () => {
        throw new Error('llm exploded')
      },
      categorizeMerchants: async () => {
        throw new Error('llm exploded')
      },
    }
    const { service, repo, secrets } = tellerHarness({
      makeTellerClient: () => fixtureClient,
      makeLlm: () => explodingLlm,
    })
    const id = tellerAccount(repo)
    await secrets.set(accessTokenKey('enr_chase_1'), 'tok_1')
    const report = await service.syncNow()
    const entry = report.accounts[0]!
    expect(entry.error).toMatch(/llm exploded/)
    expect(entry.fetched).toBe(6) // the engine DID run — counts must not read 0
    expect(entry.inserted).toBe(6)
    // the run did not complete → never marked ok, lastSyncAt not stamped
    expect(repo.getAccount(id)?.status).toBe('error')
    expect(repo.getAccount(id)?.lastSyncAt).toBeNull()
  })

  it('a successful sync marks the account ok AFTER categorization and stamps lastSyncAt', async () => {
    const fixtureClient = {
      listAccounts: async (): Promise<TellerAccount[]> => [],
      listTransactions: async (): Promise<TellerTransaction[]> => FIXTURE_TELLER_TXNS,
    }
    const { service, repo, secrets } = tellerHarness({ makeTellerClient: () => fixtureClient })
    const id = tellerAccount(repo)
    repo.updateAccountStatus(id, 'error') // recovers from a previous failure
    await secrets.set(accessTokenKey('enr_chase_1'), 'tok_1')
    const report = await service.syncNow()
    expect(report.accounts[0]!.error).toBeNull()
    const account = repo.getAccount(id)
    expect(account?.status).toBe('ok')
    expect(account?.lastSyncAt).toBe(report.ranAt) // 'Never synced' is finally gone
  })

  it('per-account sync entries surface the uncategorized count', async () => {
    const fixtureClient = {
      listAccounts: async (): Promise<TellerAccount[]> => [],
      listTransactions: async (): Promise<TellerTransaction[]> => FIXTURE_TELLER_TXNS,
    }
    const { service, repo, secrets } = tellerHarness({ makeTellerClient: () => fixtureClient })
    tellerAccount(repo)
    await secrets.set(accessTokenKey('enr_chase_1'), 'tok_1')
    const report = await service.syncNow()
    // LLM offline: rows the rule/cache/source tiers missed stay uncategorized
    expect(report.accounts[0]!.uncategorized).toBeGreaterThan(0)
  })

  it('enrollment-inactive → account flagged reconnect_required', async () => {
    const throwingClient = {
      listAccounts: async (): Promise<TellerAccount[]> => [],
      listTransactions: async (): Promise<TellerTransaction[]> => {
        throw new EnrollmentInactiveError('enrollment.disconnected')
      },
    }
    const { service, repo, secrets } = tellerHarness({ makeTellerClient: () => throwingClient })
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
    const harness = tellerHarness({
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
    expect(result.error).toMatch(/no bank-feed enrollment/)
  })

  it('a rejected enrollment result surfaces as ok:false', async () => {
    const h = tellerHarness({
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
    const h = tellerHarness({
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

describe('settings change notification (scheduler re-arm hook)', () => {
  it('fires onSettingsChanged with the merged settings after an interval change', async () => {
    const seen: SettingsDto[] = []
    const { service } = makeHarness({ onSettingsChanged: (s) => seen.push(s) })
    await service.updateSettings({ syncIntervalHours: 1 })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ syncIntervalHours: 1, tellerEnv: 'sandbox' })
    await service.updateSettings({ syncIntervalHours: 12 })
    expect(seen).toHaveLength(2)
    expect(seen[1]!.syncIntervalHours).toBe(12)
  })

  it('does NOT fire when validation rejects the patch', async () => {
    const seen: SettingsDto[] = []
    const { service } = makeHarness({ onSettingsChanged: (s) => seen.push(s) })
    await expect(service.updateSettings({ syncIntervalHours: 0 })).rejects.toThrow()
    expect(seen).toEqual([])
  })

  it('corrupt stored settings degrade to defaults instead of bricking getSettings', async () => {
    const { service, db } = makeHarness()
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('app_settings', '{oops')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await service.getSettings()).toMatchObject({ tellerEnv: 'sandbox', syncIntervalHours: 6 })
      // the next write self-heals the row
      await service.updateSettings({ syncIntervalHours: 3 })
    } finally {
      errSpy.mockRestore()
    }
    expect((await service.getSettings()).syncIntervalHours).toBe(3)
  })
})

describe('settings type sanity', () => {
  it('SettingsDto default matches the exported defaults object', async () => {
    const { service } = makeHarness()
    const settings: SettingsDto = await service.getSettings()
    expect(settings.tellerEnv).toBe('sandbox')
  })
})

// ---------------------------------------------------------------------------
// Plaid provider (the default for new installs)
// ---------------------------------------------------------------------------

describe('plaid enrollment flow', () => {
  const PLAID_ACCOUNTS = plaidAccountsGetResponseSchema.parse(
    JSON.parse(readFileSync('/root/whats-left/fixtures/plaid/accounts.json', 'utf8')),
  )

  interface PlaidHarness extends Harness {
    linkTokenCalls: Array<{ clientUserId: string; updateAccessToken?: string }>
    exchangeCalls: string[]
    clientConfigs: PlaidClientConfig[]
    linkServerOpts: unknown[]
    closed: number[]
  }

  function plaidHarness(payload?: Partial<PlaidLinkPayload>): PlaidHarness {
    const linkTokenCalls: PlaidHarness['linkTokenCalls'] = []
    const exchangeCalls: string[] = []
    const clientConfigs: PlaidClientConfig[] = []
    const linkServerOpts: unknown[] = []
    const closed: number[] = []
    const resolved: PlaidLinkPayload = {
      publicToken: 'public-1',
      institutionName: 'Chase',
      institutionId: 'ins_56',
      ...payload,
    }
    const harness = makeHarness({
      makePlaidClient: (cfg) => {
        clientConfigs.push(cfg)
        return {
          createLinkToken: async (opts) => {
            linkTokenCalls.push(opts)
            return 'link-token-1'
          },
          exchangePublicToken: async (publicToken) => {
            exchangeCalls.push(publicToken)
            return { accessToken: 'access-1', itemId: 'plaid-item-01' }
          },
          transactionsSync: async () => {
            throw new Error('sync not exercised in enrollment tests')
          },
          getAccounts: async () => PLAID_ACCOUNTS,
        }
      },
      startPlaidLinkServer: async (opts) => {
        linkServerOpts.push(opts)
        return {
          url: 'http://127.0.0.1:23456/',
          result: Promise.resolve(resolved),
          close: () => closed.push(1),
        }
      },
    })
    return { ...harness, linkTokenCalls, exchangeCalls, clientConfigs, linkServerOpts, closed }
  }

  async function configurePlaid(h: Harness): Promise<void> {
    await h.service.updateSettings({ plaidClientId: 'client-1', plaidSecret: 'secret-1' })
  }

  it('startEnrollment: link token → browser → exchange → token stored per item → accounts upserted', async () => {
    const h = plaidHarness()
    await configurePlaid(h)
    const result = await h.service.startEnrollment()
    expect(result).toEqual({
      ok: true,
      enrollmentId: 'plaid-item-01',
      institution: 'Chase',
      accountsAdded: 2,
    })
    expect(h.opened).toEqual(['http://127.0.0.1:23456/'])
    expect(h.linkServerOpts).toEqual([{ linkToken: 'link-token-1' }])
    // create mode: products, no access_token
    expect(h.linkTokenCalls).toEqual([{ clientUserId: 'whats-left-local-user' }])
    expect(h.exchangeCalls).toEqual(['public-1'])
    // credentials flow from settings/secret store, never hardcoded
    expect(h.clientConfigs[0]).toEqual({ env: 'sandbox', clientId: 'client-1', secret: 'secret-1' })
    // access token persisted per env + item
    expect(await h.secrets.get(plaidAccessTokenKey('sandbox', 'plaid-item-01'))).toBe('access-1')
    // lifetime Item counter burned exactly once
    expect((await h.service.getSettings()).plaidItemsUsed).toBe(1)

    const accounts = await h.service.listAccounts()
    expect(accounts).toHaveLength(2)
    // COLUMN REUSE: teller_* columns hold the plaid account/item ids
    expect(accounts.map((a) => a.tellerAccountId).sort()).toEqual([
      'plaid-acc-amex-01',
      'plaid-acc-chase-01',
    ])
    expect(new Set(accounts.map((a) => a.tellerEnrollmentId))).toEqual(new Set(['plaid-item-01']))
    expect(new Set(accounts.map((a) => a.sourceKind))).toEqual(new Set(['teller'])) // = "bank feed"
    expect(new Set(accounts.map((a) => a.institution))).toEqual(new Set(['chase']))
    expect(accounts.map((a) => a.type).sort()).toEqual(['credit', 'depository'])
  })

  it('maps institution metadata: American Express → amex, unknown bank → other', async () => {
    const amex = plaidHarness({ institutionName: 'American Express', institutionId: 'ins_10' })
    await configurePlaid(amex)
    await amex.service.startEnrollment()
    expect(new Set((await amex.service.listAccounts()).map((a) => a.institution))).toEqual(
      new Set(['amex']),
    )

    const other = plaidHarness({ institutionName: 'First Tech FCU', institutionId: 'ins_99' })
    await configurePlaid(other)
    await other.service.startEnrollment()
    expect(new Set((await other.service.listAccounts()).map((a) => a.institution))).toEqual(
      new Set(['other']),
    )
  })

  it('re-enrolling the same item does not duplicate accounts', async () => {
    const h = plaidHarness()
    await configurePlaid(h)
    await h.service.startEnrollment()
    const again = await h.service.startEnrollment()
    expect(again.accountsAdded).toBe(0)
    expect(await h.service.listAccounts()).toHaveLength(2)
  })

  it('reconnect uses Link UPDATE MODE: access_token link token, NO exchange, NO item burn', async () => {
    const h = plaidHarness()
    await configurePlaid(h)
    await h.service.startEnrollment()
    const account = (await h.service.listAccounts())[0]!
    h.repo.updateAccountStatus(account.id, 'reconnect_required')

    const result = await h.service.reconnect(account.id)
    expect(result).toEqual({
      ok: true,
      enrollmentId: 'plaid-item-01',
      institution: account.institution,
      accountsAdded: 0,
    })
    // update mode: the SAME item's access token rides in the link token request
    expect(h.linkTokenCalls[1]).toEqual({
      clientUserId: 'whats-left-local-user',
      updateAccessToken: 'access-1',
    })
    expect(h.exchangeCalls).toEqual(['public-1']) // still just the ONE create-mode exchange
    expect((await h.service.getSettings()).plaidItemsUsed).toBe(1) // unchanged — cap protected
    expect(h.repo.getAccount(account.id)?.status).toBe('ok')
    expect(await h.service.listAccounts()).toHaveLength(2) // no duplicates
  })

  it('fails with a clear error when the client id or secret is missing', async () => {
    const noClientId = plaidHarness()
    await noClientId.service.updateSettings({ plaidSecret: 'secret-1' })
    const r1 = await noClientId.service.startEnrollment()
    expect(r1.ok).toBe(false)
    expect(r1.error).toMatch(/client_id/)

    const noSecret = plaidHarness()
    await noSecret.service.updateSettings({ plaidClientId: 'client-1' })
    const r2 = await noSecret.service.startEnrollment()
    expect(r2.ok).toBe(false)
    expect(r2.error).toMatch(/secret/)
  })

  it('closes the link server when the browser cannot be opened', async () => {
    const closed: number[] = []
    const h = makeHarness({
      makePlaidClient: () => ({
        createLinkToken: async () => 'link-token-1',
        exchangePublicToken: async () => {
          throw new Error('unreachable')
        },
        transactionsSync: async () => {
          throw new Error('unreachable')
        },
        getAccounts: async () => PLAID_ACCOUNTS,
      }),
      startPlaidLinkServer: async () => ({
        url: 'http://127.0.0.1:1/',
        result: new Promise<PlaidLinkPayload>(() => {}),
        close: () => closed.push(1),
      }),
      openExternal: async () => {
        throw new Error('no browser available')
      },
    })
    await h.service.updateSettings({ plaidClientId: 'c', plaidSecret: 's' })
    const result = await h.service.startEnrollment()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no browser/)
    expect(closed).toEqual([1])
  })
})

describe('syncNow — plaid provider dispatch', () => {
  const PAGE1 = plaidSyncResponseSchema.parse(
    JSON.parse(readFileSync('/root/whats-left/fixtures/plaid/transactions_sync_page1.json', 'utf8')),
  )
  const PAGE2 = plaidSyncResponseSchema.parse(
    JSON.parse(readFileSync('/root/whats-left/fixtures/plaid/transactions_sync_page2.json', 'utf8')),
  )

  /** serves the fixture batch by cursor; after the batch, an empty tail page */
  function fixturePlaidClient(): AppServiceDeps['makePlaidClient'] {
    return () => ({
      createLinkToken: async () => {
        throw new Error('enrollment not exercised here')
      },
      exchangePublicToken: async () => {
        throw new Error('enrollment not exercised here')
      },
      getAccounts: async () => {
        throw new Error('enrollment not exercised here')
      },
      transactionsSync: async (_token: string, cursor?: string) => {
        if (cursor === undefined) return PAGE1
        if (cursor === 'plaid-cursor-page-1') return PAGE2
        return { added: [], modified: [], removed: [], next_cursor: cursor, has_more: false }
      },
    })
  }

  async function plaidWorld(overrides: Partial<AppServiceDeps> = {}) {
    const h = makeHarness({ makePlaidClient: fixturePlaidClient(), ...overrides })
    await h.service.updateSettings({ plaidClientId: 'client-1', plaidSecret: 'secret-1' })
    const chase = h.repo.createAccount({
      name: 'Chase Total Checking',
      institution: 'chase',
      sourceKind: 'teller', // = bank feed; plaid ids live in the teller_* columns
      type: 'depository',
      tellerAccountId: 'plaid-acc-chase-01',
      tellerEnrollmentId: 'plaid-item-01',
    })
    const amex = h.repo.createAccount({
      name: 'Amex Blue Cash',
      institution: 'amex',
      sourceKind: 'teller',
      type: 'credit',
      tellerAccountId: 'plaid-acc-amex-01',
      tellerEnrollmentId: 'plaid-item-01',
    })
    await h.secrets.set(plaidAccessTokenKey('sandbox', 'plaid-item-01'), 'access-1')
    return { ...h, chase, amex }
  }

  it('syncs the item once, reports per-account entries, persists rows + cursor', async () => {
    const w = await plaidWorld()
    const report = await w.service.syncNow()

    const chaseEntry = report.accounts.find((a) => a.accountId === w.chase.id)
    const amexEntry = report.accounts.find((a) => a.accountId === w.amex.id)
    expect(chaseEntry).toMatchObject({
      fetched: 1,
      inserted: 1,
      matched: 0,
      uncategorized: 0,
      error: null,
    })
    // amex: pending coffee + groceries + posted coffee inserted; the pending
    // is then tombstoned via pending_transaction_id; the removed[] id was
    // never in the DB so only the replaced pending counts as gc'd
    expect(amexEntry).toMatchObject({
      fetched: 4,
      inserted: 3,
      matched: 0,
      gcPending: 1,
      uncategorized: 0,
      error: null,
    })

    // amounts are INVERTED plaid dollars→cents; the MODIFIED amount won
    const amexRows = (await w.service.listTransactions({ accountId: w.amex.id })).rows
    expect(amexRows).toHaveLength(2) // pending coffee is tombstoned
    const byExt = new Map(amexRows.map((r) => [r.externalId, r]))
    expect(byExt.get('plaid-txn-groceries-02')).toMatchObject({
      amountCents: -9241,
      categoryId: 'groceries', // PFC FOOD_AND_DRINK_GROCERIES via tier 3
      status: 'posted',
    })
    expect(byExt.get('plaid-txn-posted-coffee-04')).toMatchObject({
      amountCents: -485,
      categoryId: 'food_and_drink', // PFC FOOD_AND_DRINK_COFFEE → primary
    })

    const chaseRows = (await w.service.listTransactions({ accountId: w.chase.id })).rows
    expect(chaseRows[0]).toMatchObject({ amountCents: 250000, categoryId: 'income' })

    // cursor persisted only after the whole batch applied
    expect(w.repo.getSetting<string>(plaidCursorKey('plaid-item-01'))).toBe('plaid-cursor-page-2')

    // accounts marked synced; sync_log rows carry source 'plaid'
    expect(w.repo.getAccount(w.amex.id)).toMatchObject({ status: 'ok', lastSyncAt: report.ranAt })
    const log = w.db.prepare('SELECT source, errors FROM sync_log').all() as Array<
      Record<string, unknown>
    >
    expect(log).toHaveLength(2)
    expect(new Set(log.map((l) => l['source']))).toEqual(new Set(['plaid']))
  })

  it('a second syncNow resumes from the stored cursor and is idempotent', async () => {
    const w = await plaidWorld()
    await w.service.syncNow()
    const before = (await w.service.listTransactions({})).total
    const second = await w.service.syncNow()
    for (const entry of second.accounts) {
      expect(entry).toMatchObject({ fetched: 0, inserted: 0, matched: 0, gcPending: 0, error: null })
    }
    expect((await w.service.listTransactions({})).total).toBe(before)
  })

  it('cross-env accounts are excluded from the sync loop with no error entries (env scoping)', async () => {
    const w = await plaidWorld()
    const prodAcct = w.repo.createAccount({
      name: 'Real Chase',
      institution: 'chase',
      sourceKind: 'teller',
      type: 'depository',
      tellerAccountId: 'plaid-acc-prod-01',
      tellerEnrollmentId: 'plaid-item-prod-01',
      feedEnv: 'production',
    })
    const report = await w.service.syncNow() // settings default to plaidEnv 'sandbox'
    expect(report.accounts.map((a) => a.accountId)).not.toContain(prodAcct.id)
    expect(report.accounts.every((a) => a.error === null)).toBe(true)
    // the excluded account is not flagged — it is healthy, just enrolled elsewhere
    expect(w.repo.getAccount(prodAcct.id)?.status).toBe('ok')
    // legacy NULL-feed_env accounts had their env backfilled from the stored token key
    expect(w.repo.getAccount(w.chase.id)?.feedEnv).toBe('sandbox')
    expect(w.repo.getAccount(w.amex.id)?.feedEnv).toBe('sandbox')
  })

  it('ITEM_LOGIN_REQUIRED flags every account of the item reconnect_required', async () => {
    const w = await plaidWorld({
      makePlaidClient: () => ({
        createLinkToken: async () => {
          throw new Error('unreachable')
        },
        exchangePublicToken: async () => {
          throw new Error('unreachable')
        },
        getAccounts: async () => {
          throw new Error('unreachable')
        },
        transactionsSync: async () => {
          throw new ItemLoginRequiredError('reconnect required')
        },
      }),
    })
    const report = await w.service.syncNow()
    expect(report.accounts).toHaveLength(2)
    for (const entry of report.accounts) {
      expect(entry.error).toBe('reconnect_required')
    }
    expect(w.repo.getAccount(w.chase.id)?.status).toBe('reconnect_required')
    expect(w.repo.getAccount(w.amex.id)?.status).toBe('reconnect_required')
  })

  it('a missing access token → error entries + accounts flagged error + sync_log rows', async () => {
    const w = await plaidWorld()
    await w.secrets.delete(plaidAccessTokenKey('sandbox', 'plaid-item-01'))
    const report = await w.service.syncNow()
    for (const entry of report.accounts) {
      expect(entry.error).toMatch(/no Plaid access token/)
    }
    expect(w.repo.getAccount(w.amex.id)?.status).toBe('error')
    const log = w.db.prepare('SELECT errors FROM sync_log').all() as Array<Record<string, unknown>>
    expect(log).toHaveLength(2)
    expect(String(log[0]!['errors'])).toMatch(/access token/)
  })

  it('user-categorized rows survive a MODIFIED state update (invariant 5)', async () => {
    const w = await plaidWorld()
    // sync 1: only page1 (groceries at -8710) — use a client pinned to page1
    const singlePage = {
      ...PAGE1,
      has_more: false,
    }
    const mutable = { page: singlePage as typeof PAGE1 | typeof PAGE2 }
    const client = {
      createLinkToken: async () => {
        throw new Error('unreachable')
      },
      exchangePublicToken: async () => {
        throw new Error('unreachable')
      },
      getAccounts: async () => {
        throw new Error('unreachable')
      },
      transactionsSync: async (_t: string, cursor?: string) => {
        if (cursor === mutable.page.next_cursor) {
          return { added: [], modified: [], removed: [], next_cursor: cursor, has_more: false }
        }
        return mutable.page
      },
    }
    const world = await plaidWorld({ makePlaidClient: () => client })
    await world.service.syncNow()
    const groceries = (
      await world.service.listTransactions({ accountId: world.amex.id, text: 'WHOLEFDS' })
    ).rows[0]!
    expect(groceries.amountCents).toBe(-8710)

    // user recategorizes by hand
    await world.service.recategorize({
      txnId: groceries.id,
      categoryId: 'personal_care',
      scope: 'txn',
    })

    // sync 2: the bank modifies the amount
    mutable.page = { ...PAGE2, next_cursor: 'plaid-cursor-page-2b' }
    await world.service.syncNow()
    const after = world.repo.getTransaction(groceries.id)!
    expect(after.amountCents).toBe(-9241) // state updated…
    expect(after.categoryId).toBe('personal_care') // …but the user's category is untouchable
    expect(after.categorySource).toBe('user')
    void w
  })
})
