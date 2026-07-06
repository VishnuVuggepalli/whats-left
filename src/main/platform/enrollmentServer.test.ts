import { describe, expect, it } from 'vitest'
import { startEnrollmentServer, type EnrollmentServerOpts } from './enrollmentServer'

const BASE_OPTS: EnrollmentServerOpts = {
  applicationId: 'app_test_123',
  environment: 'sandbox',
}

const VALID_PAYLOAD = {
  accessToken: 'token_abc',
  user: { id: 'usr_1' },
  enrollment: { id: 'enr_1', institution: { name: 'Chase' } },
}

async function postDone(url: string, body: unknown): Promise<Response> {
  return fetch(new URL('/done', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('startEnrollmentServer (real http round-trip on 127.0.0.1)', () => {
  it('serves the Connect page embedding cdn.teller.io connect.js and the setup opts', async () => {
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

  it('resolves on a valid POST /done, closes the server, and refuses a second POST', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)

    const res = await postDone(handle.url, VALID_PAYLOAD)
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

  it('tolerates a missing institution in the payload', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)
    await postDone(handle.url, {
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

  it('rejects an invalid payload with 400 and keeps listening for a valid one', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)

    const missingToken = await postDone(handle.url, { user: { id: 'u' }, enrollment: { id: 'e' } })
    expect(missingToken.status).toBe(400)
    const body = (await missingToken.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/validation/)

    const badJson = await postDone(handle.url, '{ not json')
    expect(badJson.status).toBe(400)

    // still alive: a valid payload now succeeds
    const ok = await postDone(handle.url, VALID_PAYLOAD)
    expect(ok.status).toBe(200)
    await expect(handle.result).resolves.toMatchObject({ enrollmentId: 'enr_1' })
  })

  it('404s unknown routes without settling the result', async () => {
    const handle = await startEnrollmentServer(BASE_OPTS)
    const res = await fetch(new URL('/nope', handle.url))
    expect(res.status).toBe(404)
    await postDone(handle.url, VALID_PAYLOAD)
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
