import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import type { SettingsDto } from '../shared/types'
import type { Clock } from './core/ports'
import { openDb, runMigrations } from './db/db'
import { SqliteRepo } from './db/repository'
import { seedTaxonomy } from './db/seed'
import { registerIpc } from './ipc'
import type { DialogApi } from './platform/api'
import { startEnrollmentServer } from './platform/enrollmentServer'
import { SafeStorageSecretStore } from './platform/secrets'
import { AppService, SETTINGS_DEFAULTS, SETTINGS_KEY } from './services/appService'
import {
  createTellerClientFactory,
  loadDevSecrets,
  makeLlmFromSettings,
  withDevTokenFallback,
} from './services/wiring'

// Electron bootstrap — the ONLY module besides platform/ that touches
// electron APIs (plan §3 invariant 3). All logic lives in AppService.

const systemClock: Clock = {
  todayIso: () => {
    const now = new Date()
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    return `${now.getFullYear()}-${mm}-${dd}`
  },
  nowMs: () => Date.now(),
}

function makeDialogApi(getWindow: () => BrowserWindow | null): DialogApi {
  return {
    async saveFile(defaultName, content) {
      const win = getWindow()
      const opts = { defaultPath: defaultName }
      const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (result.canceled || result.filePath === undefined || result.filePath === '') return null
      writeFileSync(result.filePath, content, 'utf8')
      return result.filePath
    },
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  return win
}

function setupTray(win: BrowserWindow, service: AppService): Tray {
  let quitting = false
  app.on('before-quit', () => {
    quitting = true
  })
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      win.hide() // close-to-hide: the tray keeps the app alive (plan phase 5)
    }
  })
  const tray = new Tray(nativeImage.createEmpty())
  tray.setToolTip('whats-left')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open whats-left', click: () => win.show() },
      { label: 'Sync now', click: () => void service.syncNow().catch(logError('tray sync')) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  )
  tray.on('double-click', () => win.show())
  return tray
}

const logError = (context: string) => (err: unknown) =>
  console.error(`[whats-left] ${context}:`, err)

/**
 * Re-armable sync scheduler: arm() replaces the interval so a settings change
 * (updateSettings → onSettingsChanged) takes effect immediately — no restart.
 */
function makeScheduler(service: AppService): { arm: (settings: SettingsDto) => void } {
  let timer: NodeJS.Timeout | null = null
  return {
    arm: (settings) => {
      if (timer !== null) clearInterval(timer)
      const intervalMs = settings.syncIntervalHours * 60 * 60 * 1000
      timer = setInterval(() => void service.syncNow().catch(logError('scheduled sync')), intervalMs)
    },
  }
}

async function main(): Promise<void> {
  await app.whenReady()
  const userData = app.getPath('userData')
  const db = openDb(join(userData, 'whatsleft.db'))
  // dev runs from a bundle — resolve the migrations dir from the project root
  runMigrations(db, app.isPackaged ? undefined : join(process.cwd(), 'src/main/db/migrations'))
  seedTaxonomy(db)
  const repo = new SqliteRepo(db)

  const devSecrets = app.isPackaged ? null : loadDevSecrets(process.cwd())
  const secrets = withDevTokenFallback(
    new SafeStorageSecretStore({
      filePath: join(userData, 'secrets.json'),
      env: () =>
        repo.getSetting<Partial<SettingsDto>>(SETTINGS_KEY)?.tellerEnv ?? SETTINGS_DEFAULTS.tellerEnv,
    }),
    devSecrets,
  )

  let win: BrowserWindow | null = null
  // assigned after the service exists; the callback tolerates the gap
  let rearmScheduler: ((settings: SettingsDto) => void) | null = null
  const service = new AppService({
    repo,
    secrets,
    clock: systemClock,
    dialog: makeDialogApi(() => win),
    makeLlm: makeLlmFromSettings,
    makeTellerClient: createTellerClientFactory(devSecrets),
    startEnrollmentServer,
    openExternal: (url) => shell.openExternal(url),
    getApplicationId: async () => {
      const fromEnv = process.env['TELLER_APPLICATION_ID']
      if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
      const stored = await secrets.get('teller:applicationId')
      if (stored !== null) return stored
      throw new Error('Teller application id not configured (set TELLER_APPLICATION_ID)')
    },
    onSettingsChanged: (settings) => rearmScheduler?.(settings),
  })

  registerIpc(ipcMain, service)
  win = createWindow()
  setupTray(win, service)
  const scheduler = makeScheduler(service)
  rearmScheduler = scheduler.arm
  scheduler.arm(await service.getSettings())

  app.on('window-all-closed', () => {}) // tray app: stay alive with no windows
  app.on('activate', () => win?.show())
}

void main().catch((err: unknown) => {
  logError('fatal startup error')(err)
  app.exit(1)
})
