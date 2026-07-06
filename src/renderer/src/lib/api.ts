/**
 * The renderer's single data-access seam (plan §3 invariant 2).
 *
 * In the packaged app the preload script exposes the typed IPC bridge as
 * `window.api`. When that is absent (vite dev in a plain browser, unit
 * tests), an in-memory MockApi with realistic demo data stands in so every
 * screen works without the main process.
 */
import type { Api } from '../../../shared/ipcContract'
import { createMockApi } from './mockApi'

let mockSingleton: Api | null = null

export function getApi(): Api {
  if (typeof window !== 'undefined') {
    const injected = (window as unknown as { api?: Api }).api
    if (injected) return injected
  }
  // Singleton: every screen must observe the same in-memory state.
  if (mockSingleton === null) mockSingleton = createMockApi()
  return mockSingleton
}
