import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ItemLoginRequiredError,
  PlaidApiError,
  PlaidClient,
  PlaidRateLimitError,
  PlaidValidationError,
  type PlaidTransport,
} from './client'

const FIXTURES = '/root/whats-left/fixtures/plaid'

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}/${name}`, 'utf8'))
}

class ScriptedTransport implements PlaidTransport {
  readonly calls: Array<{ url: string; body: Record<string, unknown> }> = []
  private readonly responses: Array<{ status: number; body: unknown }>
  constructor(responses: Array<{ status: number; body: unknown }>) {
    this.responses = [...responses]
  }
  async post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
    this.calls.push({ url, body: body as Record<string, unknown> })
    const next = this.responses.shift()
    if (!next) throw new Error('ScriptedTransport: no scripted response left')
    return next
  }
}

function makeClient(
  responses: Array<{ status: number; body: unknown }>,
  opts: { baseUrl?: string; env?: 'sandbox' | 'production' } = {},
): { client: PlaidClient; transport: ScriptedTransport; sleeps: number[] } {
  const transport = new ScriptedTransport(responses)
  const sleeps: number[] = []
  const client = new PlaidClient({
    transport,
    clientId: 'client_test_1',
    secret: 'secret_test_1',
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  return { client, transport, sleeps }
}

const rateLimitBody = {
  error_type: 'RATE_LIMIT_EXCEEDED',
  error_code: 'RATE_LIMIT_EXCEEDED',
  error_message: 'slow down',
}

describe('PlaidClient request construction', () => {
  it('every request carries client_id + secret as body fields (Plaid auth model)', async () => {
    const { client, transport } = makeClient([{ status: 200, body: loadJson('accounts.json') }])
    await client.getAccounts('access-token-1')
    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0]?.url).toBe('https://sandbox.plaid.com/accounts/get')
    expect(transport.calls[0]?.body).toMatchObject({
      client_id: 'client_test_1',
      secret: 'secret_test_1',
      access_token: 'access-token-1',
    })
  })

  it('env=production selects the production base URL', async () => {
    const { client, transport } = makeClient([{ status: 200, body: loadJson('accounts.json') }], {
      env: 'production',
    })
    await client.getAccounts('t')
    expect(transport.calls[0]?.url).toBe('https://production.plaid.com/accounts/get')
  })

  it('createLinkToken (create mode) requests products=[transactions], US, client_user_id', async () => {
    const { client, transport } = makeClient([{ status: 200, body: { link_token: 'lt-1' } }])
    const token = await client.createLinkToken({ clientUserId: 'user-1' })
    expect(token).toBe('lt-1')
    expect(transport.calls[0]?.url).toBe('https://sandbox.plaid.com/link/token/create')
    expect(transport.calls[0]?.body).toMatchObject({
      products: ['transactions'],
      country_codes: ['US'],
      user: { client_user_id: 'user-1' },
    })
    expect(transport.calls[0]?.body['access_token']).toBeUndefined()
  })

  it('createLinkToken (UPDATE MODE) sends access_token INSTEAD of products — never a new Item', async () => {
    const { client, transport } = makeClient([{ status: 200, body: { link_token: 'lt-2' } }])
    await client.createLinkToken({ clientUserId: 'user-1', updateAccessToken: 'access-token-1' })
    expect(transport.calls[0]?.body['access_token']).toBe('access-token-1')
    expect(transport.calls[0]?.body['products']).toBeUndefined()
  })

  it('exchangePublicToken returns access token + item id', async () => {
    const { client, transport } = makeClient([
      { status: 200, body: { access_token: 'access-1', item_id: 'item-1', request_id: 'r' } },
    ])
    const res = await client.exchangePublicToken('public-1')
    expect(res).toEqual({ accessToken: 'access-1', itemId: 'item-1' })
    expect(transport.calls[0]?.url).toBe('https://sandbox.plaid.com/item/public_token/exchange')
    expect(transport.calls[0]?.body['public_token']).toBe('public-1')
  })

  it('transactionsSync passes count always and cursor only when given', async () => {
    const page = loadJson('transactions_sync_page2.json')
    const { client, transport } = makeClient([
      { status: 200, body: page },
      { status: 200, body: page },
    ])
    await client.transactionsSync('access-1')
    expect(transport.calls[0]?.url).toBe('https://sandbox.plaid.com/transactions/sync')
    expect(transport.calls[0]?.body['count']).toBe(100)
    expect('cursor' in (transport.calls[0]?.body ?? {})).toBe(false)

    await client.transactionsSync('access-1', 'cursor-abc')
    expect(transport.calls[1]?.body['cursor']).toBe('cursor-abc')
  })

  it('rejects empty credentials at construction', () => {
    const transport = new ScriptedTransport([])
    expect(() => new PlaidClient({ transport, clientId: ' ', secret: 's' })).toThrow(/clientId/)
    expect(() => new PlaidClient({ transport, clientId: 'c', secret: '  ' })).toThrow(/secret/)
  })
})

describe('PlaidClient retry & backoff', () => {
  it('retries 429 with exponential backoff then succeeds', async () => {
    const { client, transport, sleeps } = makeClient([
      { status: 429, body: rateLimitBody },
      { status: 200, body: loadJson('accounts.json') },
    ])
    const res = await client.getAccounts('t')
    expect(res.accounts).toHaveLength(2)
    expect(transport.calls).toHaveLength(2)
    expect(sleeps).toEqual([500])
  })

  it('throws PlaidRateLimitError (retriable) after 3 exhausted attempts', async () => {
    const { client, transport, sleeps } = makeClient([
      { status: 429, body: rateLimitBody },
      { status: 429, body: rateLimitBody },
      { status: 429, body: rateLimitBody },
    ])
    const err = await client.getAccounts('t').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PlaidRateLimitError)
    expect((err as PlaidRateLimitError).retriable).toBe(true)
    expect(transport.calls).toHaveLength(3)
    expect(sleeps).toEqual([500, 1000])
  })

  it('treats a RATE_LIMIT_EXCEEDED error code as retriable even on HTTP 400', async () => {
    const { client, transport } = makeClient([
      { status: 400, body: rateLimitBody },
      { status: 200, body: loadJson('accounts.json') },
    ])
    await expect(client.getAccounts('t')).resolves.toBeDefined()
    expect(transport.calls).toHaveLength(2)
  })

  it('retries 5xx then succeeds', async () => {
    const { client, transport, sleeps } = makeClient([
      { status: 503, body: 'bad gateway text' },
      { status: 200, body: { link_token: 'lt' } },
    ])
    await expect(client.createLinkToken({ clientUserId: 'u' })).resolves.toBe('lt')
    expect(transport.calls).toHaveLength(2)
    expect(sleeps).toEqual([500])
  })

  it('throws PlaidApiError after 3 exhausted 5xx attempts', async () => {
    const { client, transport } = makeClient([
      { status: 500, body: null },
      { status: 500, body: null },
      { status: 500, body: null },
    ])
    const err = await client.getAccounts('t').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PlaidApiError)
    expect((err as PlaidApiError).status).toBe(500)
    expect(transport.calls).toHaveLength(3)
  })

  it('does NOT retry plain 4xx errors', async () => {
    const { client, transport, sleeps } = makeClient([
      {
        status: 400,
        body: { error_type: 'INVALID_REQUEST', error_code: 'MISSING_FIELDS', error_message: 'nope' },
      },
    ])
    const err = await client.getAccounts('t').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PlaidApiError)
    expect((err as PlaidApiError).errorCode).toBe('MISSING_FIELDS')
    expect(transport.calls).toHaveLength(1)
    expect(sleeps).toEqual([])
  })

  it('never leaks the client credentials into error messages', async () => {
    const { client } = makeClient([{ status: 500, body: null }, { status: 500, body: null }, { status: 500, body: null }])
    const err = await client.getAccounts('t').catch((e: unknown) => e)
    const message = (err as Error).message
    expect(message).not.toContain('client_test_1')
    expect(message).not.toContain('secret_test_1')
  })
})

describe('PlaidClient item semantics', () => {
  it('ITEM_LOGIN_REQUIRED error body → ItemLoginRequiredError (fixture), never retried', async () => {
    const { client, transport } = makeClient([
      { status: 400, body: loadJson('error_item_login_required.json') },
    ])
    await expect(client.transactionsSync('t')).rejects.toBeInstanceOf(ItemLoginRequiredError)
    expect(transport.calls).toHaveLength(1)
  })
})

describe('PlaidClient response validation (boundary)', () => {
  it('rejects a 200 sync body with a string amount', async () => {
    const page = loadJson('transactions_sync_page1.json') as {
      added: Array<Record<string, unknown>>
    }
    page.added[0]!['amount'] = '-6.75'
    const { client, transport } = makeClient([{ status: 200, body: page }])
    const err = await client.transactionsSync('t').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PlaidValidationError)
    expect((err as Error).message).toMatch(/amount/)
    expect(transport.calls).toHaveLength(1) // validation failures never retry
  })

  it('rejects a 200 body missing next_cursor', async () => {
    const { client } = makeClient([
      { status: 200, body: { added: [], modified: [], removed: [], has_more: false } },
    ])
    await expect(client.transactionsSync('t')).rejects.toBeInstanceOf(PlaidValidationError)
  })
})
