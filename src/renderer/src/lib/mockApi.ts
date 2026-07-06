/**
 * In-memory implementation of the full Api contract, used when the renderer
 * runs without the Electron preload (vite dev in a plain browser, tests).
 * Realistic demo data; state updates are immutable replacements — inputs and
 * returned DTOs are never shared with internal state (structuredClone).
 *
 * Deliberate simplifications vs the real main process (noted inline):
 * no cross-source reconciler (matchedCount is always 0), sync fetches nothing.
 */
import type { Api } from '../../../shared/ipcContract'
import type {
  AccountDto,
  ImportReport,
  Institution,
  ReviewItem,
  SettingsDto,
  TransactionDto,
  TxnQuery,
} from '../../../shared/types'
import { categorizeMockRow, parseMockCsv } from './mockCsv'
import { MOCK_CATEGORIES, seedAccounts, seedSettings, seedTransactions } from './mockData'
import { computeMockDashboard } from './mockDashboard'

interface MockState {
  accounts: readonly AccountDto[]
  transactions: readonly TransactionDto[]
  reviewItems: readonly ReviewItem[]
  settings: SettingsDto
  /** committed import hashes — mirrors UNIQUE(account_id, source, import_hash) */
  importedHashes: ReadonlySet<string>
  /** merchant → categoryId, written by "always for this merchant" (locked) */
  merchantCache: ReadonlyMap<string, string>
  counter: number
}

const INSTITUTIONS: readonly Institution[] = ['chase', 'amex']
const TELLER_ENVS = ['sandbox', 'development'] as const

function categoryNameOf(id: string): string {
  const cat = MOCK_CATEGORIES.find((c) => c.id === id)
  if (!cat) throw new Error(`Unknown category: ${JSON.stringify(id)}`)
  return cat.name
}

