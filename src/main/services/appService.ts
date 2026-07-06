import type { Api } from '../../shared/ipcContract'
import type {
  AccountDto,
  EnrollmentResult,
  ImportReport,
  Institution,
  RecategorizeInput,
  SettingsDto,
  SyncReport,
  TellerEnv,
  TxnDraft,
  TxnQuery,
} from '../../shared/types'
import { normalizePayee } from '../core/categorize/normalizer'
import { parseCsv } from '../core/csv'
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../core/ollama/client'
import type { Clock, SecretStore } from '../core/ports'
import { reconcile } from '../core/reconcile/reconciler'
import { mapTellerTxn, SyncEngine } from '../core/teller/sync'
import type { TellerTransaction } from '../core/teller/types'
import type { SqliteRepo } from '../db/repository'
import type { DialogApi } from '../platform/api'
import type { EnrollmentServerHandle, EnrollmentServerOpts } from '../platform/enrollmentServer'
import { categorizeRows, type CategorizableRow, type LlmPort } from './categorization'
import { accessTokenKey, runEnrollment, type TellerClientPort } from './enrollmentFlow'

export { accessTokenKey, type TellerClientPort } from './enrollmentFlow'

/**
 * AppService — the composition root behind the IPC contract (plan §3).
 * Implements the full renderer-facing Api by wiring the frozen core modules
 * (csv, reconcile, categorize, teller, ollama) to the SQLite repository.
 * Every dependency is injected so the whole service unit-tests without
 * Electron; index.ts supplies the real implementations.
 */

export const SETTINGS_KEY = 'app_settings'
export const SETTINGS_DEFAULTS: SettingsDto = {
  tellerEnv: 'sandbox',
  syncIntervalHours: 6,
  ollamaUrl: DEFAULT_BASE_URL,
  ollamaModel: DEFAULT_MODEL,
  enrollmentsUsed: null,
}
const TELLER_ENVS: readonly TellerEnv[] = ['sandbox', 'development']
const EXPORT_ROW_LIMIT = 1_000_000

export interface AppServiceDeps {
  repo: SqliteRepo
  secrets: SecretStore
  clock: Clock
  dialog: DialogApi
  makeLlm: (settings: SettingsDto) => LlmPort
  makeTellerClient: (accessToken: string) => TellerClientPort
  startEnrollmentServer: (opts: EnrollmentServerOpts) => Promise<EnrollmentServerHandle>
  /** open the enrollment URL in the system browser (electron shell in prod) */
  openExternal: (url: string) => Promise<void>
  getApplicationId: () => Promise<string>
}

export class AppService implements Api {
  constructor(private readonly deps: AppServiceDeps) {}

  // ---- accounts -----------------------------------------------------------

  async listAccounts(): Promise<AccountDto[]> {
    return this.deps.repo.listAccounts()
  }

  async createCsvAccount(input: {
    name: string
    institution: Institution
    type: 'depository' | 'credit'
    mask?: string
  }): Promise<AccountDto> {
    return this.deps.repo.createAccount({
      name: input.name,
      institution: input.institution,
      sourceKind: 'csv_only',
      type: input.type,
      mask: input.mask ?? null,
    })
  }

  async linkCsvHistory(
    csvAccountId: string,
    tellerAccountId: string,
  ): Promise<{ moved: number; matched: number }> {
    const moved = this.deps.repo.linkCsvHistory(csvAccountId, tellerAccountId)
    // Cross-source matching happens when the next Teller window is reconciled
    // against the merged ledger (plan §5b/§5c) — nothing to fuzzy-match yet.
    return { moved, matched: 0 }
  }

  // ---- csv import ---------------------------------------------------------

  async importCsv(input: {
    accountId: string
    fileName: string
    content: string
    commit: boolean
  }): Promise<ImportReport> {
    const { repo } = this.deps
    const account = repo.getAccount(input.accountId)
    if (account === null) {
      throw new Error(`importCsv: unknown account ${input.accountId}`)
    }
    const { format, drafts, warnings } = parseCsv(input.content, input.accountId)
    const existing = repo.listExisting(input.accountId, null)
    const outcome = reconcile(drafts, existing, { normalize: normalizePayee })

    if (input.commit) {
      repo.applyDecisions(input.accountId, outcome)
      await this.categorizeDrafts(account, drafts)
    }
    return {
      accountId: account.id,
      accountName: account.name,
      format,
      parsed: drafts.length,
      newCount: outcome.inserted,
      matchedCount: outcome.matched,
      skippedDuplicates: outcome.skipped,
      warnings,
      committed: input.commit,
    }
  }

