import type { Clock, SecretStore } from '../core/ports'
import type { AutoLaunchApi, DialogApi, KvSecretBackend, NotifierApi, TrayApi } from './api'

export class InMemorySecretStore implements SecretStore, KvSecretBackend {
  private map = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
  async getItem(key: string): Promise<string | null> {
    return this.get(key)
  }
  async setItem(key: string, value: string): Promise<void> {
    return this.set(key, value)
  }
  async deleteItem(key: string): Promise<void> {
    return this.delete(key)
  }
}

export class FixedClock implements Clock {
  constructor(private iso: string, private ms = 0) {}
  todayIso(): string {
    return this.iso
  }
  nowMs(): number {
    return this.ms
  }
}

export class FakeTray implements TrayApi {
  tooltip = ''
  setTooltip(text: string): void {
    this.tooltip = text
  }
  onOpen(): void {}
  onQuit(): void {}
}

export class FakeDialog implements DialogApi {
  saved: Array<{ name: string; content: string }> = []
  async saveFile(defaultName: string, content: string): Promise<string | null> {
    this.saved.push({ name: defaultName, content })
    return `/fake/${defaultName}`
  }
}

export class FakeAutoLaunch implements AutoLaunchApi {
  enabled = false
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }
}

export class FakeNotifier implements NotifierApi {
  notices: Array<{ title: string; body: string }> = []
  notify(title: string, body: string): void {
    this.notices.push({ title, body })
  }
}
