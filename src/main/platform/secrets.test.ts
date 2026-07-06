import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TellerEnv } from '../../shared/types'
import { SafeStorageSecretStore, type SecretCodec } from './secrets'

/** reversible fake codec — marks ciphertext so we can prove no plaintext-at-rest */
function fakeCodec(): SecretCodec & { encryptCalls: number } {
  const codec = {
    encryptCalls: 0,
    encrypt(plaintext: string): Buffer {
      codec.encryptCalls += 1
      return Buffer.from(`enc[${plaintext}]`, 'utf8')
    },
    decrypt(ciphertext: Buffer): string {
      const text = ciphertext.toString('utf8')
      const m = /^enc\[([\s\S]*)\]$/.exec(text)
      if (!m || m[1] === undefined) throw new Error(`fake codec: not our ciphertext: ${text}`)
      return m[1]
    },
  }
  return codec
}

describe('SafeStorageSecretStore', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secrets-test-'))
    filePath = join(dir, 'nested', 'secrets.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeStore(env: TellerEnv | (() => TellerEnv) = 'sandbox') {
    return new SafeStorageSecretStore({ filePath, env, codec: fakeCodec() })
  }

  it('round-trips a secret', async () => {
    const store = makeStore()
    await store.set('teller:accessToken:enr_1', 'token_abc')
    expect(await store.get('teller:accessToken:enr_1')).toBe('token_abc')
  })

  it('returns null for a missing key and for a missing file', async () => {
    const store = makeStore()
    expect(await store.get('nope')).toBeNull()
  })

  it('persists across instances (file-backed)', async () => {
    await makeStore().set('k', 'v1')
    expect(await makeStore().get('k')).toBe('v1')
  })

  it('stores ciphertext as base64 JSON — never plaintext on disk', async () => {
    await makeStore().set('k', 'super-secret-token')
    const raw = readFileSync(filePath, 'utf8')
    expect(raw).not.toContain('super-secret-token')
    const parsed = JSON.parse(raw) as { version: number; secrets: Record<string, string> }
    expect(parsed.version).toBe(1)
    const stored = parsed.secrets['sandbox:k']
    expect(stored).toBeDefined()
    expect(Buffer.from(stored as string, 'base64').toString('utf8')).toBe('enc[super-secret-token]')
  })

  it('writes secrets.json owner-only (0600) on POSIX', async () => {
    await makeStore().set('k', 'v')
    if (process.platform === 'win32') return // POSIX modes do not apply on Windows
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it('tightens a pre-existing world-readable secrets file back to 0600 on the next write', async () => {
    const store = makeStore()
    await store.set('k', 'v')
    if (process.platform === 'win32') return // POSIX modes do not apply on Windows
    chmodSync(filePath, 0o644)
    await store.set('k2', 'v2')
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it('scopes keys per TELLER_ENV — sandbox and development never collide', async () => {
    const sandbox = makeStore('sandbox')
    const development = makeStore('development')
    await sandbox.set('teller:accessToken:enr_1', 'sandbox-token')
    await development.set('teller:accessToken:enr_1', 'dev-token')

    expect(await sandbox.get('teller:accessToken:enr_1')).toBe('sandbox-token')
    expect(await development.get('teller:accessToken:enr_1')).toBe('dev-token')
  })

  it('re-evaluates a function env on every call (settings switch takes effect)', async () => {
    let env: TellerEnv = 'sandbox'
    const store = makeStore(() => env)
    await store.set('token', 'sandbox-value')
    env = 'development'
    expect(await store.get('token')).toBeNull()
    await store.set('token', 'dev-value')
    env = 'sandbox'
    expect(await store.get('token')).toBe('sandbox-value')
  })

  it('delete removes exactly the scoped key', async () => {
    const store = makeStore()
    const other = makeStore('development')
    await store.set('a', '1')
    await other.set('a', '2')
    await store.delete('a')
    expect(await store.get('a')).toBeNull()
    expect(await other.get('a')).toBe('2')
    // deleting a missing key is a no-op, not an error
    await store.delete('a')
  })

  it('overwrites an existing key', async () => {
    const store = makeStore()
    await store.set('k', 'old')
    await store.set('k', 'new')
    expect(await store.get('k')).toBe('new')
  })

  it('KvSecretBackend aliases delegate to the same storage', async () => {
    const store = makeStore()
    await store.setItem('k', 'v')
    expect(await store.get('k')).toBe('v')
    expect(await store.getItem('k')).toBe('v')
    await store.deleteItem('k')
    expect(await store.getItem('k')).toBeNull()
  })

  it('throws loudly on a corrupt secrets file instead of clobbering it', async () => {
    await makeStore().set('k', 'v')
    writeFileSync(filePath, '{ not json', 'utf8')
    await expect(makeStore().get('k')).rejects.toThrow(/not valid JSON/)
    await expect(makeStore().set('k', 'v2')).rejects.toThrow(/not valid JSON/)
  })

  it('throws on an unrecognized file shape', async () => {
    await makeStore().set('k', 'v')
    writeFileSync(filePath, JSON.stringify({ version: 99, secrets: {} }), 'utf8')
    await expect(makeStore().get('k')).rejects.toThrow(/unrecognized shape/)
  })

  it('rejects empty keys and an empty file path', async () => {
    await expect(makeStore().get('')).rejects.toThrow(/key must be non-empty/)
    expect(() => new SafeStorageSecretStore({ filePath: '  ', env: 'sandbox' })).toThrow(
      /filePath/,
    )
  })
})
