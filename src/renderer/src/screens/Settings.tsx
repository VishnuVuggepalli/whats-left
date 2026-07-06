import { useEffect, useState } from 'react'
import type { SettingsDto } from '../../../shared/types'
import { getApi } from '../lib/api'
import { errorMessage, useLoad } from '../lib/useLoad'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card } from '../components/Card'

const api = getApi()

const INPUT_CLASS =
  'w-full rounded-md border border-line bg-raised px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none'

export function Settings() {
  const { data, error, loading, reload } = useLoad(() => api.getSettings(), [])
  const [form, setForm] = useState<SettingsDto | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [exportPath, setExportPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (data !== null) setForm(data)
  }, [data])

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
        syncIntervalHours: form.syncIntervalHours,
        ollamaUrl: form.ollamaUrl,
        ollamaModel: form.ollamaModel,
      })
      setSaved(true)
      reload()
    } catch (err: unknown) {
      setSaveError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const doExport = async (): Promise<void> => {
    setBusy(true)
    setSaveError(null)
    try {
      const res = await api.exportData()
      setExportPath(res.path)
    } catch (err: unknown) {
      setSaveError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-lg font-semibold">Settings</h1>
      {error !== null && <p className="text-neg">Failed to load settings: {error}</p>}
      {loading && <p className="text-muted">Loading settings…</p>}

      {form !== null && (
        <>
          <Card title="Teller">
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-dim">Environment</span>
              <Badge tone={form.tellerEnv === 'development' ? 'info' : 'neutral'}>{form.tellerEnv}</Badge>
            </div>
            <div className="mt-2 flex items-center justify-between text-sm">
              <span className="text-ink-dim">Lifetime enrollments used</span>
              <span className="tabular-nums">
                {form.enrollmentsUsed !== null ? `${form.enrollmentsUsed} / 100` : 'unknown'}
              </span>
            </div>
            <label className="mt-3 block text-sm">
              <span className="text-ink-dim">Sync interval (hours)</span>
              <input
                type="number"
                min={1}
                max={168}
                className={`${INPUT_CLASS} mt-1`}
                value={form.syncIntervalHours}
                onChange={(e) => patch({ syncIntervalHours: Number(e.target.value) })}
              />
            </label>
          </Card>

          <Card title="Ollama (local categorizer)">
            <label className="block text-sm">
              <span className="text-ink-dim">Endpoint</span>
              <input
                className={`${INPUT_CLASS} mt-1`}
                value={form.ollamaUrl}
                onChange={(e) => patch({ ollamaUrl: e.target.value })}
              />
            </label>
            <label className="mt-3 block text-sm">
              <span className="text-ink-dim">Model</span>
              <input
                className={`${INPUT_CLASS} mt-1`}
                value={form.ollamaModel}
                onChange={(e) => patch({ ollamaModel: e.target.value })}
              />
            </label>
          </Card>

          <div className="flex items-center gap-2">
            <Button disabled={busy} onClick={() => void save()}>
              Save settings
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void doExport()}>
              Export all data
            </Button>
            {saved && <Badge tone="ok">saved</Badge>}
          </div>
          {saveError !== null && <p className="text-sm text-neg">{saveError}</p>}
          {exportPath !== null && (
            <p className="text-sm text-muted">
              Exported to <span className="text-ink">{exportPath}</span>
            </p>
          )}
        </>
      )}
    </div>
  )
}
