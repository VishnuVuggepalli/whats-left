import type {
  AccountDto,
  EnrollmentResult,
  Institution,
  PlaidEnv,
  SettingsDto,
} from '../../shared/types'
import type { PlaidAccountsGetResponse, PlaidSyncResponse } from '../core/plaid/types'
import type { SecretStore } from '../core/ports'
import type { SqliteRepo } from '../db/repository'
import type { PlaidLinkServerHandle, PlaidLinkServerOpts } from '../platform/plaidLinkServer'

/**
 * Plaid enrollment flow (the Plaid twin of enrollmentFlow.ts): create a Link
 * token, serve Plaid Link on the hardened loopback server, open the system
 * browser, exchange the public token, persist the access token per Item, and
 * upsert the Item's accounts.
 *
 * Update mode (existing account) repairs the Item's login via a link token
 * created WITH the Item's access_token — this NEVER creates a new Item, which
 * protects the lifetime 10-Item cap on Plaid's Trial plan. Only brand-new
 * exchanges call recordNewItem.
 */

/** stable client_user_id for the (single) local user */
export const PLAID_CLIENT_USER_ID = 'whats-left-local-user'

/** SecretStore key for the write-only Plaid secret, per environment */
export const plaidSecretKey = (env: PlaidEnv): string => `plaid:secret:${env}`

/** SecretStore key for an Item's access token, per environment */
export const plaidAccessTokenKey = (env: PlaidEnv, itemId: string): string =>
  `plaid:accessToken:${env}:${itemId}`

/** settings-table key for an Item's /transactions/sync cursor */
export const plaidCursorKey = (itemId: string): string => `plaid_cursor_${itemId}`

/** the PlaidClient slice the app needs (constructed per settings/credentials) */
export interface PlaidClientPort {
  createLinkToken(opts: { clientUserId: string; updateAccessToken?: string }): Promise<string>
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>
  transactionsSync(accessToken: string, cursor?: string): Promise<PlaidSyncResponse>
  getAccounts(accessToken: string): Promise<PlaidAccountsGetResponse>
}

export interface PlaidClientConfig {
  env: PlaidEnv
  clientId: string
  secret: string
}

export type MakePlaidClient = (cfg: PlaidClientConfig) => PlaidClientPort

export interface PlaidFlowDeps {
  repo: SqliteRepo
  secrets: SecretStore
  makePlaidClient: MakePlaidClient
  startPlaidLinkServer: (opts: PlaidLinkServerOpts) => Promise<PlaidLinkServerHandle>
  openExternal: (url: string) => Promise<void>
}

export interface RunPlaidEnrollmentInput {
  settings: SettingsDto
  /** update mode: repair this account's Item (never burns Item quota) */
  existing?: AccountDto
  /** invoked exactly once when a NEW Item was created (lifetime 10-Item counter) */
  recordNewItem: () => Promise<void>
}

/** Plaid institution metadata → our institution enum ('other' is first-class) */
export function mapPlaidInstitution(
  name: string | null | undefined,
  institutionId?: string | null,
): Institution {
  const haystack = `${name ?? ''} ${institutionId ?? ''}`.toLowerCase()
  if (haystack.includes('chase')) return 'chase'
  if (haystack.includes('american express') || haystack.includes('amex')) return 'amex'
  return 'other'
}

export async function makeConfiguredPlaidClient(
  deps: Pick<PlaidFlowDeps, 'secrets' | 'makePlaidClient'>,
  settings: SettingsDto,
): Promise<PlaidClientPort> {
  const clientId = settings.plaidClientId
  if (clientId === null || clientId.trim() === '') {
    throw new Error('Plaid client_id is not configured (Settings → Plaid)')
  }
  const secret = await deps.secrets.get(plaidSecretKey(settings.plaidEnv))
  if (secret === null) {
    throw new Error('Plaid secret is not configured (Settings → Plaid)')
  }
  return deps.makePlaidClient({ env: settings.plaidEnv, clientId, secret })
}

export async function runPlaidEnrollment(
  deps: PlaidFlowDeps,
  input: RunPlaidEnrollmentInput,
): Promise<EnrollmentResult> {
  const { settings, existing } = input
  const client = await makeConfiguredPlaidClient(deps, settings)

  if (existing !== undefined) {
    // UPDATE MODE — repair the existing Item; the access token is unchanged
    // and NO exchange happens, so the lifetime Item count never moves.
    const itemId = existing.tellerEnrollmentId // holds the Plaid item_id (column reuse, see upsert)
    if (itemId === null) {
      throw new Error(`reconnect: account ${existing.id} has no Plaid item linkage`)
    }
    const accessToken = await deps.secrets.get(plaidAccessTokenKey(settings.plaidEnv, itemId))
    if (accessToken === null) {
      throw new Error(`no Plaid access token stored for item ${itemId}`)
    }
    const linkToken = await client.createLinkToken({
      clientUserId: PLAID_CLIENT_USER_ID,
      updateAccessToken: accessToken,
    })
    await runLinkServer(deps, linkToken)
    return {
      ok: true,
      enrollmentId: itemId,
      institution: existing.institution,
      accountsAdded: 0,
    }
  }

  // CREATE MODE — a successful exchange mints a new Item (counts against the cap)
  const linkToken = await client.createLinkToken({ clientUserId: PLAID_CLIENT_USER_ID })
  const payload = await runLinkServer(deps, linkToken)
  const { accessToken, itemId } = await client.exchangePublicToken(payload.publicToken)
  await deps.secrets.set(plaidAccessTokenKey(settings.plaidEnv, itemId), accessToken)
  await input.recordNewItem()

  const institution = mapPlaidInstitution(payload.institutionName, payload.institutionId)
  const remote = await client.getAccounts(accessToken)
  const accountsAdded = upsertPlaidAccounts(deps.repo, remote, institution)
  return {
    ok: true,
    enrollmentId: itemId,
    institution: payload.institutionName ?? undefined,
    accountsAdded,
  }
}

async function runLinkServer(
  deps: PlaidFlowDeps,
  linkToken: string,
): Promise<{ publicToken: string; institutionName: string | null; institutionId: string | null }> {
  const handle = await deps.startPlaidLinkServer({ linkToken })
  try {
    await deps.openExternal(handle.url)
  } catch (err) {
    handle.close()
    throw err
  }
  return handle.result
}

/**
 * Upsert the Item's depository/credit accounts. COLUMN REUSE (deliberate, no
 * migration): teller_account_id holds the PLAID account_id and
 * teller_enrollment_id holds the PLAID item_id — the columns mean "bank-feed
 * account id" / "bank-feed connection id"; source_kind 'teller' likewise
 * means "live bank feed" (vs csv_only). Other account types (loan,
 * investment) are skipped — v1 tracks spending accounts only.
 */
function upsertPlaidAccounts(
  repo: SqliteRepo,
  remote: PlaidAccountsGetResponse,
  institution: Institution,
): number {
  const known = new Set(
    repo
      .listAccounts()
      .map((a) => a.tellerAccountId)
      .filter((id): id is string => id !== null),
  )
  let added = 0
  for (const account of remote.accounts) {
    if (known.has(account.account_id)) continue
    if (account.type !== 'depository' && account.type !== 'credit') continue
    repo.createAccount({
      name: account.name,
      institution,
      sourceKind: 'teller', // reuse: 'teller' = live bank feed (see comment above)
      type: account.type,
      mask: account.mask,
      subtype: account.subtype,
      tellerAccountId: account.account_id, // holds the PLAID account_id
      tellerEnrollmentId: remote.item.item_id, // holds the PLAID item_id
    })
    added += 1
  }
  return added
}
