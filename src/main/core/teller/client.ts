import type { z } from 'zod'
import type { HttpTransport } from '../ports'
import type { TellerAccount, TellerBalances, TellerTransaction } from './types'
import {
  tellerAccountsSchema,
  tellerBalancesSchema,
  tellerErrorSchema,
  tellerTransactionsSchema,
} from './types'

/**
 * TellerClient — typed, validated access to the Teller API over an injected
 * HttpTransport (plan §3/§5a). All responses are zod-validated at the boundary;
 * 429/5xx are retried with exponential backoff; enrollment-inactive semantics
 * surface as a dedicated error so the SyncEngine can flag reconnect_required.
 */

const DEFAULT_BASE_URL = 'https://api.teller.io'
const MAX_ATTEMPTS = 3
const BACKOFF_BASE_MS = 500

/** 429 rate limit persisted through all retry attempts. Safe to retry later. */
export class RateLimitError extends Error {
  readonly retriable = true
  constructor(message: string) {
    super(message)
    this.name = 'RateLimitError'
  }
}

/** The enrollment is disconnected/revoked — user must reconnect via Connect update mode. */
export class EnrollmentInactiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnrollmentInactiveError'
  }
}

/** Any other non-2xx Teller response (no retry, or retries exhausted for 5xx). */
export class TellerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message)
    this.name = 'TellerApiError'
  }
}

/** A 2xx body that failed schema validation — never retried, always surfaced. */
export class TellerValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TellerValidationError'
  }
}

export type SleepFn = (ms: number) => Promise<void>

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export interface TellerClientOptions {
  transport: HttpTransport
  /** Teller access token — sent as HTTP Basic user, empty password */
  accessToken: string
  baseUrl?: string
  /** injectable for tests; production default is setTimeout */
  sleep?: SleepFn
}

export interface ListTransactionsOpts {
  count?: number
  /** cursor: page backward from (exclusive) this transaction id */
  fromId?: string
}

type Query = Record<string, string | number | undefined>

export class TellerClient {
  private readonly transport: HttpTransport
  private readonly accessToken: string
  private readonly baseUrl: string
  private readonly sleep: SleepFn

  constructor(opts: TellerClientOptions) {
    if (opts.accessToken.trim() === '') {
      throw new Error('TellerClient: accessToken must be a non-empty string')
    }
    this.transport = opts.transport
    this.accessToken = opts.accessToken
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.sleep = opts.sleep ?? defaultSleep
  }

  async listAccounts(): Promise<TellerAccount[]> {
    return this.requestValidated('/accounts', undefined, tellerAccountsSchema, 'GET /accounts')
  }

  async listTransactions(
    accountId: string,
    opts: ListTransactionsOpts = {},
  ): Promise<TellerTransaction[]> {
    const path = `/accounts/${encodeURIComponent(accountId)}/transactions`
    const query: Query = {
      ...(opts.count !== undefined ? { count: opts.count } : {}),
      ...(opts.fromId !== undefined ? { from_id: opts.fromId } : {}),
    }
    return this.requestValidated(path, query, tellerTransactionsSchema, `GET ${path}`)
  }

  async getBalances(accountId: string): Promise<TellerBalances> {
    const path = `/accounts/${encodeURIComponent(accountId)}/balances`
    return this.requestValidated(path, undefined, tellerBalancesSchema, `GET ${path}`)
  }

  private async requestValidated<T>(
    path: string,
    query: Query | undefined,
    schema: z.ZodType<T>,
    context: string,
  ): Promise<T> {
    const body = await this.requestJson(path, query, context)
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      throw new TellerValidationError(
        `Teller ${context}: response failed schema validation: ${parsed.error.message}`,
      )
    }
    return parsed.data
  }

  /**
   * One HTTP exchange with retry. Retries (exponential backoff) apply ONLY to
   * 429 and 5xx; enrollment-inactive and other 4xx fail immediately.
   */
  private async requestJson(path: string, query: Query | undefined, context: string): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.transport.request({
        method: 'GET',
        url: this.baseUrl + path,
        basicUser: this.accessToken,
        query,
      })
      if (res.status >= 200 && res.status < 300) return res.body

      const code = extractErrorCode(res.body)
      const enrollmentInactive = res.status === 401 || (code !== null && code.startsWith('enrollment.'))
      if (enrollmentInactive) {
        throw new EnrollmentInactiveError(
          `Teller ${context}: enrollment inactive (HTTP ${res.status}${code ? `, ${code}` : ''}) — reconnect required`,
        )
      }

      const retriable = res.status === 429 || res.status >= 500
      if (retriable && attempt < MAX_ATTEMPTS) {
        await this.sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1))
        continue
      }
      if (res.status === 429) {
        throw new RateLimitError(`Teller ${context}: rate limited after ${attempt} attempts`)
      }
      throw new TellerApiError(
        res.status,
        code,
        `Teller ${context}: HTTP ${res.status}${code ? ` (${code})` : ''} after ${attempt} attempt(s)`,
      )
    }
  }
}

function extractErrorCode(body: unknown): string | null {
  const parsed = tellerErrorSchema.safeParse(body)
  return parsed.success ? parsed.data.error.code : null
}