  // ---- transactions -------------------------------------------------------

  async listTransactions(query: TxnQuery): Promise<ReturnType<SqliteRepo['listTransactions']>> {
    return this.deps.repo.listTransactions(query)
  }

  async recategorize(input: RecategorizeInput): Promise<{ updated: number }> {
    return this.deps.repo.recategorize(input, this.merchantForTxn(input.txnId))
  }

  // ---- analytics ----------------------------------------------------------

  async getDashboard(month: string): Promise<ReturnType<SqliteRepo['getDashboard']>> {
    return this.deps.repo.getDashboard(month)
  }

  async listCategories(): Promise<ReturnType<SqliteRepo['listCategories']>> {
    return this.deps.repo.listCategories()
  }

  // ---- review queue -------------------------------------------------------

  async listReviewQueue(): Promise<ReturnType<SqliteRepo['listReviewQueue']>> {
    return this.deps.repo.listReviewQueue()
  }

  /** confirm/fix an LLM guess: user category + locked merchant cache (plan §6) */
  async resolveReview(txnId: string, categoryId: string): Promise<void> {
    this.deps.repo.recategorize(
      { txnId, categoryId, scope: 'merchant', applyToExisting: false },
      this.merchantForTxn(txnId),
    )
  }

  // ---- teller sync --------------------------------------------------------

  async syncNow(): Promise<SyncReport> {
    const { repo, clock } = this.deps
    const settings = await this.getSettings()
    const ranAt = new Date(clock.nowMs()).toISOString()
    const tellerAccounts = repo
      .listAccounts()
      .filter((a) => a.sourceKind === 'teller' && a.tellerAccountId !== null && !a.closed)
    const accounts: SyncReport['accounts'] = []
    for (const account of tellerAccounts) {
      accounts.push(await this.syncOne(account, settings, ranAt))
    }
    return { ranAt, accounts }
  }

