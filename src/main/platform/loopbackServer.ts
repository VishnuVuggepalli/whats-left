import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Hardened single-shot loopback page server — the shared machinery behind the
 * Teller Connect enrollment listener (enrollmentServer.ts) and the Plaid Link
 * listener (plaidLinkServer.ts). Behavior (plan §3/§8):
 * - bound to 127.0.0.1 on a RANDOM port, single-shot;
 * - serves ONE page (renderPage) on GET /;
 * - the page POSTs its payload to /done, which is parsed (parsePayload,
 *   zod inside the caller), resolves `result`, and closes the server;
 * - timeout → result rejects and the server closes.
 *
 * Forgery defenses (loopback-OAuth style):
 * - a per-start crypto-random nonce is embedded in the served page and must be
 *   echoed back on POST /done (X-Enroll-Nonce header or `nonce` body field);
 * - the Host header must be loopback (127.0.0.1/localhost, correct port) on
 *   EVERY route — DNS-rebinding pages can neither read the page (and steal the
 *   nonce) nor post to /done;
 * - when Origin/Referer are present they must match the server's own origin;
 * - /done only accepts Content-Type application/json, so cross-origin CORS
 *   "simple requests" (text/plain) are rejected without needing a preflight.
 * All rejected requests leave the server listening and the result unsettled.
 */

export interface LoopbackServerOpts<T> {
  /** human label used in timeout/cancel errors, e.g. 'Teller enrollment' */
  name: string
  /** the single HTML page served on GET /; must embed the nonce for POST /done */
  renderPage: (nonce: string) => string
  /** validated payload (zod) or an Error describing the rejection */
  parsePayload: (raw: unknown) => T | Error
  timeoutMs: number
}

export interface LoopbackServerHandle<T> {
  url: string
  result: Promise<T>
  close(): void
}

const MAX_BODY_BYTES = 1024 * 1024
const NONCE_BYTES = 16
export const NONCE_HEADER = 'x-enroll-nonce'

export async function startLoopbackServer<T>(
  opts: LoopbackServerOpts<T>,
): Promise<LoopbackServerHandle<T>> {
  const nonce = randomBytes(NONCE_BYTES).toString('hex')
  const html = opts.renderPage(nonce)
  // set once listen() succeeds; handleRequest only runs after that
  let boundPort = 0

  let settled = false
  let resolveResult!: (payload: T) => void
  let rejectResult!: (err: Error) => void
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const server = createServer((req, res) => {
    void handleRequest(req, res)
  })

  const shutdown = (): void => {
    server.close()
    server.closeAllConnections()
  }
  const settleOk = (payload: T): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolveResult(payload)
    shutdown()
  }
  const settleErr = (err: Error): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    rejectResult(err)
    shutdown()
  }

  const timer = setTimeout(() => {
    settleErr(new Error(`${opts.name} timed out after ${opts.timeoutMs} ms`))
  }, opts.timeoutMs)
  timer.unref()

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // DNS-rebinding defense on EVERY route: a rebinding page must not read
      // the nonce off GET / any more than it may hit POST /done.
      if (!isLoopbackHost(req.headers.host, boundPort)) {
        respondJson(res, 403, { ok: false, error: 'forbidden: unexpected Host header' })
        return
      }
      if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(html)
        return
      }
      if (req.method === 'POST' && req.url === '/done') {
        if (settled) {
          respondJson(res, 409, { ok: false, error: 'enrollment already completed' })
          return
        }
        if (!isOwnOrigin(req, boundPort)) {
          respondJson(res, 403, { ok: false, error: 'forbidden: cross-origin request rejected' })
          return
        }
        if (!isJsonContentType(req.headers['content-type'])) {
          respondJson(res, 415, { ok: false, error: 'content-type must be application/json' })
          return
        }
        const body = await readBody(req)
        let raw: unknown
        try {
          raw = JSON.parse(body)
        } catch {
          respondJson(res, 400, { ok: false, error: 'enrollment payload is not valid JSON' })
          return
        }
        if (!nonceMatches(presentedNonce(req, raw), nonce)) {
          respondJson(res, 403, { ok: false, error: 'forbidden: missing or invalid enrollment nonce' })
          return
        }
        const payload = opts.parsePayload(raw)
        if (payload instanceof Error) {
          respondJson(res, 400, { ok: false, error: payload.message })
          return
        }
        respondJson(res, 200, { ok: true })
        settleOk(payload)
        return
      }
      respondJson(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      respondJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const url = await new Promise<string>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      boundPort = address.port
      resolve(`http://127.0.0.1:${address.port}/`)
    })
  })

  return {
    url,
    result,
    close: () => settleErr(new Error(`${opts.name} cancelled`)),
  }
}

/** loopback-only Host allowlist; a port, when present, must be our own */
function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false
  const match = /^(127\.0\.0\.1|localhost)(?::(\d+))?$/i.exec(host.trim())
  if (match === null) return false
  return match[2] === undefined || Number(match[2]) === port
}

/** Origin/Referer, when present, must be the server's own origin */
function isOwnOrigin(req: IncomingMessage, port: number): boolean {
  const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
  const origin = req.headers.origin
  if (origin !== undefined && !allowed.includes(origin)) return false
  const referer = req.headers.referer
  if (referer !== undefined) {
    const ok = allowed.some((base) => referer === base || referer.startsWith(`${base}/`))
    if (!ok) return false
  }
  return true
}

/** rejects CORS "simple request" content types (text/plain etc.) */
function isJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false
  return (contentType.split(';')[0] ?? '').trim().toLowerCase() === 'application/json'
}

/** nonce from the X-Enroll-Nonce header, else a `nonce` field in the JSON body */
function presentedNonce(req: IncomingMessage, raw: unknown): string | null {
  const header = req.headers[NONCE_HEADER]
  if (typeof header === 'string') return header
  if (typeof raw === 'object' && raw !== null) {
    const candidate = (raw as { nonce?: unknown }).nonce
    if (typeof candidate === 'string') return candidate
  }
  return null
}

function nonceMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('enrollment payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** `<` escaped so payload text can never break out of the script tag */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}
