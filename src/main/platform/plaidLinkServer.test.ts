import { request } from 'node:http'
import { describe, expect, it } from 'vitest'
import { NONCE_HEADER, startPlaidLinkServer } from './plaidLinkServer'

const VALID_PAYLOAD = {
  public_token: 'public-sandbox-token-1',
  institution: { name: 'Chase', institution_id: 'ins_56' },
}

async function postDone(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(new URL('/done', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** the nonce is only obtainable the way the real Link page gets it: from GET / */
async function fetchNonce(url: string): Promise<string> {
  const page = await (await fetch(url)).text()
  const match = new RegExp(`'${NONCE_HEADER}': "([0-9a-f]+)"`).exec(page)
  if (!match || match[1] === undefined) throw new Error('nonce not found in served page')
  return match[1]
}

async function postDoneWithNonce(url: string, body: unknown): Promise<Response> {
  const nonce = await fetchNonce(url)
  return postDone(url, body, { [NONCE_HEADER]: nonce })
}

/** raw node:http POST — lets us forge headers (Host) that fetch() refuses to set */
function rawPost(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const target = new URL('/done', url)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: '/done',
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString('utf8')
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('startPlaidLinkServer (real http round-trip on 127.0.0.1)', () => {
  it('serves the Link page embedding the plaid cdn script, the link token, and the nonce', async () => {
    const handle = await startPlaidLinkServer({ linkToken: 'link-sandbox-token-1' })
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      const res = await fetch(handle.url)
      expect(res.status).toBe(200)
      const page = await res.text()
      expect(page).toContain('https://cdn.plaid.com/link/v2/stable/link-initialize.js')
      expect(page).toContain('Plaid.create')
      expect(page).toContain('"link-sandbox-token-1"')
      expect(page).toContain("fetch('/done'")
      expect(page).toMatch(new RegExp(`'${NONCE_HEADER}': "[0-9a-f]{32}"`))
    } finally {
      handle.close()
      await expect(handle.result).rejects.toThrow(/cancelled/)
    }
  })

  it('resolves on a valid nonce-bearing POST /done, closes the server, refuses a second POST', async () => {
    const handle = await startPlaidLinkServer({ linkToken: 'lt' })
    const res = await postDoneWithNonce(handle.url, VALID_PAYLOAD)
    expect(res.status).toBe(200)
    await expect(handle.result).resolves.toEqual({
      publicToken: 'public-sandbox-token-1',
      institutionName: 'Chase',
      institutionId: 'ins_56',
    })
    // single-shot: the server is gone — a second POST cannot connect
    await expect(postDone(handle.url, VALID_PAYLOAD)).rejects.toThrow()
  })

  it('tolerates a missing institution in the payload', async () => {
    const handle = await startPlaidLinkServer({ linkToken: 'lt' })
    await postDoneWithNonce(handle.url, { public_token: 'pt' })
    await expect(handle.result).resolves.toEqual({
      publicToken: 'pt',
      institutionName: null,
      institutionId: null,
    })
  })

  it('rejects a forged POST without the nonce with 403 and keeps listening', async () => {
    const handle = await startPlaidLinkServer({ linkToken: 'lt' })
    const forged = await postDone(handle.url, { ...VALID_PAYLOAD, public_token: 'ATTACKER' })
    expect(forged.status).toBe(403)
    const body = (await forged.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/nonce/)

    // not settled: the legitimate flow still succeeds afterwards
    const ok = await postDoneWithNonce(handle.url, VALID_PAYLOAD)
    expect(ok.status).toBe(200)
    await expect(handle.result).resolves.toMatchObject({ publicToken: 'public-sandbox-token-1' })
  })

  it('rejects a non-loopback Host header with 403 (DNS rebinding) and keeps listening', async () => {
    const handle = await startPlaidLinkServer({ linkToken: 'lt' })
    const nonce = await fetchNonce(handle.url)
    const rebound = await rawPost(handle.url, JSON.stringify({ ...VALID_PAYLOAD, nonce }), {
      host: 'evil.example.com',
    })
    expect(rebound.status).toBe(403)
    expect(rebound.body).toMatch(/Host/)

    const wrongPort = await rawPost(handle.url, JSON.stringify({ ...VALID_PAYLOAD, nonce }), {
      host: '127.0.0.1:1',
    })
    expect(wrongPort.status).toBe(403)

    const ok = await postDone(handle.url, VALID_PAYLOAD, { [NONCE_HEADER]: nonce })
    expect(ok.status).toBe(200)
    await expect(handle.result).resolves.toMatchObject({ publicToken: 'public-sandbox-token-1' })
  })

  it('rejects a cross-origin POST (foreign Origin) with 403 even with the right nonce', async () => {
    const handle = await startPlaidLinkServer({ linkToken: 'lt' })
    const nonce = await fetchNonce(handle.url)
    const badOrigin = await postDone(handle.url, VALID_PAYLOAD, {
      [NONCE_HEADER]: nonce,
      origin: 'https://evil.example.com',
    })
    expect(badOrigin.status).toBe(403)

    const ownOrigin = `http://127.0.0.1:${new URL(handle.url).port}`
    const ok = await postDone(handle.url, VALID_PAYLOAD, {
      [NONCE_HEADER]: nonce,
      origin: ownOrigin,
    })
    expect(ok.status).toBe(200)
    await expect(handle.result).resolves.toMatchObject({ institutionName: 'Chase' })
  })

  it('rejects CORS simple-request content types (text/plain) with 415 without settling', async () => {
    const handle = await startPlaidLinkServer({ linkToken: 'lt' })
    const nonce = await fetchNonce(handle.url)
    const res = await postDone(handle.url, { ...VALID_PAYLOAD, nonce }, { 'content-type': 'text/plain' })
    expect(res.status).toBe(415)

    const ok = await postDone(handle.url, { ...VALID_PAYLOAD, nonce })
    expect(ok.status).toBe(200)
    await expect(handle.result).resolves.toMatchObject({ publicToken: 'public-sandbox-token-1' })
  })

  it('rejects an invalid payload with 400 and keeps listening for a valid one', async () => {
    const handle = await startPlaidLinkServer({ linkToken: 'lt' })
    const nonce = await fetchNonce(handle.url)
    const missingToken = await postDone(handle.url, { institution: null }, { [NONCE_HEADER]: nonce })
    expect(missingToken.status).toBe(400)
    const body = (await missingToken.json()) as { ok: boolean; error: string }
    expect(body.error).toMatch(/validation/)

    const ok = await postDone(handle.url, VALID_PAYLOAD, { [NONCE_HEADER]: nonce })
    expect(ok.status).toBe(200)
    await expect(handle.result).resolves.toMatchObject({ publicToken: 'public-sandbox-token-1' })
  })

  it('rejects the result after the timeout and closes the server', async () => {
    const handle = await startPlaidLinkServer({ linkToken: 'lt', timeoutMs: 30 })
    await expect(handle.result).rejects.toThrow(/timed out after 30 ms/)
    await expect(fetch(handle.url)).rejects.toThrow()
  })

  it('close() before success rejects with a cancellation error', async () => {
    const handle = await startPlaidLinkServer({ linkToken: 'lt' })
    handle.close()
    await expect(handle.result).rejects.toThrow(/cancelled/)
  })

  it('generates a fresh nonce per start and throws on an empty link token', async () => {
    const a = await startPlaidLinkServer({ linkToken: 'lt' })
    const b = await startPlaidLinkServer({ linkToken: 'lt' })
    try {
      expect(await fetchNonce(a.url)).not.toBe(await fetchNonce(b.url))
    } finally {
      a.close()
      b.close()
      await expect(a.result).rejects.toThrow(/cancelled/)
      await expect(b.result).rejects.toThrow(/cancelled/)
    }
    await expect(startPlaidLinkServer({ linkToken: ' ' })).rejects.toThrow(/linkToken/)
  })
})
