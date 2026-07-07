import type { AccountDto, PlaidEnv, SettingsDto, SyncReport, TxnDraft } from '../../shared/types'
import { normalizePayee } from '../core/categorize/normalizer'
import {
  draftsForAccount,
  PlaidSyncEngine,
  type PlaidItemSyncResult,
} from '../core/plaid/sync'
import type { PlaidSyncResponse } from '../core/plaid/types'
import type { SecretStore } from '../core/ports'
import { reconcile } from '../core/reconcile/reconciler'
import type { SqliteRepo } from '../db/repository'
import {
  makeConfiguredPlaidClient,
  plaidAccessTokenKey,
  plaidCursorKey,
  type MakePlaidClient,
} from './plaidFlow'

/**
 * Plaid provider sync — the plaid branch of AppService.syncNow. Groups the
 * feed accounts by Item (Plaid's /transactions/sync cursor is per Item, and
 * one Item can hold several accounts), runs the PlaidSyncEngine per Item, and
 * reports per-account entries in the same SyncReport shape as the Teller
 * path. Cursors live in the settings table (plaidCursorKey).
 *
 * ENV SCOPING: an Item only ever works in the Plaid environment it was
 * enrolled in — syncing a sandbox Item against production keys is a
 * guaranteed INVALID_API_KEYS error. Only accounts whose feed_env matches
 * the active Settings.plaidEnv enter the sync loop; cross-env accounts are
 * excluded WITHOUT error entries (they are healthy, just enrolled elsewhere)
 * and the Accounts screen badges them instead — never a silent skip. Legacy
 * NULL-feed_env accounts are backfilled from the per-env access-token keys.
 */

export interface PlaidSyncDeps {
  repo: SqliteRepo
  secrets: SecretStore
  makePlaidClient: MakePlaidClient
  /** AppService.categorizeDrafts seam — returns the uncategorized-left count */
  categorize: (account: AccountDto, drafts: readonly TxnDraft[]) => Promise<number>
}

type SyncEntry = SyncReport['accounts'][number]

export async function syncPlaidProvider(
  deps: PlaidSyncDeps,
  settings: SettingsDto,
  ranAt: string,
): Promise<SyncEntry[]> {
  const feedAccounts = deps.repo
    .listAccounts()
    .filter(
      (a) =>
        a.sourceKind === 'teller' && // reuse: 'teller' = live bank feed (plaidFlow.ts)
        a.tellerAccountId !== null &&
        a.tellerEnrollmentId !== null &&
        !a.closed,
    )
  const entries: SyncEntry[] = []
  const byItem = new Map<string, AccountDto[]>()
  for (const account of feedAccounts) {
    const itemId = account.tellerEnrollmentId as string // holds the PLAID item_id
    const feedEnv =
      account.feedEnv ?? (await backfillFeedEnv(deps, account.id, itemId, settings.plaidEnv))
    if (feedEnv === null) {
      // enrolled env unknown AND no token in any env — surface it, never guess
      const entry = noTokenEntry(account.id, itemId)
      flagAccountError(deps.repo, account.id)
      deps.repo.insertSyncLog({
        ranAt,
        source: 'plaid',
        accountId: entry.accountId,
        fetched: 0,
        inserted: 0,
        matched: 0,
        gcPending: 0,
        errors: entry.error,
      })
      entries.push(entry)
      continue
    }
    // cross-env Items can never sync here (INVALID_API_KEYS): excluded from
    // the loop, badged on the Accounts screen via AccountDto.feedEnv
    if (feedEnv !== settings.plaidEnv) continue
    byItem.set(itemId, [...(byItem.get(itemId) ?? []), account])
  }

  for (const [itemId, accounts] of byItem) {
    entries.push(...(await syncItem(deps, settings, ranAt, itemId, accounts)))
  }
  return entries
}

/**
 * Resolve a legacy NULL-feed_env account by which env holds its Item's
 * access token and persist the answer. The current env is checked first so
 * an Item that (improbably) has tokens in both keeps syncing where it is.
 * Returns null when no env holds a token — the caller surfaces that loudly.
 */
async function backfillFeedEnv(
  deps: PlaidSyncDeps,
  accountId: string,
  itemId: string,
  currentEnv: PlaidEnv,
): Promise<PlaidEnv | null> {
  const other: PlaidEnv = currentEnv === 'sandbox' ? 'production' : 'sandbox'
  for (const env of [currentEnv, other]) {
    if ((await deps.secrets.get(plaidAccessTokenKey(env, itemId))) !== null) {
      deps.repo.setAccountFeedEnv(accountId, env)
      return env
    }
  }
  return null
}

