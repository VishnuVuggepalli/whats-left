/**
 * Settings per the design: grouped cards with label-left / control-right
 * rows — Bank feed (provider select, env badge, lifetime quota, Plaid
 * client_id + write-only secret), Sync (interval), Local AI (Ollama
 * endpoint + model + test connection), Data (export). Explicit Save keeps
 * the existing behavior; the secret is write-only and never read back.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsDto } from '../../../shared/types'
import { getApi } from '../lib/api'
import { errorMessage, useLoad } from '../lib/useLoad'
import { Banner } from '../components/Banner'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { INPUT_CLASS, INPUT_MONO_CLASS, SELECT_CLASS } from '../components/controls'
import { Pill } from '../components/Pill'
import { Skeleton } from '../components/Skeleton'
import { IconCheck, IconCheckCircle, IconDownload, IconRefresh, IconWarning } from '../components/Icons'

const api = getApi()

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; ms: number }
  | { kind: 'fail'; message: string }

export function Settings() {
  const { data, error, loading, reload } = useLoad(() => api.getSettings(), [])
  const [form, setForm] = useState<SettingsDto | null>(null)
  // write-only: sent to the main process on save, never read back
  const [plaidSecret, setPlaidSecret] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [exportState, setExportState] = useState<'idle' | 'working' | 'done'>('idle')
  const [exportPath, setExportPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const testAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (data !== null) setForm(data)
  }, [data])

  useEffect(() => () => testAbortRef.current?.abort(), [])

  const patch = (changes: Partial<SettingsDto>): void => {
    setSaved(false)
    setForm((f) => (f === null ? f : { ...f, ...changes }))
  }

  const save = async (): Promise<void> => {
    if (form === null) return
    setBusy(true)
    setSaveError(null)
    try {
      await api.updateSettings({
        provider: form.provider,
        plaidClientId: form.plaidClientId,
        syncIntervalHours: form.syncIntervalHours,
        ollamaUrl: form.ollamaUrl,
        ollamaModel: form.ollamaModel,
        ...(plaidSecret.trim() !== '' ? { plaidSecret: plaidSecret.trim() } : {}),
      })
      setPlaidSecret('')
      setSaved(true)
      reload()
    } catch (err: unknown) {
      setSaveError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const doExport = async (): Promise<void> => {
    setExportState('working')
    setSaveError(null)
    try {
      const res = await api.exportData()
      setExportPath(res.path)
      setExportState('done')
    } catch (err: unknown) {
      setSaveError(errorMessage(err))
      setExportState('idle')
    }
  }

  /** Direct reachability probe of the local Ollama endpoint (display-only). */
  const testConnection = async (): Promise<void> => {
    if (form === null) return
    testAbortRef.current?.abort()
    const controller = new AbortController()
    testAbortRef.current = controller
    const timeout = setTimeout(() => controller.abort(), 5000)
    setTest({ kind: 'testing' })
    const started = performance.now()
    try {
      const base = form.ollamaUrl.replace(/\/+$/, '')
      const res = await fetch(`${base}/api/tags`, { signal: controller.signal })
      if (!res.ok) throw new Error(`Endpoint answered HTTP ${res.status}`)
      setTest({ kind: 'ok', ms: Math.round(performance.now() - started) })
    } catch (err: unknown) {
      const message =
        controller.signal.aborted && !(err instanceof Error && err.message.includes('HTTP'))
          ? 'Timed out after 5s'
          : errorMessage(err)
      setTest({ kind: 'fail', message })
    } finally {
      clearTimeout(timeout)
    }
  }

  if (loading) return <SettingsSkeleton />

  if (error !== null) {
    return (
      <EmptyState
        tone="danger"
        icon={<IconWarning size={24} strokeWidth={1.8} />}
        title="Couldn't load settings"
        body={error}
        actions={
          <Button onClick={reload}>
            <IconRefresh size={15} />
            Retry
          </Button>
        }
      />
    )
  }

  if (form === null) return null

  return (
    <div className="mx-auto max-w-[720px] px-[30px] pt-6 pb-11">
      <SettingsGroup title="Bank feed">
        <SettingsRow label="Provider" description="Where automatic transaction syncs come from">
          <select
            className={`${SELECT_CLASS} w-[190px]`}
            value={form.provider}
            onChange={(e) => patch({ provider: e.target.value as SettingsDto['provider'] })}
            aria-label="Bank feed provider"
          >
            <option value="plaid">Plaid</option>
            <option value="teller">Teller (signup closed)</option>
          </select>
        </SettingsRow>
        <SettingsRow label="Environment" description="Which provider environment this build talks to">
          {form.provider === 'plaid' ? (
            <Pill tone={form.plaidEnv === 'production' ? 'info' : 'neutral'} dot>
              {form.plaidEnv}
            </Pill>
          ) : (
            <Pill tone={form.tellerEnv === 'development' ? 'info' : 'neutral'} dot>
              {form.tellerEnv}
            </Pill>
          )}
        </SettingsRow>
        <SettingsRow
          label={form.provider === 'plaid' ? 'Lifetime Items used' : 'Lifetime enrollments used'}
          description={
            form.provider === 'plaid' ? 'Plaid Trial plan allows 10 production Items' : 'Teller dev caps at 100'
          }
        >
          <span className="font-mono text-[13px] font-medium text-ink tabular-nums">
            {form.provider === 'plaid'
              ? form.plaidItemsUsed !== null
                ? `${form.plaidItemsUsed} / 10`
                : 'none yet'
              : form.enrollmentsUsed !== null
                ? `${form.enrollmentsUsed} / 100`
                : 'unknown'}
          </span>
        </SettingsRow>
        {form.provider === 'plaid' && (
          <>
            <SettingsRow label="Client ID" description="Safe to display — identifies your Plaid app">
              <input
                className={`${INPUT_MONO_CLASS} w-60`}
                value={form.plaidClientId ?? ''}
                onChange={(e) => patch({ plaidClientId: e.target.value.trim() === '' ? null : e.target.value })}
                aria-label="Plaid client ID"
              />
            </SettingsRow>
            <SettingsRow label="Secret" description="Write-only — stored in the OS keychain, never shown again">
              <input
                type="password"
                className={`${INPUT_MONO_CLASS} w-60`}
                value={plaidSecret}
                placeholder={form.plaidSecretSet ? '••••••• set' : 'not set'}
                onChange={(e) => {
                  setSaved(false)
                  setPlaidSecret(e.target.value)
                }}
                aria-label="Plaid secret (write-only)"
              />
            </SettingsRow>
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title="Sync">
        <SettingsRow label="Sync interval" description="How often to pull new transactions, in hours">
          <input
            type="number"
            min={1}
            max={168}
            className={`${INPUT_CLASS} w-[190px]`}
            value={form.syncIntervalHours}
            onChange={(e) => patch({ syncIntervalHours: Number(e.target.value) })}
            aria-label="Sync interval in hours"
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Local AI">
        <SettingsRow label="Endpoint" description="Local Ollama server URL">
          <input
            className={`${INPUT_MONO_CLASS} w-60`}
            value={form.ollamaUrl}
            onChange={(e) => {
              patch({ ollamaUrl: e.target.value })
              setTest({ kind: 'idle' })
            }}
            aria-label="Ollama endpoint"
          />
        </SettingsRow>
        <SettingsRow label="Model" description="Used to categorize transactions">
          <input
            className={`${INPUT_MONO_CLASS} w-60`}
            value={form.ollamaModel}
            onChange={(e) => {
              patch({ ollamaModel: e.target.value })
              setTest({ kind: 'idle' })
            }}
            aria-label="Ollama model"
          />
        </SettingsRow>
        <SettingsRow label="Connection" description="Verify the model server is reachable">
          <div className="flex items-center gap-3">
            {test.kind === 'ok' && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-pos" role="status">
                <IconCheckCircle size={14} />
                Connected · <span className="font-mono">{test.ms} ms</span>
              </span>
            )}
            {test.kind === 'testing' && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted" role="status">
                <span className="spinner h-[13px] w-[13px] border-2" aria-hidden="true" />
                Testing…
              </span>
            )}
            {test.kind === 'fail' && (
              <span className="max-w-52 truncate text-xs font-medium text-neg" role="alert" title={test.message}>
                Unreachable · {test.message}
              </span>
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={test.kind === 'testing'}
              onClick={() => void testConnection()}
            >
              Test connection
            </Button>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Data">
        <SettingsRow label="Export all data" description="Write every account, transaction and setting to JSON">
          <div className="flex items-center gap-3">
            {exportState === 'done' && exportPath !== null && (
              <span className="max-w-64 truncate font-mono text-[11.5px] font-medium text-pos" role="status" title={exportPath}>
                → {exportPath}
              </span>
            )}
            {exportState === 'working' && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted" role="status">
                <span className="spinner h-[13px] w-[13px] border-2" aria-hidden="true" />
                Preparing…
              </span>
            )}
            <Button variant="secondary" size="sm" disabled={exportState === 'working'} onClick={() => void doExport()}>
              <IconDownload size={14} />
              Export
            </Button>
          </div>
        </SettingsRow>
      </SettingsGroup>

      {saveError !== null && (
        <Banner tone="danger" className="mb-4" onDismiss={() => setSaveError(null)}>
          {saveError}
        </Banner>
      )}

      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2.5">
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save settings'}
          </Button>
          {saved && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-pos" role="status">
              <IconCheck size={12} strokeWidth={2.5} />
              Saved
            </span>
          )}
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] font-semibold text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-pos-deep" aria-hidden="true" />
          Local-first · your data stays on this device
        </span>
      </div>
    </div>
  )
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-4 rounded-xl border border-line bg-surface px-5 py-1">
      <h2 className="m-0 py-3.5 pb-3 text-[13px] font-semibold text-white">{title}</h2>
      {children}
    </section>
  )
}

function SettingsRow({
  label,
  description,
  children,
}: {
  label: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-5 border-t border-white/6 py-3.5">
      <div className="min-w-0">
        <div className="text-[13px] text-ink">{label}</div>
        <div className="mt-0.5 text-[11.5px] font-medium text-faint">{description}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">{children}</div>
    </div>
  )
}

function SettingsSkeleton() {
  return (
    <div className="mx-auto max-w-[720px] px-[30px] pt-6 pb-11" aria-busy="true" aria-label="Loading settings">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="mb-4 rounded-xl border border-line bg-surface p-[18px]">
          <Skeleton className="mb-5 h-3 w-20" />
          <div className="flex justify-between">
            <Skeleton className="h-3 w-[140px]" />
            <Skeleton className="h-8 w-[180px] rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  )
}
