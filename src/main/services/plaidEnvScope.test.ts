import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AccountDto, PlaidEnv, SettingsDto } from '../../shared/types'
import type { PlaidSyncResponse } from '../core/plaid/types'
import { plaidAccountsGetResponseSchema } from '../core/plaid/types'
import type { SqliteRepo } from '../db/repository'
import { makeRepo } from '../db/testSupport'
import type { Db } from '../db/db'
import { InMemorySecretStore } from '../platform/fakes'
import {
  plaidAccessTokenKey,
  plaidSecretKey,
  runPlaidEnrollment,
  type MakePlaidClient,
  type PlaidFlowDeps,
} from './plaidFlow'
import { syncPlaidProvider, type PlaidSyncDeps } from './plaidSync'

/**
 * Environment scoping for Plaid bank-feed accounts: an Item enrolled in
 * sandbox can never sync in production (INVALID_API_KEYS) and vice versa.
 * Enrollment stamps feed_env; syncNow only touches accounts whose feed_env
 * matches the active Settings.plaidEnv; legacy NULL rows are backfilled from
 * the per-env access-token keys.
 */

const PLAID_ACCOUNTS = plaidAccountsGetResponseSchema.parse(
  JSON.parse(readFileSync('/root/whats-left/fixtures/plaid/accounts.json', 'utf8')),
)

function settingsFor(env: PlaidEnv): SettingsDto {
  return {
    provider: 'plaid',
    tellerEnv: 'sandbox',
    plaidEnv: env,
    plaidClientId: 'client-1',
    plaidSecretSet: true,
    syncIntervalHours: 6,
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen3:8b',
    enrollmentsUsed: null,
    plaidItemsUsed: null,
  }
}

// ---- enrollment stamps feed_env --------------------------------------------

function enrollmentWorld(): { deps: PlaidFlowDeps; repo: SqliteRepo; secrets: InMemorySecretStore } {
  const { repo } = makeRepo()
  const secrets = new InMemorySecretStore()
  const deps: PlaidFlowDeps = {
    repo,
    secrets,
    makePlaidClient: () => ({
      createLinkToken: async () => 'link-token-1',
      exchangePublicToken: async () => ({ accessToken: 'access-1', itemId: 'item-1' }),
      transactionsSync: async () => {
        throw new Error('sync not exercised in enrollment tests')
      },
      getAccounts: async () => PLAID_ACCOUNTS,
    }),
    startPlaidLinkServer: async () => ({
      url: 'http://127.0.0.1:1/',
      result: Promise.resolve({
        publicToken: 'public-1',
        institutionName: 'Chase',
        institutionId: 'ins_56',
      }),
      close: () => {},
    }),
    openExternal: async () => {},
  }
  return { deps, repo, secrets }
}

describe('runPlaidEnrollment — feed_env stamping', () => {
  it.each(['sandbox', 'production'] as const)(
    'stamps feed_env=%s on every account created while that env is active',
    async (env) => {
      const { deps, repo, secrets } = enrollmentWorld()
      await secrets.set(plaidSecretKey(env), 'secret-1')
      const result = await runPlaidEnrollment(deps, {
        settings: settingsFor(env),
        recordNewItem: async () => {},
      })
      expect(result.ok).toBe(true)
      const accounts = repo.listAccounts()
      expect(accounts.length).toBeGreaterThan(0)
      expect(new Set(accounts.map((a) => a.feedEnv))).toEqual(new Set([env]))
    },
  )
})

// ---- syncPlaidProvider env scoping ------------------------------------------

const EMPTY_PAGE: PlaidSyncResponse = {
  added: [],
  modified: [],
  removed: [],
  next_cursor: 'cursor-next',
  has_more: false,
}

interface SyncWorld {
  db: Db
  repo: SqliteRepo
  secrets: InMemorySecretStore
  deps: PlaidSyncDeps
  /** access tokens the fake client was actually asked to sync with */
  synced: string[]
}

function syncWorld(): SyncWorld {
  const { db, repo } = makeRepo()
  const secrets = new InMemorySecretStore()
  const synced: string[] = []
  const makePlaidClient: MakePlaidClient = () => ({
    createLinkToken: async () => {
      throw new Error('enrollment not exercised here')
    },
    exchangePublicToken: async () => {
      throw new Error('enrollment not exercised here')
    },
    getAccounts: async () => {
      throw new Error('enrollment not exercised here')
    },
    transactionsSync: async (token) => {
      synced.push(token)
      return EMPTY_PAGE
    },
  })
  return {
    db,
    repo,
    secrets,
    synced,
    deps: { repo, secrets, makePlaidClient, categorize: async () => 0 },
  }
}

function addFeedAccount(
  repo: SqliteRepo,
  name: string,
  itemId: string,
  feedEnv: PlaidEnv | null,
): AccountDto {
  return repo.createAccount({
    name,
    institution: 'chase',
    sourceKind: 'teller', // = live bank feed (plaid ids in the teller_* columns)
    type: 'depository',
    tellerAccountId: `acc-${name}`,
    tellerEnrollmentId: itemId,
    feedEnv,
  })
}

const RAN_AT = '2026-07-06T00:00:00.000Z'

