import { request } from 'node:http'
import { describe, expect, it } from 'vitest'
import { NONCE_HEADER, startEnrollmentServer, type EnrollmentServerOpts } from './enrollmentServer'

const BASE_OPTS: EnrollmentServerOpts = {
  applicationId: 'app_test_123',
  environment: 'sandbox',
}

const VALID_PAYLOAD = {
  accessToken: 'token_abc',
  user: { id: 'usr_1' },
  enrollment: { id: 'enr_1', institution: { name: 'Chase' } },
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

/** the nonce is only obtainable the way the real Connect page gets it: from GET / */
async function fetchNonce(url: string): Promise<string> {
  const page = await (await fetch(url)).text()
  const match = new RegExp(`'${NONCE_HEADER}': "([0-9a-f]+)"`).exec(page)
  if (!match || match[1] === undefined) throw new Error('nonce not found in served page')
  return match[1]
}

/** legitimate enrollment: read the nonce off the page, echo it on POST /done */
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

describe('startEnrollmentServer (real http round-trip on 127.0.0.1)', () => {
  it('serves the Connect page embedding cdn.teller.io connect.js, the setup opts, and the nonce', async () => {
    const handle = await startEnrollmentServer({
      ...BASE_OPTS,
      enrollmentId: 'enr_update_1',
      institution: 'chase',
    })
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      const res = await fetch(handle.url)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      const page = await res.text()
      expect(page).toContain('https://cdn.teller.io/connect/connect.js')
      expect(page).toContain('TellerConnect.setup')
      expect(page).toContain('"applicationId":"app_test_123"')
      expect(page).toContain('"environment":"sandbox"')
      expect(page).toContain('"enrollmentId":"enr_update_1"')
      expect(page).toContain('"institution":"chase"')
      expect(page).toContain("fetch('/done'")
      expect(page).toMatch(new RegExp(`'${NONCE_HEADER}': "[0-9a-f]{32}"`))
    } finally {
      handle.close()
      await expect(handle.result).rejects.toThrow(/cancelled/)
    }
  })

  it('omits enrollmentId/institution from the page when not provided (create mode)', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)
    try {
      const page = await (await fetch(handle.url)).text()
      expect(page).not.toContain('enrollmentId')
      expect(page).not.toContain('"institution"')
    } finally {
      handle.close()
      await expect(handle.result).rejects.toThrow(/cancelled/)
    }
  })

  it('generates a fresh nonce per start', async () => {
    const a = await startEnrollmentServer(BASE_OPTS)
    const b = await startEnrollmentServer(BASE_OPTS)
    try {
      expect(await fetchNonce(a.url)).not.toBe(await fetchNonce(b.url))
    } finally {
      a.close()
      b.close()
      await expect(a.result).rejects.toThrow(/cancelled/)
      await expect(b.result).rejects.toThrow(/cancelled/)
    }
  })

  it('resolves on a valid nonce-bearing POST /done, closes the server, and refuses a second POST', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)

    const res = await postDoneWithNonce(handle.url, VALID_PAYLOAD)
    expect(res.status).toBe(200)

    await expect(handle.result).resolves.toEqual({
      accessToken: 'token_abc',
      enrollmentId: 'enr_1',
      userId: 'usr_1',
      institutionName: 'Chase',
    })

    // single-shot: the server is gone — a second POST cannot connect
    await expect(postDone(handle.url, VALID_PAYLOAD)).rejects.toThrow()
  })

  it('accepts the nonce as a `nonce` field in the POST body', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)
    const nonce = await fetchNonce(handle.url)
    const res = await postDone(handle.url, { ...VALID_PAYLOAD, nonce })
    expect(res.status).toBe(200)
    await expect(handle.result).resolves.toMatchObject({ enrollmentId: 'enr_1' })
  })

  it('tolerates a missing institution in the payload', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)
    await postDoneWithNonce(handle.url, {
      accessToken: 't',
      user: { id: 'u' },
      enrollment: { id: 'e' },
    })
    await expect(handle.result).resolves.toMatchObject({
      accessToken: 't',
      enrollmentId: 'e',
      userId: 'u',
      institutionName: null,
    })
  })

  it('rejects a forged POST without the nonce with 403 and keeps listening', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)

    const forged = await postDone(handle.url, {
      ...VALID_PAYLOAD,
      accessToken: 'ATTACKER_TOKEN',
    })
    expect(forged.status).toBe(403)
    const body = (await forged.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/nonce/)

    // not settled: the legitimate enrollment still succeeds afterwards
    const ok = await postDoneWithNonce(handle.url, VALID_PAYLOAD)
    expect(ok.status).toBe(200)
    await expect(handle.result).resolves.toMatchObject({ accessToken: 'token_abc' })
  })

  it('rejects a wrong nonce with 403 without settling', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)
    const res = await postDone(handle.url, VALID_PAYLOAD, {
      [NONCE_HEADER]: 'deadbeefdeadbeefdeadbeefdeadbeef',
    })
    expect(res.status).toBe(403)

    const ok = await postDoneWithNonce(handle.url, VALID_PAYLOAD)
    expect(ok.status).toBe(200)
    await expect(handle.result).resolves.toMatchObject({ enrollmentId: 'enr_1' })
  })

  it('rejects a non-loopback Host header with 403 (DNS rebinding) and keeps listening', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)
    const nonce = await fetchNonce(handle.url)

    const rebound = await rawPost(handle.url, JSON.stringify({ ...VALID_PAYLOAD, nonce }), {
      host: 'evil.example.com',
    })
    expect(rebound.status).toBe(403)
    expect(rebound.body).toMatch(/Host/)

    // wrong port in an otherwise-loopback Host is rejected too
    const wrongPort = await rawPost(handle.url, JSON.stringify({ ...VALID_PAYLOAD, nonce }), {
      host: '127.0.0.1:1',
    })
    expect(wrongPort.status).toBe(403)

    const ok = await postDone(handle.url, VALID_PAYLOAD, { [NONCE_HEADER]: nonce })
    expect(ok.status).toBe(200)
    await expect(handle.result).resolves.toMatchObject({ accessToken: 'token_abc' })
  })

  it('refuses to serve the nonce-bearing page to a rebound Host (GET / with foreign Host → 403)', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)
    try {
      const target = new URL(handle.url)
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          {
            hostname: target.hostname,
            port: target.port,
            path: '/',
            method: 'GET',
            headers: { host: 'evil.example.com' },
          },
          (r) => {
            let data = ''
            r.on('data', (chunk: Buffer) => {
              data += chunk.toString('utf8')
            })
            r.on('end', () => resolve({ status: r.statusCode ?? 0, body: data }))
          },
        )
        req.on('error', reject)
        req.end()
      })
      expect(res.status).toBe(403)
      expect(res.body).not.toContain(NONCE_HEADER)
    } finally {
      handle.close()
      await expect(handle.result).rejects.toThrow(/cancelled/)
    }
  })

  it('rejects a cross-origin POST (foreign Origin/Referer) with 403 even with the right nonce', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)
    const nonce = await fetchNonce(handle.url)

    const badOrigin = await postDone(handle.url, VALID_PAYLOAD, {
      [NONCE_HEADER]: nonce,
      origin: 'https://evil.example.com',
    })
    expect(badOrigin.status).toBe(403)

    const badReferer = await postDone(handle.url, VALID_PAYLOAD, {
      [NONCE_HEADER]: nonce,
      referer: 'https://evil.example.com/attack.html',
    })
    expect(badReferer.status).toBe(403)

    // the server's own origin (what a real browser sends) is accepted
    const ownOrigin = `http://127.0.0.1:${new URL(handle.url).port}`
    const ok = await postDone(handle.url, VALID_PAYLOAD, {
      [NONCE_HEADER]: nonce,
      origin: ownOrigin,
      referer: `${ownOrigin}/`,
    })
    expect(ok.status).toBe(200)
    await expect(handle.result).resolves.toMatchObject({ enrollmentId: 'enr_1' })
  })

  it('rejects CORS simple-request content types (text/plain) with 415 without settling', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)
    const nonce = await fetchNonce(handle.url)

    const res = await postDone(handle.url, { ...VALID_PAYLOAD, nonce }, {
      'content-type': 'text/plain',
    })
    expect(res.status).toBe(415)

    const ok = await postDone(handle.url, { ...VALID_PAYLOAD, nonce })
    expect(ok.status).toBe(200)
    await expect(handle.result).resolves.toMatchObject({ enrollmentId: 'enr_1' })
  })

  it('rejects an invalid payload with 400 and keeps listening for a valid one', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)
    const nonce = await fetchNonce(handle.url)

    const missingToken = await postDone(
      handle.url,
      { user: { id: 'u' }, enrollment: { id: 'e' } },
      { [NONCE_HEADER]: nonce },
    )
    expect(missingToken.status).toBe(400)
    const body = (await missingToken.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/validation/)

    const badJson = await postDone(handle.url, '{ not json', { [NONCE_HEADER]: nonce })
    expect(badJson.status).toBe(400)

    // still alive: a valid payload now succeeds
    const ok = await postDone(handle.url, VALID_PAYLOAD, { [NONCE_HEADER]: nonce })
    expect(ok.status).toBe(200)
    await expect(handle.result).resolves.toMatchObject({ enrollmentId: 'enr_1' })
  })

  it('404s unknown routes without settling the result', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)
    const res = await fetch(new URL('/nope', handle.url))
    expect(res.status).toBe(404)
    await postDoneWithNonce(handle.url, VALID_PAYLOAD)
    await expect(handle.result).resolves.toMatchObject({ accessToken: 'token_abc' })
  })

  it('rejects the result after the timeout and closes the server', async () => {
    const handle = await startEnrollmentServer({ ...BASE_OPTS, timeoutMs: 30 })
    await expect(handle.result).rejects.toThrow(/timed out after 30 ms/)
    await expect(fetch(handle.url)).rejects.toThrow()
  })

  it('close() before success rejects with a cancellation error', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)
    handle.close()
    await expect(handle.result).rejects.toThrow(/cancelled/)
  })

  it('throws on an empty applicationId', async () => {
    await expect(startEnrollmentServer({ ...BASE_OPTS, applicationId: ' ' })).rejects.toThrow(
      /applicationId/,
    )
  })
})
