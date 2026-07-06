import { z } from 'zod'
import type { TellerEnv } from '../../shared/types'
import {
  jsonForScript,
  NONCE_HEADER,
  startLoopbackServer,
  type LoopbackServerHandle,
} from './loopbackServer'

export { NONCE_HEADER }

/**
 * Temporary Teller Connect enrollment listener (plan §3/§8), built on the
 * shared hardened loopback server (loopbackServer.ts — nonce, Host allowlist,
 * Origin check, JSON-only, single-shot, timeout):
 * - serves ONE page embedding https://cdn.teller.io/connect/connect.js;
 * - the page POSTs the onSuccess payload to /done, which is zod-validated,
 *   resolves `result`, and closes the server;
 * - update mode: pass enrollmentId to repair an enrollment without burning
 *   dev-environment quota (plan §3 enrollment flow).
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

export type EnrollmentServerHandle = LoopbackServerHandle<TellerEnrollmentPayload>

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

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
  return startLoopbackServer<TellerEnrollmentPayload>({
    name: 'Teller enrollment',
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    renderPage: (nonce) => renderConnectPage(opts, nonce),
    parsePayload,
  })
}

function parsePayload(raw: unknown): TellerEnrollmentPayload | Error {
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

function renderConnectPage(opts: EnrollmentServerOpts, nonce: string): string {
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
          headers: { 'content-type': 'application/json', '${NONCE_HEADER}': ${jsonForScript(nonce)} },
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
