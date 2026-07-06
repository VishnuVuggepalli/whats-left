import { afterEach, describe, expect, it } from 'vitest'
import type { Api } from '../../../shared/ipcContract'
import { API_CHANNELS } from '../../../shared/ipcContract'
import { getApi, resolveApi } from './api'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['window']
})

describe('getApi', () => {
  it('returns the preload-injected window.api when present', () => {
    const sentinel = { listAccounts: async () => [] } as unknown as Api
    ;(globalThis as Record<string, unknown>)['window'] = { api: sentinel }
    expect(getApi()).toBe(sentinel)
  })

  it('falls back to the in-memory mock when window.api is absent (vite dev in browser)', async () => {
    ;(globalThis as Record<string, unknown>)['window'] = {}
    const api = getApi()
    const accounts = await api.listAccounts()
    expect(accounts.length).toBeGreaterThan(0)
  })

  it('falls back to the mock when window itself is undefined (node tests)', async () => {
    const api = getApi()
    expect((await api.listCategories()).length).toBeGreaterThan(0)
  })

  it('throws loudly in production builds when window.api is missing (no silent demo data)', () => {
    expect(() => resolveApi(undefined, false)).toThrow(
      /window\.api bridge missing — preload failed/,
    )
  })

  it('still returns the preload-injected bridge in production builds', () => {
    const sentinel = { listAccounts: async () => [] } as unknown as Api
    expect(resolveApi(sentinel, false)).toBe(sentinel)
  })

  it('only falls back to the mock when the build is dev', async () => {
    const api = resolveApi(undefined, true)
    expect((await api.listAccounts()).length).toBeGreaterThan(0)
  })

  it('mock implements every method of the Api contract', () => {
    const api = getApi() as unknown as Record<string, unknown>
    for (const method of API_CHANNELS) {
      expect(typeof api[method], `missing Api method: ${method}`).toBe('function')
    }
  })
})
