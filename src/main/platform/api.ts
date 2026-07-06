/**
 * Thin interfaces over every Electron API we touch, so core/main logic is
 * unit-testable with fakes (plan §9: harness decided before modules).
 */

export interface KvSecretBackend {
  /** returns ciphertext-at-rest impl detail; callers see plaintext */
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  deleteItem(key: string): Promise<void>
}

export interface TrayApi {
  setTooltip(text: string): void
  onOpen(cb: () => void): void
  onQuit(cb: () => void): void
}

export interface DialogApi {
  saveFile(defaultName: string, content: string): Promise<string | null>
}

export interface AutoLaunchApi {
  setEnabled(enabled: boolean): void
}

export interface NotifierApi {
  notify(title: string, body: string): void
}
