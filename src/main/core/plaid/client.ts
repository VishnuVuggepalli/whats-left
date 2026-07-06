import type { z } from 'zod'
import type { PlaidEnv } from '../../../shared/types'
import type { PlaidAccountsGetResponse, PlaidSyncResponse } from './types'
import {
  plaidAccountsGetResponseSchema,
  plaidErrorSchema,
  plaidExchangeResponseSchema,
  plaidLinkTokenResponseSchema,
  plaidSyncResponseSchema,
} from './types'

/**
 * PlaidClient — typed, validated access to the Plaid API.
 *
 * Plaid is all POST-with-JSON-body (auth = client_id + secret as body fields),
 * which the frozen GET/DELETE-shaped HttpTransport port cannot express — so
 * this module owns its own minimal PlaidTransport port (real impl:
 * transport.ts). All responses are zod-validated at the boundary; 429/5xx are
 * retried with exponential backoff; ITEM_LOGIN_REQUIRED surfaces as a
 * dedicated error so the sync engine can flag reconnect_required.
 *
 * The client_id/secret pair is injected at construction and NEVER logged or
 * embedded in error messages.
 */

/** POST-shaped transport for Plaid (the frozen HttpTransport is GET/DELETE-only) */
export interface PlaidTransport {
  post(url: string, body: unknown): Promise<{ status: number; body: unknown }>
}

export const PLAID_BASE_URLS: Readonly<Record<PlaidEnv, string>> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
}

const MAX_ATTEMPTS = 3
const BACKOFF_BASE_MS = 500
const SYNC_PAGE_COUNT = 100

/** 429/RATE_LIMIT_EXCEEDED persisted through all retry attempts. Safe to retry later. */
export class PlaidRateLimitError extends Error {
  readonly retriable = true
  constructor(message: string) {
    super(message)
    this.name = 'PlaidRateLimitError'
  }
}

/** The Item needs a user re-login — reconnect via Link update mode. */
export class ItemLoginRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ItemLoginRequiredError'
  }
}

/** Any other non-2xx Plaid response (no retry, or retries exhausted for 5xx). */
export class PlaidApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string | null,
    message: string,
  ) {
    super(message)
    this.name = 'PlaidApiError'
  }
}

/** A 2xx body that failed schema validation — never retried, always surfaced. */
export class PlaidValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlaidValidationError'
  }
}

export type SleepFn = (ms: number) => Promise<void>

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export interface PlaidClientOptions {
  transport: PlaidTransport
  /** Plaid client_id — sent as a body field on every request, never logged */
  clientId: string
  /** Plaid secret — sent as a body field on every request, never logged */
  secret: string
  env?: PlaidEnv
  /** overrides env-derived base URL (test seam) */
  baseUrl?: string
  /** injectable for tests; production default is setTimeout */
  sleep?: SleepFn
}

export interface CreateLinkTokenOpts {
  /** stable id for the (single) local user */
  clientUserId: string
  /** UPDATE MODE: repair this Item's login instead of creating a new Item */
  updateAccessToken?: string
}

export class PlaidClient {
  private readonly transport: PlaidTransport
  private readonly clientId: string
  private readonly secret: string
  private readonly baseUrl: string
  private readonly sleep: SleepFn

  constructor(opts: PlaidClientOptions) {
    if (opts.clientId.trim() === '') {
      throw new Error('PlaidClient: clientId must be a non-empty string')
    }
    if (opts.secret.trim() === '') {
      throw new Error('PlaidClient: secret must be a non-empty string')
    }
    this.transport = opts.transport
    this.clientId = opts.clientId
    this.secret = opts.secret
    this.baseUrl = (opts.baseUrl ?? PLAID_BASE_URLS[opts.env ?? 'sandbox']).replace(/\/+$/, '')
    this.sleep = opts.sleep ?? defaultSleep
  }

  /**
   * Create a Link token. Update mode passes the Item's access_token instead of
   * products — this repairs the existing Item and NEVER creates a new one
   * (protecting the lifetime 10-Item cap).
   */
  async createLinkToken(opts: CreateLinkTokenOpts): Promise<string> {
    const body = {
      client_name: 'whats-left',
      language: 'en',
      country_codes: ['US'],
      user: { client_user_id: opts.clientUserId },
      ...(opts.updateAccessToken !== undefined
        ? { access_token: opts.updateAccessToken }
        : { products: ['transactions'] }),
    }
    const parsed = await this.postValidated(
      '/link/token/create',
      body,
      plaidLinkTokenResponseSchema,
      'POST /link/token/create',
    )
    return parsed.link_token
  }

  async exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
    const parsed = await this.postValidated(
      '/item/public_token/exchange',
      { public_token: publicToken },
      plaidExchangeResponseSchema,
      'POST /item/public_token/exchange',
    )
    return { accessToken: parsed.access_token, itemId: parsed.item_id }
  }

  async transactionsSync(accessToken: string, cursor?: string): Promise<PlaidSyncResponse> {
    return this.postValidated(
      '/transactions/sync',
      {
        access_token: accessToken,
        count: SYNC_PAGE_COUNT,
        ...(cursor !== undefined ? { cursor } : {}),
      },
      plaidSyncResponseSchema,
      'POST /transactions/sync',
    )
  }

  async getAccounts(accessToken: string): Promise<PlaidAccountsGetResponse> {
    return this.postValidated(
      '/accounts/get',
      { access_token: accessToken },
      plaidAccountsGetResponseSchema,
      'POST /accounts/get',
    )
  }

  private async postValidated<T>(
    path: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
    context: string,
  ): Promise<T> {
    const raw = await this.postJson(path, body, context)
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      throw new PlaidValidationError(
        `Plaid ${context}: response failed schema validation: ${parsed.error.message}`,
      )
    }
    return parsed.data
  }

  /**
   * One HTTP exchange with retry. client_id/secret are merged into the body
   * here — the single choke point — and never appear in errors or logs.
   * Retries (exponential backoff) apply ONLY to 429/RATE_LIMIT_EXCEEDED and
   * 5xx; ITEM_LOGIN_REQUIRED and other 4xx fail immediately.
   */
  private async postJson(
    path: string,
    body: Record<string, unknown>,
    context: string,
  ): Promise<unknown> {
    const authedBody = { client_id: this.clientId, secret: this.secret, ...body }
    for (let attempt = 1; ; attempt++) {
      const res = await this.transport.post(this.baseUrl + path, authedBody)
      if (res.status >= 200 && res.status < 300) return res.body

      const code = extractErrorCode(res.body)
      if (code === 'ITEM_LOGIN_REQUIRED') {
        throw new ItemLoginRequiredError(
          `Plaid ${context}: ITEM_LOGIN_REQUIRED (HTTP ${res.status}) — reconnect required`,
        )
      }

      const rateLimited = res.status === 429 || code === 'RATE_LIMIT_EXCEEDED'
      const retriable = rateLimited || res.status >= 500
      if (retriable && attempt < MAX_ATTEMPTS) {
        await this.sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1))
        continue
      }
      if (rateLimited) {
        throw new PlaidRateLimitError(`Plaid ${context}: rate limited after ${attempt} attempts`)
      }
      throw new PlaidApiError(
        res.status,
        code,
        `Plaid ${context}: HTTP ${res.status}${code !== null ? ` (${code})` : ''} after ${attempt} attempt(s)`,
      )
    }
  }
}

function extractErrorCode(body: unknown): string | null {
  const parsed = plaidErrorSchema.safeParse(body)
  return parsed.success ? parsed.data.error_code : null
}
