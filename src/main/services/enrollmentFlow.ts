import type { AccountDto, EnrollmentResult, Institution, SettingsDto } from '../../shared/types'
import type { SecretStore } from '../core/ports'
import type { TellerAccount, TellerTransaction } from '../core/teller/types'
import type { SqliteRepo } from '../db/repository'
import type { EnrollmentServerHandle, EnrollmentServerOpts } from '../platform/enrollmentServer'

/**
 * Teller enrollment flow (plan §3): loopback server + system browser +
 * Connect, then token persistence and account upsert. Update mode (existing
 * account with an enrollmentId) repairs the enrollment WITHOUT burning
 * lifetime dev-environment quota — only brand-new enrollments call
 * recordNewEnrollment.
 */

export const accessTokenKey = (enrollmentId: string): string =>
  `teller:accessToken:${enrollmentId}`

/** the TellerClient slice the app needs (constructed per access token) */
export interface TellerClientPort {
  listAccounts(): Promise<TellerAccount[]>
  listTransactions(
    accountId: string,
    opts?: { count?: number; fromId?: string },
  ): Promise<TellerTransaction[]>
}

export interface EnrollmentFlowDeps {
  repo: SqliteRepo
  secrets: SecretStore
  makeTellerClient: (accessToken: string) => TellerClientPort
  startEnrollmentServer: (opts: EnrollmentServerOpts) => Promise<EnrollmentServerHandle>
  openExternal: (url: string) => Promise<void>
  getApplicationId: () => Promise<string>
}

export interface RunEnrollmentInput {
  settings: SettingsDto
  institution?: Institution
  /** update mode: repair this account's enrollment (plan quota rule) */
  existing?: AccountDto
  /** invoked exactly once when a NEW enrollment was created (quota counter) */
  recordNewEnrollment: () => Promise<void>
}

export async function runEnrollment(
  deps: EnrollmentFlowDeps,
  input: RunEnrollmentInput,
): Promise<EnrollmentResult> {
  const applicationId = await deps.getApplicationId()
  const updateEnrollmentId = input.existing?.tellerEnrollmentId ?? undefined
  const handle = await deps.startEnrollmentServer({
    applicationId,
    environment: input.settings.tellerEnv,
    enrollmentId: updateEnrollmentId,
    institution: input.institution ?? input.existing?.institution,
  })
  try {
    await deps.openExternal(handle.url)
  } catch (err) {
    handle.close()
    throw err
  }
  const payload = await handle.result

  await deps.secrets.set(accessTokenKey(payload.enrollmentId), payload.accessToken)
  if (updateEnrollmentId !== undefined && updateEnrollmentId !== payload.enrollmentId) {
    // keep the lookup key the accounts table points at working too
    await deps.secrets.set(accessTokenKey(updateEnrollmentId), payload.accessToken)
  }
  if (updateEnrollmentId === undefined) {
    await input.recordNewEnrollment()
  }
  const accountsAdded = await upsertTellerAccounts(deps, payload.accessToken, payload.enrollmentId)
  return {
    ok: true,
    enrollmentId: payload.enrollmentId,
    institution: payload.institutionName ?? undefined,
    accountsAdded,
  }
}

async function upsertTellerAccounts(
  deps: EnrollmentFlowDeps,
  accessToken: string,
  enrollmentId: string,
): Promise<number> {
  const client = deps.makeTellerClient(accessToken)
  const remote = (await client.listAccounts()).filter((a) => a.enrollment_id === enrollmentId)
  const known = new Set(
    deps.repo
      .listAccounts()
      .map((a) => a.tellerAccountId)
      .filter((id): id is string => id !== null),
  )
  let added = 0
  for (const account of remote) {
    if (known.has(account.id)) continue
    const institution = account.institution.id
    if (institution !== 'chase' && institution !== 'amex') {
      throw new Error(`enrollment returned unsupported institution ${JSON.stringify(institution)}`)
    }
    deps.repo.createAccount({
      name: account.name,
      institution,
      sourceKind: 'teller',
      type: account.type,
      mask: account.last_four,
      subtype: account.subtype,
      tellerAccountId: account.id,
      tellerEnrollmentId: account.enrollment_id,
    })
    added += 1
  }
  return added
}
