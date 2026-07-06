import { Agent } from 'node:https'
import { describe, expect, it } from 'vitest'
import type { RawRequestFn, RawRequestInput } from './transport'
import { MtlsTransport } from './transport'

const CERT = '-----BEGIN CERTIFICATE-----\nMIIfake\n-----END CERTIFICATE-----\n'
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIfakekey\n-----END PRIVATE KEY-----\n'

function makeTransport(response: { status: number; bodyText: string } = { status: 200, bodyText: '{}' }): {
  transport: MtlsTransport
  recorded: RawRequestInput[]
} {
  const recorded: RawRequestInput[] = []
  const rawRequest: RawRequestFn = async (input) => {
    recorded.push(input)
    return response
  }
  const transport = new MtlsTransport({ certPem: CERT, keyPem: KEY, rawRequest })
  return { transport, recorded }
}

describe('MtlsTransport URL & query construction', () => {
  it('appends only defined query params, in order', async () => {
    const { transport, recorded } = makeTransport()
    await transport.request({
      method: 'GET',
      url: 'https://api.teller.io/accounts/acc_1/transactions',
      basicUser: 'tok',
      query: { count: 30, from_id: 'txn_9', skip_me: undefined },
    })
    expect(recorded[0]?.url.toString()).toBe(
      'https://api.teller.io/accounts/acc_1/transactions?count=30&from_id=txn_9',
    )
  })

  it('leaves the URL untouched when no query given', async () => {
    const { transport, recorded } = makeTransport()
    await transport.request({ method: 'GET', url: 'https://api.teller.io/accounts' })
    expect(recorded[0]?.url.toString()).toBe('https://api.teller.io/accounts')
    expect(recorded[0]?.method).toBe('GET')
  })

  it('URL-encodes query values', async () => {
    const { transport, recorded } = makeTransport()
    await transport.request({
      method: 'GET',
      url: 'https://api.teller.io/x',
      query: { q: 'a b&c' },
    })
    expect(recorded[0]?.url.search).toBe('?q=a+b%26c')
  })
})

describe('MtlsTransport auth header', () => {
  it('sends Basic auth with token as user and empty password', async () => {
    const { transport, recorded } = makeTransport()
    await transport.request({ method: 'GET', url: 'https://api.teller.io/accounts', basicUser: 'token_abc' })
    const expected = `Basic ${Buffer.from('token_abc:').toString('base64')}`
    expect(recorded[0]?.headers.authorization).toBe(expected)
  })

  it('omits the auth header when basicUser is absent', async () => {
    const { transport, recorded } = makeTransport()
    await transport.request({ method: 'GET', url: 'https://api.teller.io/health' })
    expect(recorded[0]?.headers.authorization).toBeUndefined()
  })
})

describe('MtlsTransport agent & body handling', () => {
  it('builds a keep-alive mTLS agent from the PEM strings', async () => {
    const { transport, recorded } = makeTransport()
    await transport.request({ method: 'GET', url: 'https://api.teller.io/accounts' })
    const agent = recorded[0]?.agent as Agent & {
      options: { keepAlive?: boolean; cert?: unknown; key?: unknown }
    }
    expect(agent).toBeInstanceOf(Agent)
    expect(agent.options.keepAlive).toBe(true)
    expect(agent.options.cert).toBe(CERT)
    expect(agent.options.key).toBe(KEY)
  })

  it('reuses the same agent across requests (keep-alive)', async () => {
    const { transport, recorded } = makeTransport()
    await transport.request({ method: 'GET', url: 'https://api.teller.io/a' })
    await transport.request({ method: 'GET', url: 'https://api.teller.io/b' })
    expect(recorded[0]?.agent).toBe(recorded[1]?.agent)
  })

  it('parses JSON bodies', async () => {
    const { transport } = makeTransport({ status: 200, bodyText: '{"a":[1,2]}' })
    const res = await transport.request({ method: 'GET', url: 'https://api.teller.io/x' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ a: [1, 2] })
  })

  it('passes non-JSON bodies through as raw text (caller decides)', async () => {
    const { transport } = makeTransport({ status: 502, bodyText: '<html>bad gateway</html>' })
    const res = await transport.request({ method: 'GET', url: 'https://api.teller.io/x' })
    expect(res.status).toBe(502)
    expect(res.body).toBe('<html>bad gateway</html>')
  })

  it('returns null body for empty responses', async () => {
    const { transport } = makeTransport({ status: 204, bodyText: '' })
    const res = await transport.request({ method: 'DELETE', url: 'https://api.teller.io/x' })
    expect(res.body).toBeNull()
  })

  it('rejects empty PEM inputs at construction', () => {
    expect(() => new MtlsTransport({ certPem: '', keyPem: KEY })).toThrow(/certPem/)
    expect(() => new MtlsTransport({ certPem: CERT, keyPem: '  ' })).toThrow(/keyPem/)
  })
})