function noTokenEntry(accountId: string, itemId: string): SyncEntry {
  return {
    accountId,
    fetched: 0,
    inserted: 0,
    matched: 0,
    gcPending: 0,
    uncategorized: 0,
    warning: null,
    error:
      `no Plaid access token stored for item ${itemId} in any environment — ` +
      'reconnect this account',
  }
}

async function syncItem(
  deps: PlaidSyncDeps,
  settings: SettingsDto,
  ranAt: string,
  itemId: string,
  accounts: AccountDto[],
): Promise<SyncEntry[]> {
  const { repo } = deps
  const accountById = new Map(accounts.map((a) => [a.id, a]))
  let entries: SyncEntry[]
  try {
    const accessToken = await deps.secrets.get(plaidAccessTokenKey(settings.plaidEnv, itemId))
    if (accessToken === null) {
      throw new Error(`no Plaid access token stored for item ${itemId}`)
    }
    const client = await makeConfiguredPlaidClient(deps, settings)
    // log every page so categorization can revisit exactly what was fetched
    const responses: PlaidSyncResponse[] = []
    const engine = new PlaidSyncEngine({
      client: {
        transactionsSync: async (token, cursor) => {
          const page = await client.transactionsSync(token, cursor)
          responses.push(page)
          return page
        },
      },
      repo,
      reconcile: (incoming, existing) =>
        reconcile([...incoming], [...existing], { normalize: normalizePayee }),
      cursors: {
        get: (id) => repo.getSetting<string>(plaidCursorKey(id)),
        set: (id, cursor) => repo.setSetting(plaidCursorKey(id), cursor),
      },
    })
    const result = await engine.syncItem({
      itemId,
      accessToken,
      accounts: accounts.map((a) => ({ id: a.id, plaidAccountId: a.tellerAccountId as string })),
    })
    entries = await finishItem(deps, ranAt, result, accountById, responses)
  } catch (err) {
    // a silently-green badge over a failing sync hides staleness for months —
    // flag every account of the item so the Accounts screen shows the danger
    entries = accounts.map((account) => {
      flagAccountError(repo, account.id)
      return {
        accountId: account.id,
        fetched: 0,
        inserted: 0,
        matched: 0,
        gcPending: 0,
        uncategorized: 0,
        warning: null,
        error: err instanceof Error ? err.message : String(err),
      }
    })
  }
  for (const entry of entries) {
    repo.insertSyncLog({
      ranAt,
      source: 'plaid',
      accountId: entry.accountId,
      fetched: entry.fetched,
      inserted: entry.inserted,
      matched: entry.matched,
      gcPending: entry.gcPending,
      errors: entry.error,
    })
  }
  return entries
}

async function finishItem(
  deps: PlaidSyncDeps,
  ranAt: string,
  result: PlaidItemSyncResult,
  accountById: ReadonlyMap<string, AccountDto>,
  responses: readonly PlaidSyncResponse[],
): Promise<SyncEntry[]> {
  const { repo } = deps
  const entries: SyncEntry[] = []
  for (const accountResult of result.accounts) {
    const account = accountById.get(accountResult.accountId)
    if (account === undefined) {
      throw new Error(`plaid sync: engine returned unknown account ${accountResult.accountId}`)
    }
    let uncategorized = 0
    let error = accountResult.error
    try {
      if (result.error === 'reconnect_required') {
        repo.updateAccountStatus(account.id, 'reconnect_required')
      } else {
        const drafts = draftsForAccount(responses, account.tellerAccountId as string)
        uncategorized = await deps.categorize(account, drafts)
        // only a FULLY successful run (categorization included) is 'ok'
        repo.markSynced(account.id, ranAt)
      }
    } catch (err) {
      // a categorization-phase throw must keep the REAL engine counts —
      // the rows were fetched and persisted, only the labeling failed
      flagAccountError(repo, account.id)
      error = err instanceof Error ? err.message : String(err)
    }
    entries.push({ ...accountResult, accountId: account.id, uncategorized, error })
  }
  return entries
}

/** best-effort: never let status bookkeeping mask the original sync error */
function flagAccountError(repo: SqliteRepo, accountId: string): void {
  try {
    repo.updateAccountStatus(accountId, 'error')
  } catch (statusErr) {
    console.error(`[whats-left] could not flag account ${accountId} as error:`, statusErr)
  }
}
