import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SettingsDto } from '../../shared/types'
import { OllamaClient } from '../core/ollama/client'
import { PlaidClient } from '../core/plaid/client'
import { PlaidFetchTransport } from '../core/plaid/transport'
import type { HttpTransport, SecretStore } from '../core/ports'
import { TellerClient } from '../core/teller/client'
import { MtlsTransport } from '../core/teller/transport'
import type { LlmPort } from './categorization'
import type { MakePlaidClient, TellerClientPort } from './appService'

/**
 * Electron-free composition helpers used by src/main/index.ts. Everything here
 * is plain node so the wiring is unit-testable (plan §3 invariant 3).
 */

export interface DevSecrets {
  certPem: string | null
  keyPem: string | null
  accessToken: string | null
}

/**
 * Dev-time secrets dir (plan §8): .secrets/teller/{certificate.pem,
 * private_key.pem,token} under the project root, gitignored. Returns null when
 * the directory contributes nothing.
 */
export function loadDevSecrets(rootDir: string): DevSecrets | null {
  const dir = join(rootDir, '.secrets', 'teller')
  const readIfExists = (name: string): string | null => {
    const path = join(dir, name)
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }
  const certPem = readIfExists('certificate.pem')
  const keyPem = readIfExists('private_key.pem')
  const tokenRaw = readIfExists('token')
  const accessToken = tokenRaw !== null && tokenRaw.trim() !== '' ? tokenRaw.trim() : null
  if (certPem === null && keyPem === null && accessToken === null) return null
  return { certPem, keyPem, accessToken }
}

/**
 * Plain HTTPS transport (no client cert) for the Teller sandbox, where mTLS is
 * optional. Same request contract as MtlsTransport.
 */
export function createFetchTransport(fetchImpl: typeof fetch = fetch): HttpTransport {
  return {
    async request(input) {
      const url = new URL(input.url)
      for (const [key, value] of Object.entries(input.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
      const headers: Record<string, string> = { accept: 'application/json' }
      if (input.basicUser !== undefined && input.basicUser !== '') {
        headers['authorization'] = `Basic ${Buffer.from(`${input.basicUser}:`).toString('base64')}`
      }
      const res = await fetchImpl(url, { method: input.method, headers })
      const text = await res.text()
      return { status: res.status, body: parseBody(text) }
    },
  }
}

function parseBody(text: string): unknown {
  if (text.trim() === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text // non-JSON error page: surfaced as-is, never swallowed
  }
}

/**
 * Teller client factory: mTLS when the dev cert+key are present, plain HTTPS
 * otherwise (sandbox). One transport instance is shared across tokens so the
 * keep-alive agent is reused.
 */
export function createTellerClientFactory(
  devSecrets: DevSecrets | null,
  baseUrl?: string,
): (accessToken: string) => TellerClientPort {
  const transport: HttpTransport =
    devSecrets !== null && devSecrets.certPem !== null && devSecrets.keyPem !== null
      ? new MtlsTransport({ certPem: devSecrets.certPem, keyPem: devSecrets.keyPem })
      : createFetchTransport()
  return (accessToken) =>
    new TellerClient({ transport, accessToken, ...(baseUrl !== undefined ? { baseUrl } : {}) })
}

/**
 * Plaid client factory: plain JSON-over-HTTPS (no mTLS), auth in the body.
 * One transport instance is shared across credential sets; the credentials
 * come from settings/SecretStore per call and are never logged.
 */
export function createPlaidClientFactory(fetchImpl?: typeof fetch): MakePlaidClient {
  const transport = new PlaidFetchTransport(fetchImpl !== undefined ? { fetchImpl } : {})
  return (cfg) =>
    new PlaidClient({ transport, clientId: cfg.clientId, secret: cfg.secret, env: cfg.env })
}

/** OllamaClient factory bound to the current settings */
export function makeLlmFromSettings(settings: SettingsDto): LlmPort {
  return new OllamaClient({ baseUrl: settings.ollamaUrl, model: settings.ollamaModel })
}

/**
 * Secret store wrapper that falls back to the dev token for Teller access
 * token reads when nothing is stored yet (plan §8 dev-time secrets). Writes
 * and deletes always target the real store.
 */
export function withDevTokenFallback(store: SecretStore, devSecrets: DevSecrets | null): SecretStore {
  const devToken = devSecrets?.accessToken ?? null
  if (devToken === null) return store
  return {
    async get(key) {
      const stored = await store.get(key)
      if (stored !== null) return stored
      return key.startsWith('teller:accessToken:') ? devToken : null
    },
    set: (key, value) => store.set(key, value),
    delete: (key) => store.delete(key),
  }
}
