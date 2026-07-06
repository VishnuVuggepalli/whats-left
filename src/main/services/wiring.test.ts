import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemorySecretStore } from '../platform/fakes'
import {
  createFetchTransport,
  createTellerClientFactory,
  loadDevSecrets,
  makeLlmFromSettings,
  withDevTokenFallback,
} from './wiring'
import { SETTINGS_DEFAULTS } from './appService'

describe('loadDevSecrets', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wiring-test-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns null when the dev secrets dir is absent or empty', () => {
    expect(loadDevSecrets(root)).toBeNull()
    mkdirSync(join(root, '.secrets', 'teller'), { recursive: true })
    expect(loadDevSecrets(root)).toBeNull()
  })

  it('loads whichever of cert/key/token exist and trims the token', () => {
    const dir = join(root, '.secrets', 'teller')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'certificate.pem'), 'CERT-PEM')
    writeFileSync(join(dir, 'token'), 'tok_dev_1\n')
    expect(loadDevSecrets(root)).toEqual({
      certPem: 'CERT-PEM',
      keyPem: null,
      accessToken: 'tok_dev_1',
    })
  })

  it('treats a whitespace-only token file as missing', () => {
    const dir = join(root, '.secrets', 'teller')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'token'), '  \n')
    expect(loadDevSecrets(root)).toBeNull()
  })
})

describe('createFetchTransport', () => {
  function capture(status: number, body: string) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return new Response(body, { status })
    }) as typeof fetch
    return { calls, transport: createFetchTransport(fetchImpl) }
  }

  it('builds the query string and Basic auth header (token as user, empty password)', async () => {
    const { calls, transport } = capture(200, '[{"ok":true}]')
    const res = await transport.request({
      method: 'GET',
      url: 'https://api.teller.io/accounts/a1/transactions',
      basicUser: 'tok_x',
      query: { count: 25, from_id: 'txn_9', skipped: undefined },
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual([{ ok: true }])
    expect(calls[0]!.url).toBe(
      'https://api.teller.io/accounts/a1/transactions?count=25&from_id=txn_9',
    )
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers['authorization']).toBe(`Basic ${Buffer.from('tok_x:').toString('base64')}`)
  })

  it('passes non-JSON bodies through as raw text and omits auth without a user', async () => {
    const { calls, transport } = capture(502, '<html>bad gateway</html>')
    const res = await transport.request({ method: 'GET', url: 'https://api.teller.io/accounts' })
    expect(res).toEqual({ status: 502, body: '<html>bad gateway</html>' })
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers['authorization']).toBeUndefined()
  })
})

describe('createTellerClientFactory / makeLlmFromSettings', () => {
  it('builds a TellerClient without dev secrets (plain transport, sandbox)', () => {
    const factory = createTellerClientFactory(null)
    expect(() => factory('tok_1')).not.toThrow()
    expect(() => factory('')).toThrow(/accessToken/)
  })

  it('builds an OllamaClient from settings', () => {
    const llm = makeLlmFromSettings({ ...SETTINGS_DEFAULTS, ollamaUrl: 'http://127.0.0.1:1', ollamaModel: 'm' })
    expect(typeof llm.isAvailable).toBe('function')
    expect(typeof llm.categorizeMerchants).toBe('function')
  })
})

describe('withDevTokenFallback', () => {
  it('falls back to the dev token only for teller access-token reads', async () => {
    const store = new InMemorySecretStore()
    const wrapped = withDevTokenFallback(store, {
      certPem: null,
      keyPem: null,
      accessToken: 'tok_dev',
    })
    expect(await wrapped.get('teller:accessToken:enr_1')).toBe('tok_dev')
    expect(await wrapped.get('teller:applicationId')).toBeNull()

    await wrapped.set('teller:accessToken:enr_1', 'tok_real')
    expect(await wrapped.get('teller:accessToken:enr_1')).toBe('tok_real')
    expect(await store.get('teller:accessToken:enr_1')).toBe('tok_real')

    await wrapped.delete('teller:accessToken:enr_1')
    expect(await wrapped.get('teller:accessToken:enr_1')).toBe('tok_dev') // fallback again
  })

  it('is the identity when there is no dev token', async () => {
    const store = new InMemorySecretStore()
    expect(withDevTokenFallback(store, null)).toBe(store)
    expect(withDevTokenFallback(store, { certPem: 'c', keyPem: 'k', accessToken: null })).toBe(store)
  })
})
