import { randomUUID } from 'node:crypto'
import type { AccountDto, AccountStatus, AccountType, Institution } from '../../shared/types'
import type { Db } from './db'
import { mapAccount, type AccountRow } from './rows'

export interface CreateAccountInput {
  name: string
  institution: Institution
  sourceKind: 'teller' | 'csv_only'
  type: AccountType
  mask?: string | null
  subtype?: string | null
  tellerAccountId?: string | null
  tellerEnrollmentId?: string | null
}

const INSTITUTIONS: readonly Institution[] = ['chase', 'amex', 'other']
const ACCOUNT_TYPES: readonly AccountType[] = ['depository', 'credit']
const ACCOUNT_STATUSES: readonly AccountStatus[] = ['ok', 'reconnect_required', 'error']

function accountRow(db: Db, id: string): AccountRow | null {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined
  return row ?? null
}

export function createAccount(db: Db, input: CreateAccountInput): AccountDto {
  if (input.name.trim() === '') throw new Error('createAccount: name must not be empty')
  if (!INSTITUTIONS.includes(input.institution)) {
    throw new Error(`createAccount: invalid institution ${JSON.stringify(input.institution)}`)
  }
  if (!ACCOUNT_TYPES.includes(input.type)) {
    throw new Error(`createAccount: invalid account type ${JSON.stringify(input.type)}`)
  }
  const id = randomUUID()
  db.prepare(
    `INSERT INTO accounts
       (id, name, institution, source_kind, type, mask, subtype, teller_account_id, teller_enrollment_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.institution,
    input.sourceKind,
    input.type,
    input.mask ?? null,
    input.subtype ?? null,
    input.tellerAccountId ?? null,
    input.tellerEnrollmentId ?? null,
  )
  const created = getAccount(db, id)
  if (!created) throw new Error(`createAccount: row vanished after insert (${id})`)
  return created
}

export function listAccounts(db: Db): AccountDto[] {
  const rows = db
    .prepare('SELECT * FROM accounts WHERE tombstone = 0 ORDER BY name ASC, id ASC')
    .all() as AccountRow[]
  return rows.map(mapAccount)
}

export function getAccount(db: Db, id: string): AccountDto | null {
  const row = accountRow(db, id)
  return row && row.tombstone === 0 ? mapAccount(row) : null
}

export function updateAccountStatus(db: Db, id: string, status: AccountStatus): void {
  if (!ACCOUNT_STATUSES.includes(status)) {
    throw new Error(`updateAccountStatus: invalid status ${JSON.stringify(status)}`)
  }
  const info = db
    .prepare('UPDATE accounts SET status = ? WHERE id = ? AND tombstone = 0')
    .run(status, id)
  if (info.changes === 0) throw new Error(`updateAccountStatus: unknown account ${id}`)
}

/** successful sync: back to 'ok' and stamp last_sync_at (Accounts screen renders it) */
export function markSynced(db: Db, id: string, lastSyncAt: string): void {
  const info = db
    .prepare(`UPDATE accounts SET status = 'ok', last_sync_at = ? WHERE id = ? AND tombstone = 0`)
    .run(lastSyncAt, id)
  if (info.changes === 0) throw new Error(`markSynced: unknown account ${id}`)
}

/**
 * Rewrite csv_only history onto the linked Teller account and tombstone the
 * csv account. Returns the number of moved rows; SqliteRepo.linkCsvHistory
 * wraps this with the reconcile pass over the merged account (plan §5b).
 */
export function linkCsvHistory(db: Db, csvAccountId: string, tellerAccountId: string): number {
  const run = db.transaction((): number => {
    const csv = accountRow(db, csvAccountId)
    if (!csv || csv.tombstone !== 0) {
      throw new Error(`linkCsvHistory: unknown csv account ${csvAccountId}`)
    }
    if (csv.source_kind !== 'csv_only') {
      throw new Error(`linkCsvHistory: account ${csvAccountId} is not csv_only`)
    }
    const teller = accountRow(db, tellerAccountId)
    if (!teller || teller.tombstone !== 0) {
      throw new Error(`linkCsvHistory: unknown target account ${tellerAccountId}`)
    }
    const info = db
      .prepare('UPDATE transactions SET account_id = ? WHERE account_id = ?')
      .run(tellerAccountId, csvAccountId)
    db.prepare('UPDATE accounts SET tombstone = 1 WHERE id = ?').run(csvAccountId)
    return info.changes
  })
  return run()
}
