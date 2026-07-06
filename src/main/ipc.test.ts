import { describe, expect, it } from 'vitest'
import type { Api } from '../shared/ipcContract'
import { API_CHANNELS, channelName } from '../shared/ipcContract'
import { registerIpc, type IpcMainLike } from './ipc'

type Listener = (event: unknown, ...args: unknown[]) => unknown

function makeFakeIpcMain(): IpcMainLike & { handlers: Map<string, Listener> } {
  const handlers = new Map<string, Listener>()
  return {
    handlers,
    handle(channel, listener) {
      if (handlers.has(channel)) throw new Error(`duplicate handler for ${channel}`)
      handlers.set(channel, listener)
    },
  }
}

/** records every call and returns a marker so routing is observable */
function makeRecordingService(): { service: Api; calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const service = Object.fromEntries(
    API_CHANNELS.map((method) => [
      method,
      (...args: unknown[]) => {
        calls.push({ method, args })
        return Promise.resolve({ from: method })
      },
    ]),
  ) as unknown as Api
  return { service, calls }
}

describe('registerIpc', () => {
  it('registers exactly one handler per frozen API channel', () => {
    const ipcMain = makeFakeIpcMain()
    registerIpc(ipcMain, makeRecordingService().service)
    expect(ipcMain.handlers.size).toBe(API_CHANNELS.length)
    for (const method of API_CHANNELS) {
      expect(ipcMain.handlers.has(channelName(method))).toBe(true)
    }
  })

  it('routes object and string arguments to the service method', async () => {
    const ipcMain = makeFakeIpcMain()
    const { service, calls } = makeRecordingService()
    registerIpc(ipcMain, service)

    const dashboard = ipcMain.handlers.get(channelName('getDashboard'))!
    await expect(dashboard({}, '2026-06')).resolves.toEqual({ from: 'getDashboard' })

    const importCsv = ipcMain.handlers.get(channelName('importCsv'))!
    const input = { accountId: 'a', fileName: 'f', content: 'c', commit: true }
    await importCsv({}, input)

    const link = ipcMain.handlers.get(channelName('linkCsvHistory'))!
    await link({}, 'csv_1', 'teller_1')

    const list = ipcMain.handlers.get(channelName('listAccounts'))!
    await list({})

    expect(calls).toEqual([
      { method: 'getDashboard', args: ['2026-06'] },
      { method: 'importCsv', args: [input] },
      { method: 'linkCsvHistory', args: ['csv_1', 'teller_1'] },
      { method: 'listAccounts', args: [] },
    ])
  })

  it('rejects non-object/string arguments before they reach the service', () => {
    const ipcMain = makeFakeIpcMain()
    const { service, calls } = makeRecordingService()
    registerIpc(ipcMain, service)
    const handler = ipcMain.handlers.get(channelName('getDashboard'))!

    expect(() => handler({}, 42)).toThrow(/argument 0/)
    expect(() => handler({}, null)).toThrow(/argument 0/)
    expect(() => handler({}, ['2026-06'])).toThrow(/argument 0/)
    expect(() => handler({}, '2026-06', {}, 'extra')).toThrow(/at most 2 arguments/)
    expect(calls).toEqual([])
  })
})
