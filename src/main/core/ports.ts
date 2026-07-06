import type { CategorySource, IsoDate, Source, TxnDraft, TxnStatus } from '../../shared/types'

/**
 * Frozen ports between core modules. Implementations live in db/ (repository)
 * and platform/ (electron). Core modules depend on these interfaces only.
 */

/** persisted transaction as the reconciler sees it */
export interface ExistingTxn {
  id: string
  accountId: string
  source: Source
  externalId: string | null
  importHash: string
  txnDate: IsoDate
  postDate: IsoDate | null
  amountCents: number
  status: TxnStatus
  normalizedPayee: string
  categorySource: CategorySource | null
}

export type ReconcileDecision =
  | { kind: 'insert'; draft: TxnDraft }
  | {
      kind: 'match'
      existingId: string
      draft: TxnDraft
      /** fields the existing row should take from the draft (date precedence etc.) */
      updates: {
        txnDate?: IsoDate
        postDate?: IsoDate
        status?: TxnStatus
        linkedSourceId?: string
        externalId?: string
      }
    }
  | { kind: 'skip_duplicate'; draft: TxnDraft; existingId: string }

export interface ReconcileOutcome {
  decisions: ReconcileDecision[]
  inserted: number
  matched: number
  skipped: number
}

/** repository port used by SyncEngine and CSV import pipeline */
export interface TxnRepoPort {
  /** existing rows for an account with post/txn date >= fromDate (or all if null) */
  listExisting(accountId: string, fromDate: IsoDate | null): ExistingTxn[]
  listPending(accountId: string): ExistingTxn[]
  applyDecisions(accountId: string, outcome: ReconcileOutcome): void
  /** tombstone stale pendings; carry user edits when replacementId given */
  gcPending(ids: Array<{ id: string; replacementId?: string }>): void
  knownExternalIds(accountId: string, source: Source): Set<string>
}

export interface SecretStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface Clock {
  todayIso(): IsoDate
  nowMs(): number
}

/** transport abstraction so TellerClient is testable without TLS */
export interface HttpTransport {
  request(input: {
    method: 'GET' | 'DELETE'
    url: string
    /** HTTP Basic username (Teller access token), empty password */
    basicUser?: string
    query?: Record<string, string | number | undefined>
  }): Promise<{ status: number; body: unknown }>
}

/** categorizer's view of the merchant cache */
export interface MerchantCachePort {
  get(normalizedMerchant: string): { categoryId: string; locked: boolean } | null
  set(entry: {
    normalizedMerchant: string
    categoryId: string
    source: 'rule' | 'chase' | 'amex' | 'teller' | 'llm' | 'user'
    confidence: number | null
    locked: boolean
  }): void
}

/** minimal LLM port (implemented by OllamaClient) */
export interface CategorizerLlmPort {
  categorizeMerchants(
    merchants: string[],
    fewShot: Array<{ merchant: string; category: string }>,
  ): Promise<Array<{ merchant: string; category: string; confidence: number }>>
}
