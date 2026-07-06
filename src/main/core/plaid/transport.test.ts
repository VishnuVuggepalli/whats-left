import { describe, expect, it } from 'vitest'
import { PlaidFetchTransport } from './transport'

function makeFetch(status: number, bodyText: string): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; init: RequestInit | undefined }>
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(bodyText, { status })
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('PlaidFetchTransport', () => {
  it('POSTs the JSON body with the right headers and parses a JSON response', async () => {
    const { fetchImpl, calls } = makeFetch(200, '{"link_token":"lt-1"}')
    const transport = new PlaidFetchTransport({ fetchImpl })
    const res = await transport.post('https://sandbox.plaid.com/link/token/create', { a: 1 })
    expect(res).toEqual({ status: 200, body: { link_token: 'lt-1' } })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://sandbox.plaid.com/link/token/create')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.headers).toMatchObject({
      'content-type': 'application/json',
      accept: 'application/json',
    })
    expect(calls[0]?.init?.body).toBe('{"a":1}')
  })

  it('passes non-JSON bodies through as raw text (proxy error pages)', async () => {
    const { fetchImpl } = makeFetch(502, '<html>bad gateway</html>')
    const transport = new PlaidFetchTransport({ fetchImpl })
    const res = await transport.post('https://sandbox.plaid.com/x', {})
    expect(res).toEqual({ status: 502, body: '<html>bad gateway</html>' })
  })

  it('maps an empty body to null', async () => {
    const { fetchImpl } = makeFetch(200, '')
    const transport = new PlaidFetchTransport({ fetchImpl })
    expect(await transport.post('https://sandbox.plaid.com/x', {})).toEqual({
      status: 200,
      body: null,
    })
  })

  it('propagates network failures', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET')
    }) as typeof fetch
    const transport = new PlaidFetchTransport({ fetchImpl })
    await expect(transport.post('https://sandbox.plaid.com/x', {})).rejects.toThrow('ECONNRESET')
  })
})
