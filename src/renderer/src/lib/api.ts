/**
 * The renderer's single data-access seam (plan §3 invariant 2).
 *
 * In the packaged app the preload script exposes the typed IPC bridge as
 * `window.api`. When that is absent in DEV builds only (vite dev in a plain
 * browser, unit tests), an in-memory MockApi with realistic demo data stands
 * in so every screen works without the main process. In production a missing
 * bridge means the preload script failed — fail loudly instead of silently
 * rendering demo data as if it were the user's finances.
 */
import type { Api } from '../../../shared/ipcContract'
import { createMockApi } from './mockApi'

let mockSingleton: Api | null = null

/** Vite injects import.meta.env; cast because the env types are not wired into tsconfig. */
function isDevBuild(): boolean {
  return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV)
}

/** Pure resolution seam (exported for tests): mock fallback is dev-only. */
export function resolveApi(bridge: Api | undefined, isDev: boolean): Api {
  if (bridge) return bridge
  if (!isDev) {
    throw new Error('window.api bridge missing — preload failed')
  }
  // Singleton: every screen must observe the same in-memory state.
  if (mockSingleton === null) mockSingleton = createMockApi()
  return mockSingleton
}

export function getApi(): Api {
  const bridge =
    typeof window !== 'undefined' ? (window as unknown as { api?: Api }).api : undefined
  return resolveApi(bridge, isDevBuild())
}