export function createMockApi(): Api {
  const seed = seedTransactions()
  let state: MockState = {
    accounts: seedAccounts(),
    transactions: seed.transactions,
    reviewItems: seed.reviewItems,
    settings: seedSettings(),
    importedHashes: new Set(),
    merchantCache: new Map(),
    counter: 0,
  }

  const nextId = (kind: string): string => {
    state = { ...state, counter: state.counter + 1 }
    return `mock-${kind}-${state.counter}`
  }

  const requireAccount = (id: string): AccountDto => {
    const acct = state.accounts.find((a) => a.id === id)
    if (!acct) throw new Error(`Unknown account: ${JSON.stringify(id)}`)
    return acct
  }

  const requireTxn = (id: string): TransactionDto => {
    const txn = state.transactions.find((t) => t.id === id)
    if (!txn) throw new Error(`Unknown transaction: ${JSON.stringify(id)}`)
    return txn
  }

  const setTxn = (id: string, patch: Partial<TransactionDto>): void => {
    state = {
      ...state,
      transactions: state.transactions.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }
  }

  const applyCategory = (txnId: string, categoryId: string, source: TransactionDto['categorySource']): void => {
    setTxn(txnId, { categoryId, categoryName: categoryNameOf(categoryId), categorySource: source })
  }

  const filterTransactions = (q: TxnQuery): TransactionDto[] => {
    const text = q.text?.trim().toLowerCase()
    return state.transactions
      .filter(
        (t) =>
          (q.accountId === undefined || t.accountId === q.accountId) &&
          (q.categoryId === undefined || t.categoryId === q.categoryId) &&
          (q.status === undefined || t.status === q.status) &&
          (q.from === undefined || t.txnDate >= q.from) &&
          (q.to === undefined || t.txnDate <= q.to) &&
          (text === undefined ||
            text === '' ||
            t.payee.toLowerCase().includes(text) ||
            t.rawDescription.toLowerCase().includes(text)),
      )
      .sort((a, b) => (a.txnDate === b.txnDate ? b.id.localeCompare(a.id) : a.txnDate < b.txnDate ? 1 : -1))
  }

  return {
    async listAccounts() {
      return structuredClone([...state.accounts])
    },

    async createCsvAccount(input) {
      const name = input.name.trim()
      if (name === '') throw new Error('Account name is required')
      if (!INSTITUTIONS.includes(input.institution)) {
        throw new Error(`Unknown institution: ${JSON.stringify(input.institution)}`)
      }
      if (input.type !== 'depository' && input.type !== 'credit') {
        throw new Error(`Unknown account type: ${JSON.stringify(input.type)}`)
      }
      const account: AccountDto = {
        id: nextId('acct'),
        name,
        institution: input.institution,
        sourceKind: 'csv_only',
        tellerAccountId: null,
        tellerEnrollmentId: null,
        mask: input.mask?.trim() || null,
        type: input.type,
        subtype: null,
        status: 'ok',
        closed: false,
        balanceCents: null,
        lastSyncAt: null,
      }
      state = { ...state, accounts: [...state.accounts, account] }
      return structuredClone(account)
    },

    async linkCsvHistory(csvAccountId, tellerAccountId) {
      const csvAcct = requireAccount(csvAccountId)
      const tellerAcct = requireAccount(tellerAccountId)
      if (csvAcct.sourceKind !== 'csv_only') {
        throw new Error(`Source account ${csvAcct.name} is not a CSV-only account`)
      }
      if (tellerAcct.sourceKind !== 'teller') {
        throw new Error(`Target account ${tellerAcct.name} is not a Teller-connected account`)
      }
      const moved = state.transactions.filter((t) => t.accountId === csvAccountId).length
      state = {
        ...state,
        transactions: state.transactions.map((t) =>
          t.accountId === csvAccountId ? { ...t, accountId: tellerAccountId } : t,
        ),
      }
      // Real impl runs the §5c reconciler over the merged account; the mock
      // just moves rows, so matched is honestly 0.
      return { moved, matched: 0 }
    },

    async importCsv(input) {
      const account = requireAccount(input.accountId)
      const { format, rows } = parseMockCsv(input.content)
      const source = format.startsWith('amex') ? ('amex_csv' as const) : ('chase_csv' as const)
      const occurrence = new Map<string, number>()
      const additions: TransactionDto[] = []
      const newHashes: string[] = []
      let skipped = 0
      for (const row of rows) {
        const base = `${account.id}|${source}|${row.postDate ?? row.txnDate}|${row.amountCents}|${row.description}`
        const idx = occurrence.get(base) ?? 0
        occurrence.set(base, idx + 1)
        const hash = `${base}|${idx}` // occurrence_index keeps identical same-day rows distinct (§5b)
        if (state.importedHashes.has(hash)) {
          skipped += 1
          continue
        }
        newHashes.push(hash)
        // 4-tier mirror: rules → merchant cache → source label; else uncategorized.
        const cached = state.merchantCache.get(row.payee)
        const resolved =
          categorizeMockRow(format, row) ??
          (cached !== undefined ? { categoryId: cached, categorySource: 'cache' as const } : null)
        additions.push({
          id: nextId('txn'),
          accountId: account.id,
          source,
          externalId: null,
          txnDate: row.txnDate,
          postDate: row.postDate,
          amountCents: row.amountCents,
          status: 'posted',
          payee: row.payee,
          rawDescription: row.description,
          categoryId: resolved?.categoryId ?? null,
          categoryName: resolved ? categoryNameOf(resolved.categoryId) : null,
          categorySource: resolved?.categorySource ?? null,
          sourceCategory: row.sourceCategory,
          notes: null,
        })
      }
      if (input.commit) {
        state = {
          ...state,
          transactions: [...state.transactions, ...additions],
          importedHashes: new Set([...state.importedHashes, ...newHashes]),
        }
      }
      const report: ImportReport = {
        accountId: account.id,
        accountName: account.name,
        format,
        parsed: rows.length,
        newCount: newHashes.length,
        matchedCount: 0, // mock has no cross-source reconciler
        skippedDuplicates: skipped,
        warnings: [],
        committed: input.commit,
      }
      return report
    },

    async listTransactions(query) {
      const filtered = filterTransactions(query)
      const offset = query.offset ?? 0
      const limit = query.limit ?? 500
      if (!Number.isInteger(offset) || offset < 0) throw new Error(`Invalid offset: ${offset}`)
      if (!Number.isInteger(limit) || limit < 1) throw new Error(`Invalid limit: ${limit}`)
      return { rows: structuredClone(filtered.slice(offset, offset + limit)), total: filtered.length }
    },

    async recategorize(input) {
      const txn = requireTxn(input.txnId)
      categoryNameOf(input.categoryId) // throws on unknown category
      applyCategory(txn.id, input.categoryId, 'user')
      let updated = 1
      if (input.scope === 'merchant') {
        // Locked cache row: future imports of this merchant resolve from it.
        state = { ...state, merchantCache: new Map([...state.merchantCache, [txn.payee, input.categoryId]]) }
        if (input.applyToExisting === true) {
          const others = state.transactions.filter(
            (t) => t.payee === txn.payee && t.id !== txn.id && t.categorySource !== 'user',
          )
          for (const other of others) applyCategory(other.id, input.categoryId, 'cache')
          updated += others.length
        }
      }
      return { updated }
    },

    async getDashboard(month) {
      return computeMockDashboard(month, state.transactions, state.accounts, MOCK_CATEGORIES)
    },

    async listCategories() {
      return structuredClone([...MOCK_CATEGORIES])
    },

    async listReviewQueue() {
      return structuredClone([...state.reviewItems])
    },

    async resolveReview(txnId, categoryId) {
      const item = state.reviewItems.find((r) => r.txnId === txnId)
      if (!item) throw new Error(`No review item for transaction: ${JSON.stringify(txnId)}`)
      categoryNameOf(categoryId) // throws on unknown category
      applyCategory(txnId, categoryId, 'user')
      state = { ...state, reviewItems: state.reviewItems.filter((r) => r.txnId !== txnId) }
    },

    async syncNow() {
      const ranAt = new Date().toISOString()
      const results = state.accounts
        .filter((a) => a.sourceKind === 'teller')
        .map((a) =>
          a.status === 'reconnect_required'
            ? { accountId: a.id, fetched: 0, inserted: 0, matched: 0, gcPending: 0, error: 'Enrollment inactive — reconnect required' }
            : { accountId: a.id, fetched: 4, inserted: 0, matched: 0, gcPending: 0, error: null },
        )
      state = {
        ...state,
        accounts: state.accounts.map((a) =>
          a.sourceKind === 'teller' && a.status === 'ok' ? { ...a, lastSyncAt: ranAt } : a,
        ),
      }
      return { ranAt, accounts: results }
    },

    async startEnrollment(institution = 'chase') {
      if (!INSTITUTIONS.includes(institution)) {
        throw new Error(`Unknown institution: ${JSON.stringify(institution)}`)
      }
      const id = nextId('acct')
      const enrollmentId = `enr_${id}`
      const account: AccountDto = {
        id,
        name: institution === 'chase' ? 'Chase Account (new)' : 'Amex Account (new)',
        institution,
        sourceKind: 'teller',
        tellerAccountId: `acc_${id}`,
        tellerEnrollmentId: enrollmentId,
        mask: '0000',
        type: institution === 'chase' ? 'depository' : 'credit',
        subtype: null,
        status: 'ok',
        closed: false,
        balanceCents: 0,
        lastSyncAt: null,
      }
      state = {
        ...state,
        accounts: [...state.accounts, account],
        settings: { ...state.settings, enrollmentsUsed: (state.settings.enrollmentsUsed ?? 0) + 1 },
      }
      return { ok: true, enrollmentId, institution, accountsAdded: 1 }
    },

    async reconnect(accountId) {
      const acct = requireAccount(accountId)
      if (acct.sourceKind !== 'teller' || acct.tellerEnrollmentId === null) {
        throw new Error(`Account ${acct.name} has no Teller enrollment to reconnect`)
      }
      state = {
        ...state,
        accounts: state.accounts.map((a) => (a.id === accountId ? { ...a, status: 'ok' as const } : a)),
      }
      // Update mode: same enrollment repaired, no quota burned (plan §3).
      return { ok: true, enrollmentId: acct.tellerEnrollmentId, institution: acct.institution, accountsAdded: 0 }
    },

    async getSettings() {
      return structuredClone(state.settings)
    },

    async updateSettings(patch) {
      validateSettingsPatch(patch)
      state = { ...state, settings: { ...state.settings, ...patch } }
      return structuredClone(state.settings)
    },

    async exportData() {
      return { path: '/mock-exports/whats-left-export.json' }
    },
  }
}

function validateSettingsPatch(patch: Partial<SettingsDto>): void {
  if (patch.tellerEnv !== undefined && !TELLER_ENVS.includes(patch.tellerEnv)) {
    throw new Error(`Unknown Teller environment: ${JSON.stringify(patch.tellerEnv)}`)
  }
  if (patch.syncIntervalHours !== undefined) {
    const h = patch.syncIntervalHours
    if (!Number.isFinite(h) || h <= 0 || h > 168) {
      throw new Error(`Sync interval must be between 0 and 168 hours, got: ${h}`)
    }
  }
  if (patch.ollamaUrl !== undefined && patch.ollamaUrl.trim() === '') {
    throw new Error('Ollama URL cannot be empty')
  }
  if (patch.ollamaModel !== undefined && patch.ollamaModel.trim() === '') {
    throw new Error('Ollama model cannot be empty')
  }
}
