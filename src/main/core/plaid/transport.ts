import type { PlaidTransport } from './client'

/**
 * Real HTTPS transport for the Plaid API. Plaid is plain JSON-over-POST (no
 * mTLS, unlike Teller), so global fetch is sufficient; fetchImpl is injectable
 * so unit tests cover request construction without any live network.
 */

export interface PlaidFetchTransportOptions {
  /** test seam; production default is the global fetch */
  fetchImpl?: typeof fetch
}

export class PlaidFetchTransport implements PlaidTransport {
  private readonly fetchImpl: typeof fetch

  constructor(opts: PlaidFetchTransportOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // Pin the API version (Plaid's canonical quickstart does the same) so
        // response shapes can't shift when Plaid rolls the account default.
        'plaid-version': '2020-09-14',
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: parseBody(text) }
  }
}

/**
 * Body text → unknown. Non-JSON bodies (e.g. an HTML 502 page from a proxy)
 * are passed through as the raw string — the caller decides how to treat a
 * non-2xx body; nothing is swallowed.
 */
function parseBody(text: string): unknown {
  if (text.trim() === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}
