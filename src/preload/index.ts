import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../shared/ipcContract'
import { API_CHANNELS, channelName } from '../shared/ipcContract'

/**
 * Preload bridge (plan §3): expose the typed repository API as window.api.
 * Built by iterating the frozen channel list so preload can never drift from
 * the contract — a new Api method fails compilation here, not at runtime.
 */

const api = Object.fromEntries(
  API_CHANNELS.map((method) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke(channelName(method), ...args),
  ]),
) as unknown as Api

contextBridge.exposeInMainWorld('api', api)
