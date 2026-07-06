import { Agent, request as httpsRequest } from 'node:https'
import type { HttpTransport } from '../ports'

/**
 * Real mTLS transport for the Teller API (plan §2/§3): node:https with the
 * client certificate + key from teller.zip and a keep-alive agent.
 *
 * The raw socket exchange is behind an injectable RawRequestFn so unit tests
 * cover URL/query/auth-header construction without any live TLS.
 */

export interface RawRequestInput {
  method: 'GET' | 'DELETE'
  url: URL
  headers: Record<string, string>
  agent: Agent
}

export interface RawResponse {
  status: number
  bodyText: string
}

export type RawRequestFn = (input: RawRequestInput) => Promise<RawResponse>

export interface MtlsTransportOptions {
  /** PEM contents (not a path) of the Teller client certificate */
  certPem: string
  /** PEM contents (not a path) of the Teller private key */
  keyPem: string
  /** test seam; production default performs the node:https request */
  rawRequest?: RawRequestFn
}

export class MtlsTransport implements HttpTransport {
  private readonly agent: Agent
  private readonly rawRequest: RawRequestFn

  constructor(opts: MtlsTransportOptions) {
    if (opts.certPem.trim() === '') {
      throw new Error('MtlsTransport: certPem must be a non-empty PEM string')
    }
    if (opts.keyPem.trim() === '') {
      throw new Error('MtlsTransport: keyPem must be a non-empty PEM string')
    }
    this.agent = new Agent({ cert: opts.certPem, key: opts.keyPem, keepAlive: true })
    this.rawRequest = opts.rawRequest ?? nodeHttpsRequest
  }

  async request(input: {
    method: 'GET' | 'DELETE'
    url: string
    basicUser?: string
    query?: Record<string, string | number | undefined>
  }): Promise<{ status: number; body: unknown }> {
    const url = new URL(input.url)
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(input.basicUser !== undefined && input.basicUser !== ''
        ? { authorization: `Basic ${Buffer.from(`${input.basicUser}:`).toString('base64')}` }
        : {}),
    }
    const { status, bodyText } = await this.rawRequest({
      method: input.method,
      url,
      headers,
      agent: this.agent,
    })
    return { status, body: parseBody(bodyText) }
  }
}

/**
 * Body text → unknown. Non-JSON bodies (e.g. an HTML 502 page from a proxy)
 * are passed through as the raw string — the caller decides how to treat a
 * non-2xx body; nothing is swallowed.
 */
function parseBody(bodyText: string): unknown {
  if (bodyText.trim() === '') return null
  try {
    return JSON.parse(bodyText) as unknown
  } catch {
    return bodyText
  }
}

function nodeHttpsRequest(input: RawRequestInput): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      input.url,
      { method: input.method, headers: input.headers, agent: input.agent },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            bodyText: Buffer.concat(chunks).toString('utf8'),
          })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}
