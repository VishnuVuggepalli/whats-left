import type { Api } from '../shared/ipcContract'
import { API_CHANNELS, channelName } from '../shared/ipcContract'

/**
 * IPC registration: one ipcMain.handle per frozen API channel, forwarding the
 * renderer's arguments to the AppService method of the same name. A zod-light
 * runtime guard rejects anything that is not a plain object, string, or
 * undefined before it reaches the service (plan §3 invariant 2: the renderer
 * only ever speaks the repository interface).
 */

/** the ipcMain slice we use — injectable so registration tests need no electron */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

const MAX_ARGS = 2 // widest Api method (linkCsvHistory, resolveReview) takes 2

export function registerIpc(ipcMain: IpcMainLike, service: Api): void {
  for (const method of API_CHANNELS) {
    ipcMain.handle(channelName(method), (_event, ...args) => {
      assertValidArgs(method, args)
      const fn = service[method] as (...fnArgs: unknown[]) => unknown
      return fn.apply(service, args)
    })
  }
}

function assertValidArgs(method: string, args: readonly unknown[]): void {
  if (args.length > MAX_ARGS) {
    throw new Error(`ipc ${method}: expected at most ${MAX_ARGS} arguments, got ${args.length}`)
  }
  for (const [index, arg] of args.entries()) {
    if (!isValidArg(arg)) {
      throw new Error(
        `ipc ${method}: argument ${index} must be a plain object, string, or undefined`,
      )
    }
  }
}

function isValidArg(arg: unknown): boolean {
  if (arg === undefined || typeof arg === 'string') return true
  return typeof arg === 'object' && arg !== null && !Array.isArray(arg)
}
