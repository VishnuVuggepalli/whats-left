import { z } from 'zod'
import {
  jsonForScript,
  NONCE_HEADER,
  startLoopbackServer,
  type LoopbackServerHandle,
} from './loopbackServer'

export { NONCE_HEADER }

/**
 * Temporary Plaid Link listener — the Plaid twin of enrollmentServer.ts,
 * built on the same hardened loopback server (loopbackServer.ts — per-start
 * nonce, timing-safe compare, Host allowlist, Origin/Referer check,
 * application/json only, single-shot, timeout):
 * - serves ONE page embedding
 *   https://cdn.plaid.com/link/v2/stable/link-initialize.js;
 * - Plaid.create({ token }).open(); onSuccess POSTs
 *   { public_token, institution: metadata.institution } to /done (zod-
 *   validated), which resolves `result` and closes the server;
 * - update mode uses the same page: the link token was created with the
 *   Item's access_token, and the returned public_token is simply unused
 *   (no exchange — the access token is unchanged).
 */

export interface PlaidLinkServerOpts {
  /** link_token from POST /link/token/create (create or update mode) */
  linkToken: string
  /** test seam; default 10 minutes */
  timeoutMs?: number
}

export interface PlaidLinkPayload {
  publicToken: string
  institutionName: string | null
  institutionId: string | null
}

export type PlaidLinkServerHandle = LoopbackServerHandle<PlaidLinkPayload>

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** Plaid Link onSuccess payload — only the fields we persist */
const plaidLinkPayloadSchema = z.object({
  public_token: z.string().min(1),
  institution: z
    .object({
      name: z.string(),
      institution_id: z.string(),
    })
    .nullish(),
})

export async function startPlaidLinkServer(
  opts: PlaidLinkServerOpts,
): Promise<PlaidLinkServerHandle> {
  if (opts.linkToken.trim() === '') {
    throw new Error('startPlaidLinkServer: linkToken must be non-empty')
  }
  return startLoopbackServer<PlaidLinkPayload>({
    name: 'Plaid Link',
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    renderPage: (nonce) => renderLinkPage(opts, nonce),
    parsePayload,
  })
}

function parsePayload(raw: unknown): PlaidLinkPayload | Error {
  const parsed = plaidLinkPayloadSchema.safeParse(raw)
  if (!parsed.success) {
    return new Error(`Plaid Link payload failed validation: ${parsed.error.message}`)
  }
  return {
    publicToken: parsed.data.public_token,
    institutionName: parsed.data.institution?.name ?? null,
    institutionId: parsed.data.institution?.institution_id ?? null,
  }
}

function renderLinkPage(opts: PlaidLinkServerOpts, nonce: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Connect your bank — whats-left</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
</head>
<body>
  <p id="status">Opening Plaid Link…</p>
  <script>
    const status = document.getElementById('status')
    const handler = Plaid.create({
      token: ${jsonForScript(opts.linkToken)},
      onSuccess: function (public_token, metadata) {
        fetch('/done', {
          method: 'POST',
          headers: { 'content-type': 'application/json', '${NONCE_HEADER}': ${jsonForScript(nonce)} },
          body: JSON.stringify({ public_token: public_token, institution: metadata.institution }),
        }).then(function (res) {
          status.textContent = res.ok
            ? 'Connection complete — you can close this tab and return to whats-left.'
            : 'Something went wrong handing the connection to whats-left. Please retry.'
        }).catch(function () {
          status.textContent = 'Could not reach whats-left. Is the app still running?'
        })
      },
      onExit: function () {
        status.textContent = 'Plaid Link closed. You can close this tab.'
      },
    })
    handler.open()
  </script>
</body>
</html>`
}