describe('syncPlaidProvider — env scoping', () => {
  it('mixed envs: syncs only current-env accounts; cross-env accounts get no entries, no errors, no sync_log rows', async () => {
    const w = syncWorld()
    await w.secrets.set(plaidSecretKey('sandbox'), 'secret-1')
    await w.secrets.set(plaidAccessTokenKey('sandbox', 'item-sbx'), 'token-sbx')
    await w.secrets.set(plaidAccessTokenKey('production', 'item-prod'), 'token-prod')
    const sbx = addFeedAccount(w.repo, 'Plaid Checking', 'item-sbx', 'sandbox')
    const prod = addFeedAccount(w.repo, 'Real Chase', 'item-prod', 'production')

    const entries = await syncPlaidProvider(w.deps, settingsFor('sandbox'), RAN_AT)
    expect(entries.map((e) => e.accountId)).toEqual([sbx.id])
    expect(entries[0]!.error).toBeNull()
    expect(w.synced).toEqual(['token-sbx'])
    // the cross-env account is untouched: no error flag, no log spam
    expect(w.repo.getAccount(prod.id)?.status).toBe('ok')
    const logs = w.db.prepare('SELECT account_id FROM sync_log').all() as Array<{
      account_id: string
    }>
    expect(logs).toEqual([{ account_id: sbx.id }])
  })

  it('flipping plaidEnv to production syncs the production account instead', async () => {
    const w = syncWorld()
    await w.secrets.set(plaidSecretKey('production'), 'secret-prod')
    await w.secrets.set(plaidAccessTokenKey('sandbox', 'item-sbx'), 'token-sbx')
    await w.secrets.set(plaidAccessTokenKey('production', 'item-prod'), 'token-prod')
    addFeedAccount(w.repo, 'Plaid Checking', 'item-sbx', 'sandbox')
    const prod = addFeedAccount(w.repo, 'Real Chase', 'item-prod', 'production')

    const entries = await syncPlaidProvider(w.deps, settingsFor('production'), RAN_AT)
    expect(entries.map((e) => e.accountId)).toEqual([prod.id])
    expect(entries[0]!.error).toBeNull()
    expect(w.synced).toEqual(['token-prod'])
  })

  it('NULL feed_env: resolved from the env holding the item token, persisted, synced when it matches', async () => {
    const w = syncWorld()
    await w.secrets.set(plaidSecretKey('sandbox'), 'secret-1')
    await w.secrets.set(plaidAccessTokenKey('sandbox', 'item-legacy'), 'token-legacy')
    const legacy = addFeedAccount(w.repo, 'Legacy Checking', 'item-legacy', null)

    const entries = await syncPlaidProvider(w.deps, settingsFor('sandbox'), RAN_AT)
    expect(entries.map((e) => e.accountId)).toEqual([legacy.id])
    expect(entries[0]!.error).toBeNull()
    expect(w.repo.getAccount(legacy.id)?.feedEnv).toBe('sandbox')
  })

  it('NULL feed_env cross-env: resolved env persisted, account skipped with no error entry', async () => {
    const w = syncWorld()
    await w.secrets.set(plaidSecretKey('production'), 'secret-prod')
    await w.secrets.set(plaidAccessTokenKey('sandbox', 'item-legacy'), 'token-legacy')
    const legacy = addFeedAccount(w.repo, 'Legacy Checking', 'item-legacy', null)

    const entries = await syncPlaidProvider(w.deps, settingsFor('production'), RAN_AT)
    expect(entries).toEqual([])
    expect(w.synced).toEqual([])
    expect(w.repo.getAccount(legacy.id)?.feedEnv).toBe('sandbox')
    expect(w.repo.getAccount(legacy.id)?.status).toBe('ok')
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM sync_log').get()).toEqual({ n: 0 })
  })

  it('NULL feed_env with tokens in BOTH envs prefers the current env', async () => {
    const w = syncWorld()
    await w.secrets.set(plaidSecretKey('production'), 'secret-prod')
    await w.secrets.set(plaidAccessTokenKey('sandbox', 'item-both'), 'token-sbx')
    await w.secrets.set(plaidAccessTokenKey('production', 'item-both'), 'token-prod')
    const both = addFeedAccount(w.repo, 'Ambiguous', 'item-both', null)

    const entries = await syncPlaidProvider(w.deps, settingsFor('production'), RAN_AT)
    expect(entries.map((e) => e.accountId)).toEqual([both.id])
    expect(w.synced).toEqual(['token-prod'])
    expect(w.repo.getAccount(both.id)?.feedEnv).toBe('production')
  })

  it('NULL feed_env with no token anywhere: one clear error entry, account flagged error, sync_log row', async () => {
    const w = syncWorld()
    const orphan = addFeedAccount(w.repo, 'Orphan', 'item-orphan', null)

    const entries = await syncPlaidProvider(w.deps, settingsFor('sandbox'), RAN_AT)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.accountId).toBe(orphan.id)
    expect(entries[0]!.error).toMatch(/no Plaid access token/)
    expect(entries[0]!.error).toMatch(/any environment/)
    expect(w.synced).toEqual([])
    expect(w.repo.getAccount(orphan.id)?.status).toBe('error')
    const logs = w.db.prepare('SELECT account_id, errors FROM sync_log').all() as Array<{
      account_id: string
      errors: string | null
    }>
    expect(logs).toHaveLength(1)
    expect(logs[0]!.errors).toMatch(/no Plaid access token/)
  })
})