  private async syncOne(
    account: AccountDto,
    settings: SettingsDto,
    ranAt: string,
  ): Promise<SyncReport['accounts'][number]> {
    const { repo, clock, secrets } = this.deps
    let entry: SyncReport['accounts'][number]
    try {
      const tellerAccountId = account.tellerAccountId
      if (tellerAccountId === null || account.tellerEnrollmentId === null) {
        throw new Error(`account ${account.id} is missing its Teller linkage`)
      }
      const token = await secrets.get(accessTokenKey(account.tellerEnrollmentId))
      if (token === null) {
        throw new Error(`no access token stored for enrollment ${account.tellerEnrollmentId}`)
      }
      const client = this.deps.makeTellerClient(token)
      const fetchedLog: TellerTransaction[] = []
      const engine = new SyncEngine({
        client: {
          listTransactions: async (id, opts) => {
            const page = await client.listTransactions(id, opts)
            fetchedLog.push(...page)
            return page
          },
        },
        repo,
        clock,
        reconcile: (incoming, existing) =>
          reconcile([...incoming], [...existing], { normalize: normalizePayee }),
      })
      const result = await engine.syncAccount({ id: account.id, tellerAccountId })
      if (result.error === 'reconnect_required') {
        repo.updateAccountStatus(account.id, 'reconnect_required')
      } else {
        repo.updateAccountStatus(account.id, 'ok')
        await this.categorizeDrafts(account, dedupeById(fetchedLog).map(mapTellerTxn), settings)
      }
      entry = { accountId: account.id, ...result }
    } catch (err) {
      entry = {
        accountId: account.id,
        fetched: 0,
        inserted: 0,
        matched: 0,
        gcPending: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
    repo.insertSyncLog({
      ranAt,
      source: 'teller',
      accountId: entry.accountId,
      fetched: entry.fetched,
      inserted: entry.inserted,
      matched: entry.matched,
      gcPending: entry.gcPending,
      errors: entry.error,
    })
    return entry
  }

  // ---- enrollment ---------------------------------------------------------

  async startEnrollment(institution?: Institution): Promise<EnrollmentResult> {
    try {
      return await this.runEnrollment({ institution })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** update mode — MUST reuse the existing enrollment (plan §3 quota rule) */
  async reconnect(accountId: string): Promise<EnrollmentResult> {
    try {
      const account = this.deps.repo.getAccount(accountId)
      if (account === null) throw new Error(`reconnect: unknown account ${accountId}`)
      if (account.tellerEnrollmentId === null) {
        throw new Error(`reconnect: account ${accountId} has no Teller enrollment`)
      }
      const result = await this.runEnrollment({ existing: account })
      this.deps.repo.updateAccountStatus(accountId, 'ok')
      return result
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async runEnrollment(opts: {
    institution?: Institution
    existing?: AccountDto
  }): Promise<EnrollmentResult> {
    return runEnrollment(this.deps, {
      settings: await this.getSettings(),
      institution: opts.institution,
      existing: opts.existing,
      // only a brand-new enrollment burns lifetime quota (plan §3)
      recordNewEnrollment: async () => {
        const current = await this.getSettings()
        await this.updateSettings({ enrollmentsUsed: (current.enrollmentsUsed ?? 0) + 1 })
      },
    })
  }

  // ---- settings & export --------------------------------------------------

  async getSettings(): Promise<SettingsDto> {
    const stored = this.deps.repo.getSetting<Partial<SettingsDto>>(SETTINGS_KEY)
    return { ...SETTINGS_DEFAULTS, ...(stored ?? {}) }
  }

  async updateSettings(patch: Partial<SettingsDto>): Promise<SettingsDto> {
    validateSettingsPatch(patch)
    const next = { ...(await this.getSettings()), ...patch }
    this.deps.repo.setSetting(SETTINGS_KEY, next)
    return next
  }

  async exportData(): Promise<{ path: string }> {
    const { repo, clock, dialog } = this.deps
    const payload = {
      exportedAt: new Date(clock.nowMs()).toISOString(),
      accounts: repo.listAccounts(),
      categories: repo.listCategories(),
      transactions: repo.listTransactions({ limit: EXPORT_ROW_LIMIT }).rows,
    }
    const path = await dialog.saveFile(
      `whats-left-export-${clock.todayIso()}.json`,
      JSON.stringify(payload, null, 2),
    )
    if (path === null) throw new Error('Export cancelled')
    return { path }
  }

  // ---- internals ----------------------------------------------------------

  /**
   * Categorize the still-uncategorized rows behind a batch of drafts.
   * Drafts are mapped to their inserted rows via the idempotency hash; rows
   * that already carry a category are never touched (plan §3 invariant 5).
   */
  private async categorizeDrafts(
    account: AccountDto,
    drafts: readonly TxnDraft[],
    settings?: SettingsDto,
  ): Promise<void> {
    const { repo } = this.deps
    const rows: CategorizableRow[] = []
    for (const draft of drafts) {
      const hit = repo.findByImportHash(account.id, draft.source, draft.importHash)
      if (hit !== null && hit.categoryId === null) {
        rows.push({ txnId: hit.id, draft, accountType: account.type })
      }
    }
    if (rows.length === 0) return
    const llm = this.deps.makeLlm(settings ?? (await this.getSettings()))
    await categorizeRows(rows, { cache: repo, llm })
  }

  private merchantForTxn(txnId: string): string {
    const txn = this.deps.repo.getTransaction(txnId)
    if (txn === null) throw new Error(`unknown transaction ${txnId}`)
    return normalizePayee(txn.payee)
  }
}

function dedupeById(txns: readonly TellerTransaction[]): TellerTransaction[] {
  const seen = new Set<string>()
  return txns.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
}

function validateSettingsPatch(patch: Partial<SettingsDto>): void {
  if (patch.tellerEnv !== undefined && !TELLER_ENVS.includes(patch.tellerEnv)) {
    throw new Error(`updateSettings: unknown tellerEnv ${JSON.stringify(patch.tellerEnv)}`)
  }
  if (
    patch.syncIntervalHours !== undefined &&
    !(Number.isFinite(patch.syncIntervalHours) && patch.syncIntervalHours > 0)
  ) {
    throw new Error(`updateSettings: syncIntervalHours must be > 0, got ${patch.syncIntervalHours}`)
  }
  if (patch.ollamaUrl !== undefined && patch.ollamaUrl.trim() === '') {
    throw new Error('updateSettings: ollamaUrl must be non-empty')
  }
  if (patch.ollamaModel !== undefined && patch.ollamaModel.trim() === '') {
    throw new Error('updateSettings: ollamaModel must be non-empty')
  }
  if (
    patch.enrollmentsUsed !== undefined &&
    patch.enrollmentsUsed !== null &&
    !(Number.isInteger(patch.enrollmentsUsed) && patch.enrollmentsUsed >= 0)
  ) {
    throw new Error(`updateSettings: enrollmentsUsed must be a non-negative integer or null`)
  }
}
