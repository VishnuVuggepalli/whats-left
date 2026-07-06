import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { HttpTransport } from '../ports'
import {
  EnrollmentInactiveError,
  RateLimitError,
  TellerApiError,
  TellerClient,
  TellerValidationError,
} from './client'

const FIXTURES = '/root/whats-left/fixtures/teller'

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}/${name}`, 'utf8'))
}

type TransportInput = Parameters<HttpTransport['request']>[0]

class ScriptedTransport implements HttpTransport {
  readonly calls: TransportInput[] = []
  private readonly responses: Array<{ status: number; body: unknown }>
  constructor(responses: Array<{ status: number; body: unknown }>) {
    this.responses = [...responses]
  }
  async request(input: TransportInput): Promise<{ status: number; body: unknown }> {
    this.calls.push(input)
    const next = this.responses.shift()
    if (!next) throw new Error('ScriptedTransport: no scripted response left')
    return next
  }
}

function makeClient(
  responses: Array<{ status: number; body: unknown }>,
  opts: { baseUrl?: string } = {},
): { client: TellerClient; transport: ScriptedTransport; sleeps: number[] } {
  const transport = new ScriptedTransport(responses)
  const sleeps: number[] = []
  const client = new TellerClient({
    transport,
    accessToken: 'token_abc',
    baseUrl: opts.baseUrl,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  return { client, transport, sleeps }
}

const rateLimitBody = { error: { code: 'rate_limit.exceeded', message: 'slow down' } }

describe('TellerClient request construction', () => {
  it('listAccounts hits GET {base}/accounts with Basic auth user = accessToken', async () => {
    const { client, transport } = makeClient([{ status: 200, body: loadJson('accounts.json') }])
    const accounts = await client.listAccounts()
    expect(accounts).toHaveLength(2)
    expect(accounts[0]?.id).toBe('acc_chase_cc_1')
    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0]?.method).toBe('GET')
    expect(transport.calls[0]?.url).toBe('https://api.teller.io/accounts')
    expect(transport.calls[0]?.basicUser).toBe('token_abc')
  })

  it('listTransactions builds path + count/from_id query', async () => {
    const { client, transport } = makeClient([{ status: 200, body: [] }], {
      baseUrl: 'https://sandbox.example/',
    })
    await client.listTransactions('acc_1', { count: 25, fromId: 'txn_cursor' })
    expect(transport.calls[0]?.url).toBe('https://sandbox.example/accounts/acc_1/transactions')
    expect(transport.calls[0]?.query).toEqual({ count: 25, from_id: 'txn_cursor' })
  })

  it('listTransactions omits query keys when opts absent', async () => {
    const { client, transport } = makeClient([{ status: 200, body: [] }])
    await client.listTransactions('acc_1')
    expect(transport.calls[0]?.query ?? {}).toEqual({})
  })

  it('getBalances hits the balances path and validates the payload', async () => {
    const { client, transport } = makeClient([
      { status: 200, body: { account_id: 'acc_1', available: '100.00', ledger: '-90.55' } },
    ])
    const balances = await client.getBalances('acc_1')
    expect(transport.calls[0]?.url).toBe('https://api.teller.io/accounts/acc_1/balances')
    expect(balances.available).toBe('100.00')
    expect(balances.ledger).toBe('-90.55')
  })

  it('rejects an empty access token at construction', () => {
    expect(
      () => new TellerClient({ transport: new ScriptedTransport([]), accessToken: '  ' }),
    ).toThrow(/accessToken/)
  })
})

describe('TellerClient retry & backoff', () => {
  it('retries 429 with exponential backoff then succeeds', async () => {
    const { client, transport, sleeps } = makeClient([
      { status: 429, body: rateLimitBody },
      { status: 200, body: loadJson('accounts.json') },
    ])
    const accounts = await client.listAccounts()
    expect(accounts).toHaveLength(2)
    expect(transport.calls).toHaveLength(2)
    expect(sleeps).toEqual([500])
  })

  it('throws RateLimitError (retriable) after 3 exhausted 429 attempts', async () => {
    const { client, transport, sleeps } = makeClient([
      { status: 429, body: rateLimitBody },
      { status: 429, body: rateLimitBody },
      { status: 429, body: rateLimitBody },
    ])
    const err = await client.listAccounts().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect((err as RateLimitError).retriable).toBe(true)
    expect(transport.calls).toHaveLength(3)
    expect(sleeps).toEqual([500, 1000])
  })

  it('retries 5xx then succeeds', async () => {
    const { client, transport, sleeps } = makeClient([
      { status: 503, body: 'bad gateway text' },
      { status: 200, body: [] },
    ])
    await expect(client.listTransactions('acc_1')).resolves.toEqual([])
    expect(transport.calls).toHaveLength(2)
    expect(sleeps).toEqual([500])
  })

  it('throws TellerApiError after 3 exhausted 5xx attempts', async () => {
    const { client, transport } = makeClient([
      { status: 500, body: null },
      { status: 500, body: null },
      { status: 500, body: null },
    ])
    const err = await client.listAccounts().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TellerApiError)
    expect((err as TellerApiError).status).toBe(500)
    expect(transport.calls).toHaveLength(3)
  })

  it('does NOT retry plain 4xx errors', async () => {
    const { client, transport, sleeps } = makeClient([
      { status: 400, body: { error: { code: 'bad_request', message: 'nope' } } },
    ])
    const err = await client.listAccounts().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TellerApiError)
    expect((err as TellerApiError).status).toBe(400)
    expect((err as TellerApiError).code).toBe('bad_request')
    expect(transport.calls).toHaveLength(1)
    expect(sleeps).toEqual([])
  })
})

describe('TellerClient enrollment semantics', () => {
  it('error body code enrollment.disconnected → EnrollmentInactiveError (fixture)', async () => {
    const { client } = makeClient([{ status: 410, body: loadJson('error_enrollment_inactive.json') }])
    await expect(client.listTransactions('acc_1')).rejects.toBeInstanceOf(EnrollmentInactiveError)
  })

  it('401 → EnrollmentInactiveError even without an enrollment error code', async () => {
    const { client } = makeClient([
      { status: 401, body: { error: { code: 'unauthorized', message: 'bad token' } } },
    ])
    await expect(client.listAccounts()).rejects.toBeInstanceOf(EnrollmentInactiveError)
  })

  it('404 with enrollment.* code → EnrollmentInactiveError', async () => {
    const { client } = makeClient([
      { status: 404, body: { error: { code: 'enrollment.inactive', message: 'gone' } } },
    ])
    await expect(client.listAccounts()).rejects.toBeInstanceOf(EnrollmentInactiveError)
  })

  it('404 without enrollment semantics → plain TellerApiError', async () => {
    const { client } = makeClient([
      { status: 404, body: { error: { code: 'account.not_found', message: 'no such account' } } },
    ])
    const err = await client.getBalances('acc_missing').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TellerApiError)
    expect(err).not.toBeInstanceOf(EnrollmentInactiveError)
  })

  it('does not retry enrollment-inactive responses', async () => {
    const { client, transport } = makeClient([
      { status: 410, body: loadJson('error_enrollment_inactive.json') },
    ])
    await expect(client.listAccounts()).rejects.toBeInstanceOf(EnrollmentInactiveError)
    expect(transport.calls).toHaveLength(1)
  })
})

describe('TellerClient response validation (boundary)', () => {
  it('rejects a 200 body with amount as number', async () => {
    const txn = {
      id: 'txn_1',
      account_id: 'acc_1',
      date: '2026-07-01',
      description: 'X',
      amount: -6.75,
      status: 'posted',
      type: 'card_payment',
      running_balance: null,
      details: { processing_status: 'complete', category: null, counterparty: null },
    }
    const { client, transport } = makeClient([{ status: 200, body: [txn] }])
    const err = await client.listTransactions('acc_1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TellerValidationError)
    expect((err as Error).message).toMatch(/amount/)
    expect(transport.calls).toHaveLength(1) // validation failures never retry
  })

  it('rejects a 200 non-array transactions body', async () => {
    const { client } = makeClient([{ status: 200, body: { nope: true } }])
    await expect(client.listTransactions('acc_1')).rejects.toBeInstanceOf(TellerValidationError)
  })
})
