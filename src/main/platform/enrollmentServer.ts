import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import type { TellerEnv } from '../../shared/types'

/**
 * Temporary Teller Connect enrollment listener (plan §3/§8):
 * - bound to 127.0.0.1 on a RANDOM port, single-shot;
 * - serves ONE page embedding https://cdn.teller.io/connect/connect.js;
 * - the page POSTs the onSuccess payload to /done, which is zod-validated,
 *   resolves `result`, and closes the server;
 * - update mode: pass enrollmentId to repair an enrollment without burning
 *   dev-environment quota (plan §3 enrollment flow);
 * - 10-minute timeout → result rejects and the server closes.
 */

export interface EnrollmentServerOpts {
  applicationId: string
  environment: TellerEnv
  /** update mode: repair this enrollment instead of creating a new one */
  enrollmentId?: string
  /** preselect institution in Connect (e.g. 'chase' | 'amex') */
  institution?: string
  /** test seam; default 10 minutes */
  timeoutMs?: number
}

export interface TellerEnrollmentPayload {
  accessToken: string
  enrollmentId: string
  userId: string
  institutionName: string | null
}

export interface EnrollmentServerHandle {
  url: string
  result: Promise<TellerEnrollmentPayload>
  close(): void
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_BODY_BYTES = 1024 * 1024

/** Teller Connect onSuccess payload — only the fields we persist (plan §3) */
const enrollmentPayloadSchema = z.object({
  accessToken: z.string().min(1),
  user: z.object({ id: z.string().min(1) }),
  enrollment: z.object({
    id: z.string().min(1),
    institution: z.object({ name: z.string() }).nullish(),
  }),
})

export async function startEnrollmentServer(
  opts: EnrollmentServerOpts,
): Promise<EnrollmentServerHandle> {
  if (opts.applicationId.trim() === '') {
    throw new Error('startEnrollmentServer: applicationId must be non-empty')
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const html = renderConnectPage(opts)

  let settled = false
  let resolveResult!: (payload: TellerEnrollmentPayload) => void
  let rejectResult!: (err: Error) => void
  const result = new Promise<TellerEnrollmentPayload>((resolve, reject) => {
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
  const settleOk = (payload: TellerEnrollmentPayload): void => {
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
    settleErr(new Error(`Teller enrollment timed out after ${timeoutMs} ms`))
  }, timeoutMs)
  timer.unref()

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
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
        const body = await readBody(req)
        const payload = parsePayload(body)
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
      resolve(`http://127.0.0.1:${address.port}/`)
    })
  })

  return {
    url,
    result,
    close: () => settleErr(new Error('Teller enrollment cancelled')),
  }
}

function parsePayload(body: string): TellerEnrollmentPayload | Error {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return new Error('enrollment payload is not valid JSON')
  }
  const parsed = enrollmentPayloadSchema.safeParse(raw)
  if (!parsed.success) {
    return new Error(`enrollment payload failed validation: ${parsed.error.message}`)
  }
  return {
    accessToken: parsed.data.accessToken,
    enrollmentId: parsed.data.enrollment.id,
    userId: parsed.data.user.id,
    institutionName: parsed.data.enrollment.institution?.name ?? null,
  }
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
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

function renderConnectPage(opts: EnrollmentServerOpts): string {
  const setup = jsonForScript({
    applicationId: opts.applicationId,
    environment: opts.environment,
    ...(opts.enrollmentId !== undefined ? { enrollmentId: opts.enrollmentId } : {}),
    ...(opts.institution !== undefined ? { institution: opts.institution } : {}),
  })
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Connect your bank — whats-left</title>
  <script src="https://cdn.teller.io/connect/connect.js"></script>
</head>
<body>
  <p id="status">Opening Teller Connect…</p>
  <script>
    const status = document.getElementById('status')
    const tellerConnect = TellerConnect.setup(Object.assign({}, ${setup}, {
      onSuccess: function (enrollment) {
        fetch('/done', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(enrollment),
        }).then(function (res) {
          status.textContent = res.ok
            ? 'Enrollment complete — you can close this tab and return to whats-left.'
            : 'Something went wrong handing the enrollment to whats-left. Please retry.'
        }).catch(function () {
          status.textContent = 'Could not reach whats-left. Is the app still running?'
        })
      },
      onExit: function () {
        status.textContent = 'Enrollment window closed. You can close this tab.'
      },
    }))
    tellerConnect.open()
  </script>
</body>
</html>`
}
