import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TellerEnv } from '../../shared/types'
import type { SecretStore } from '../core/ports'
import type { KvSecretBackend } from './api'

/**
 * DPAPI-backed secret storage (plan §8) built on Electron safeStorage.
 *
 * - Plaintext never touches disk: values are encrypted by an injectable codec
 *   (production: safeStorage.encryptString/decryptString) and persisted as
 *   base64 ciphertext inside a JSON file under userData.
 * - Keys are scoped per TELLER_ENV (plan §3 invariant 6): sandbox and
 *   development secrets can never collide. The env is resolved at call time so
 *   a settings change takes effect immediately.
 * - Electron is imported lazily, only when no codec is injected, so this
 *   module loads in plain-node tests.
 */

export interface SecretCodec {
  encrypt(plaintext: string): Buffer
  decrypt(ciphertext: Buffer): string
}

export interface SafeStorageSecretStoreOptions {
  /** JSON file holding the base64 ciphertext map (under app.getPath('userData')) */
  filePath: string
  /** TELLER_ENV scope — a function is re-evaluated on every call */
  env: TellerEnv | (() => TellerEnv)
  /** test seam; omitted → Electron safeStorage */
  codec?: SecretCodec
}

interface SecretsFile {
  version: 1
  secrets: Record<string, string>
}

const FILE_VERSION = 1

async function loadElectronCodec(): Promise<SecretCodec> {
  const { safeStorage } = await import('electron')
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage: OS-level encryption is not available on this machine')
  }
  return {
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
  }
}

export class SafeStorageSecretStore implements SecretStore, KvSecretBackend {
  private readonly filePath: string
  private readonly env: TellerEnv | (() => TellerEnv)
  private codec: SecretCodec | null
  private codecPromise: Promise<SecretCodec> | null = null

  constructor(opts: SafeStorageSecretStoreOptions) {
    if (opts.filePath.trim() === '') {
      throw new Error('SafeStorageSecretStore: filePath must be non-empty')
    }
    this.filePath = opts.filePath
    this.env = opts.env
    this.codec = opts.codec ?? null
  }

  async get(key: string): Promise<string | null> {
    const file = this.read()
    const b64 = file.secrets[this.scopedKey(key)]
    if (b64 === undefined) return null
    const codec = await this.resolveCodec()
    return codec.decrypt(Buffer.from(b64, 'base64'))
  }

  async set(key: string, value: string): Promise<void> {
    const codec = await this.resolveCodec()
    const ciphertext = codec.encrypt(value).toString('base64')
    const file = this.read()
    const next: SecretsFile = {
      version: FILE_VERSION,
      secrets: { ...file.secrets, [this.scopedKey(key)]: ciphertext },
    }
    this.write(next)
  }

  async delete(key: string): Promise<void> {
    const file = this.read()
    const scoped = this.scopedKey(key)
    if (!(scoped in file.secrets)) return
    const secrets = { ...file.secrets }
    delete secrets[scoped]
    this.write({ version: FILE_VERSION, secrets })
  }

  // KvSecretBackend aliases (plan §3 invariant 3: one impl behind both ports)
  async getItem(key: string): Promise<string | null> {
    return this.get(key)
  }
  async setItem(key: string, value: string): Promise<void> {
    return this.set(key, value)
  }
  async deleteItem(key: string): Promise<void> {
    return this.delete(key)
  }

  private scopedKey(key: string): string {
    if (key.trim() === '') throw new Error('SafeStorageSecretStore: key must be non-empty')
    const env = typeof this.env === 'function' ? this.env() : this.env
    return `${env}:${key}`
  }

  private async resolveCodec(): Promise<SecretCodec> {
    if (this.codec !== null) return this.codec
    this.codecPromise ??= loadElectronCodec()
    this.codec = await this.codecPromise
    return this.codec
  }

  private read(): SecretsFile {
    if (!existsSync(this.filePath)) return { version: FILE_VERSION, secrets: {} }
    const raw = readFileSync(this.filePath, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(
        `SafeStorageSecretStore: ${this.filePath} is not valid JSON — refusing to overwrite ` +
          `a possibly-corrupted secrets file (${err instanceof Error ? err.message : String(err)})`,
      )
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== FILE_VERSION ||
      typeof (parsed as { secrets?: unknown }).secrets !== 'object' ||
      (parsed as { secrets?: unknown }).secrets === null
    ) {
      throw new Error(`SafeStorageSecretStore: ${this.filePath} has an unrecognized shape`)
    }
    const secrets = (parsed as { secrets: Record<string, unknown> }).secrets
    for (const [k, v] of Object.entries(secrets)) {
      if (typeof v !== 'string') {
        throw new Error(`SafeStorageSecretStore: entry ${JSON.stringify(k)} is not a string`)
      }
    }
    return { version: FILE_VERSION, secrets: secrets as Record<string, string> }
  }

  /** write-then-rename so a crash mid-write can never truncate the store */
  private write(file: SecretsFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
    renameSync(tmp, this.filePath)
  }
}
