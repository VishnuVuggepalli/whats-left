/**
 * Import per the design: drop zone (empty state) → 3-step wizard —
 * 1 Detect file (header-sniffed format fact, never the filename),
 * 2 Choose account (REQUIRED create-or-select — CSVs carry no identity),
 * 3 Review & import (dry-run stat tiles incl. the uncategorized count,
 * destination banner, warnings) → commit → success panel.
 */
import { useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import type { ImportReport, Institution } from '../../../shared/types'
import type { TabId } from '../App'
import { getApi } from '../lib/api'
import { parseMockCsv } from '../lib/mockCsv'
import type { MockCsvFormat } from '../lib/mockCsv'
import { errorMessage, useLoad } from '../lib/useLoad'
import { Banner } from '../components/Banner'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { INPUT_CLASS, SELECT_CLASS } from '../components/controls'
import {
  IconArrowRight,
  IconCheck,
  IconCheckCircle,
  IconChevronRight,
  IconDownload,
  IconFileBroken,
  IconFileText,
  IconPlus,
  IconWarning,
} from '../components/Icons'

const api = getApi()

const FORMAT_LABEL: Record<MockCsvFormat | ImportReport['format'], string> = {
  chase_checking: 'Chase checking CSV',
  chase_credit: 'Chase credit card CSV',
  amex_extended: 'Amex extended CSV',
  amex_basic: 'Amex basic CSV',
}

interface PickedFile {
  fileName: string
  content: string
  /** header-sniffed preview; null when the header isn't recognized yet */
  detected: { format: MockCsvFormat; rowCount: number } | null
}

const STEPS = [
  { n: 1, label: 'Detect file' },
  { n: 2, label: 'Choose account' },
  { n: 3, label: 'Review & import' },
] as const

export interface ImportProps {
  go: (tab: TabId) => void
}

export function Import({ go }: ImportProps) {
  const accountsLoad = useLoad(() => api.listAccounts(), [])
  const [file, setFile] = useState<PickedFile | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [accountId, setAccountId] = useState('')
  const [newName, setNewName] = useState('')
  const [newMask, setNewMask] = useState('')
  const [newInstitution, setNewInstitution] = useState<Institution>('chase')
  const [newType, setNewType] = useState<'depository' | 'credit'>('credit')
  const [resolvedTarget, setResolvedTarget] = useState<{ id: string; name: string } | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [committed, setCommitted] = useState<ImportReport | null>(null)
  const [apiError, setApiError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const accounts = accountsLoad.data ?? []

  const reset = (): void => {
    setFile(null)
    setFileError(null)
    setStep(1)
    setMode('existing')
    setAccountId('')
    setNewName('')
    setNewMask('')
    setResolvedTarget(null)
    setReport(null)
    setCommitted(null)
    setApiError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const readFile = (picked: File): void => {
    setFileError(null)
    setApiError(null)
    const reader = new FileReader()
    reader.onerror = () => setFileError(`${picked.name} could not be read.`)
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        setFileError(`${picked.name} could not be read as text.`)
        return
      }
      const content = reader.result
      // Display-only header sniff — the authoritative detection happens in
      // the dry run. An unrecognized header is not an error yet.
      let detected: PickedFile['detected'] = null
      try {
        const parsed = parseMockCsv(content)
        detected = { format: parsed.format, rowCount: parsed.rows.length }
      } catch {
        detected = null
      }
      setFile({ fileName: picked.name, content, detected })
      setStep(1)
    }
    reader.readAsText(picked)
  }

  const onFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const picked = e.target.files?.[0]
    if (picked) readFile(picked)
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    const picked = e.dataTransfer.files?.[0]
    if (picked) readFile(picked)
  }

  /** Account attribution is explicit (plan §5b): create-or-select is REQUIRED. */
  const resolveTarget = async (): Promise<{ id: string; name: string }> => {
    if (resolvedTarget !== null) return resolvedTarget
    if (mode === 'existing') {
      const acct = accounts.find((a) => a.id === accountId)
      if (acct === undefined) throw new Error('Select the target account before importing.')
      return { id: acct.id, name: acct.name }
    }
    if (newName.trim() === '') throw new Error('Name the new account before importing.')
    const created = await api.createCsvAccount({
      name: newName.trim(),
      institution: newInstitution,
      type: newType,
      ...(newMask.trim() !== '' ? { mask: newMask.trim() } : {}),
    })
    accountsLoad.reload()
    return { id: created.id, name: created.name }
  }

  /** Step 2 → 3: resolve the account, then dry-run. Nothing is written. */
  const runDryRun = async (): Promise<void> => {
    if (file === null) return
    setBusy(true)
    setApiError(null)
    try {
      const target = await resolveTarget()
      setResolvedTarget(target)
      if (mode === 'new') {
        // The account now exists — flip to "existing" so Back/retry can't create a duplicate.
        setMode('existing')
        setAccountId(target.id)
      }
      const result = await api.importCsv({
        accountId: target.id,
        fileName: file.fileName,
        content: file.content,
        commit: false,
      })
      setReport(result)
      setStep(3)
    } catch (err: unknown) {
      setApiError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const runCommit = async (): Promise<void> => {
    if (file === null || resolvedTarget === null) return
    setBusy(true)
    setApiError(null)
    try {
      const result = await api.importCsv({
        accountId: resolvedTarget.id,
        fileName: file.fileName,
        content: file.content,
        commit: true,
      })
      setCommitted(result)
    } catch (err: unknown) {
      setApiError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (fileError !== null) {
    return (
      <EmptyState
        tone="danger"
        icon={<IconFileBroken size={24} strokeWidth={1.8} />}
        title="We couldn't read that file"
        body={
          <>
            {fileError} Export your statement as CSV from your bank's website, then try again.
          </>
        }
        actions={<Button onClick={reset}>Choose a different file</Button>}
      />
    )
  }

  if (accountsLoad.loading) {
    return (
      <div
        className="flex min-h-[520px] flex-col items-center justify-center p-10 text-center"
        aria-busy="true"
        role="status"
      >
        <div className="spinner mb-5 h-[34px] w-[34px]" aria-hidden="true" />
        <div className="text-[15px] font-semibold text-white">Loading your accounts…</div>
      </div>
    )
  }

  if (accountsLoad.error !== null) {
    return (
      <EmptyState
        tone="danger"
        icon={<IconWarning size={24} strokeWidth={1.8} />}
        title="Couldn't load your accounts"
        body={accountsLoad.error}
        actions={<Button onClick={accountsLoad.reload}>Retry</Button>}
      />
    )
  }

  if (committed !== null) {
    return (
      <EmptyState
        tone="success"
        icon={<IconCheck size={26} strokeWidth={2} />}
        title={`Imported ${committed.newCount} transaction${committed.newCount === 1 ? '' : 's'}`}
        body={
          <>
            Added to <span className="font-mono text-ink-dim">{committed.accountName}</span>.{' '}
            <span className="font-mono">{committed.skippedDuplicates + committed.matchedCount}</span> already-known
            row{committed.skippedDuplicates + committed.matchedCount === 1 ? ' was' : 's were'} skipped.
            {committed.uncategorized > 0 && (
              <>
                {' '}
                <span className="font-mono">{committed.uncategorized}</span> need
                {committed.uncategorized === 1 ? 's' : ''} review.
              </>
            )}
          </>
        }
        actions={
          <>
            <Button onClick={() => go(committed.uncategorized > 0 ? 'review' : 'transactions')}>
              {committed.uncategorized > 0 ? 'Review uncategorized' : 'View transactions'}
            </Button>
            <Button variant="secondary" onClick={reset}>
              Import another file
            </Button>
          </>
        }
      />
    )
  }

  if (file === null) {
    return (
      <div className="mx-auto flex min-h-[480px] max-w-[620px] flex-col items-center justify-center px-[30px] py-10">
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`w-full rounded-2xl border-2 border-dashed bg-inset px-[30px] py-12 text-center transition-colors ${
            dragOver ? 'border-accent/60' : 'border-white/14'
          }`}
        >
          <div className="mx-auto mb-5 flex h-[54px] w-[54px] items-center justify-center rounded-[14px] border border-line bg-surface text-accent">
            <IconDownload size={24} strokeWidth={1.8} />
          </div>
          <div className="mb-2 text-base font-semibold text-white">Drop a CSV to import</div>
          <div className="mx-auto mb-5 max-w-[340px] text-[13px] leading-relaxed text-muted">
            Drag a statement here, or browse. We recognize Chase and Amex CSV exports automatically — from the
            file's header, never its name.
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={onFileChange}
            className="sr-only"
            aria-label="CSV file"
          />
          <Button onClick={() => fileInputRef.current?.click()}>Browse files</Button>
        </div>
      </div>
    )
  }

  const canContinue = step === 1 || (step === 2 && (mode === 'existing' ? accountId !== '' : newName.trim() !== ''))

  return (
    <div className="mx-auto max-w-[620px] px-[30px] pt-[26px] pb-11">
      <ol className="m-0 mb-7 flex list-none items-center p-0" aria-label="Import steps">
        {STEPS.map((s) => {
          const state = step > s.n ? 'done' : step === s.n ? 'current' : 'todo'
          return (
            <li key={s.n} className={`flex items-center ${s.n < 3 ? 'flex-1' : 'flex-none'}`}>
              <div className="flex shrink-0 items-center gap-2.5" aria-current={state === 'current' ? 'step' : undefined}>
                <div
                  className={`flex h-7 w-7 items-center justify-center rounded-full border-[1.5px] font-mono text-xs font-semibold ${
                    state === 'current'
                      ? 'border-accent bg-accent text-white'
                      : state === 'done'
                        ? 'border-pos-deep/40 bg-pos-deep/18 text-pos'
                        : 'border-white/14 bg-deep text-ghost'
                  }`}
                >
                  {state === 'done' ? <IconCheck size={14} strokeWidth={2.5} /> : s.n}
                </div>
                <span className={`text-[12.5px] font-semibold ${state === 'todo' ? 'text-ghost' : 'text-ink'}`}>
                  {s.label}
                </span>
              </div>
              {s.n < 3 && <div className="mx-3 h-[1.5px] min-w-5 flex-1 bg-white/10" aria-hidden="true" />}
            </li>
          )
        })}
      </ol>

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {step === 1 && (
          <div className="p-[22px]">
            <div className="mb-1 text-[15px] font-semibold text-white">Detected file</div>
            <div className="mb-[18px] text-xs font-medium text-faint">
              We read the file's headers to identify its format — no import happens yet.
            </div>
            <div className="flex items-center gap-3.5 rounded-[10px] border border-line bg-deep p-4">
              <div className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[9px] bg-accent/12 text-[#60A5FA]">
                <IconFileText size={20} strokeWidth={1.8} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px] font-medium text-ink">{file.fileName}</div>
                {file.detected !== null ? (
                  <div className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-pos">
                    <IconCheckCircle size={14} />
                    {FORMAT_LABEL[file.detected.format]} · <span className="font-mono">{file.detected.rowCount}</span>{' '}
                    rows
                  </div>
                ) : (
                  <div className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-warn">
                    <IconWarning size={14} />
                    Header not recognized yet — the dry run will validate it
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="p-[22px]">
            <div className="mb-1 text-[15px] font-semibold text-white">Which account is this?</div>
            <div className="mb-[18px] text-xs font-medium text-faint">
              Required — pick the account these transactions belong to. We won't guess for you.
            </div>
            <div className="flex flex-col gap-2" role="radiogroup" aria-label="Target account">
              {accounts.map((a) => {
                const picked = mode === 'existing' && accountId === a.id
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={picked}
                    onClick={() => {
                      setMode('existing')
                      setAccountId(a.id)
                    }}
                    className={`flex w-full cursor-pointer items-center gap-3 rounded-[10px] border-[1.5px] px-3.5 py-3 text-left transition-colors hover:border-accent/50 ${
                      picked ? 'border-accent bg-accent/8' : 'border-white/14 bg-transparent'
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-[1.5px] ${
                        picked ? 'border-accent' : 'border-white/14'
                      }`}
                      aria-hidden="true"
                    >
                      {picked && <span className="h-2 w-2 rounded-full bg-accent" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-ink">{a.name}</span>
                      <span className="mt-0.5 block font-mono text-[11px] font-medium text-faint">
                        {a.mask !== null ? `••${a.mask}` : a.sourceKind === 'csv_only' ? 'CSV account' : 'bank feed'}
                      </span>
                    </span>
                  </button>
                )
              })}
              <button
                type="button"
                onClick={() => setMode(mode === 'new' ? 'existing' : 'new')}
                aria-expanded={mode === 'new'}
                className={`flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] border-[1.5px] border-dashed px-3.5 py-3 text-left text-[13px] font-semibold transition-colors ${
                  mode === 'new'
                    ? 'border-accent/60 text-ink'
                    : 'border-white/14 text-muted hover:border-white/28 hover:text-ink'
                }`}
              >
                <IconPlus size={16} />
                Create a new account
              </button>
              {mode === 'new' && (
                <div className="grid grid-cols-2 gap-2 rounded-[10px] border border-line bg-deep p-3.5">
                  <input
                    className={INPUT_CLASS}
                    placeholder="Account name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    aria-label="New account name"
                  />
                  <input
                    className={INPUT_CLASS}
                    placeholder="Mask (last 4, optional)"
                    value={newMask}
                    onChange={(e) => setNewMask(e.target.value)}
                    aria-label="New account mask"
                  />
                  <select
                    className={SELECT_CLASS}
                    value={newInstitution}
                    onChange={(e) => setNewInstitution(e.target.value as Institution)}
                    aria-label="New account institution"
                  >
                    <option value="chase">Chase</option>
                    <option value="amex">American Express</option>
                    <option value="other">Other bank</option>
                  </select>
                  <select
                    className={SELECT_CLASS}
                    value={newType}
                    onChange={(e) => setNewType(e.target.value as 'depository' | 'credit')}
                    aria-label="New account type"
                  >
                    <option value="credit">Credit card</option>
                    <option value="depository">Checking / savings</option>
                  </select>
                </div>
              )}
            </div>
          </div>
        )}

        {step === 3 && report !== null && (
          <div className="p-[22px]">
            <div className="mb-1 text-[15px] font-semibold text-white">Review before importing</div>
            <div className="mb-[18px] text-xs font-medium text-faint">
              This is a dry run · {FORMAT_LABEL[report.format]} · nothing is written until you confirm.
            </div>
            <div className="mb-4 flex gap-2.5">
              <StatTile value={report.newCount} label="new" tone={report.newCount > 0 ? 'pos' : 'muted'} />
              <StatTile value={report.matchedCount + report.skippedDuplicates} label="already known" tone="muted" />
              <StatTile
                value={report.uncategorized}
                label="need review"
                tone={report.uncategorized > 0 ? 'warn' : 'muted'}
              />
            </div>
            <Banner tone="info" className="mb-3.5" icon={<IconArrowRight size={15} />}>
              <span className="font-mono text-white">{report.newCount}</span> new transaction
              {report.newCount === 1 ? '' : 's'} →{' '}
              <span className="font-mono text-white">{resolvedTarget?.name ?? report.accountName}</span>
            </Banner>
            {report.warnings.map((w) => (
              <Banner key={w} tone="warn" className="mb-2.5">
                {w}
              </Banner>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2.5 border-t border-white/7 bg-white/2 px-[22px] py-3.5">
          <Button variant="ghost" size="sm" disabled={busy} onClick={reset}>
            Cancel
          </Button>
          <div className="flex-1" />
          {apiError !== null && (
            <p role="alert" className="m-0 mr-1 text-xs text-neg">
              {apiError}
            </p>
          )}
          {step > 1 && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setApiError(null)
                if (step === 3) {
                  setReport(null)
                  setResolvedTarget(null)
                }
                setStep(step === 3 ? 2 : 1)
              }}
            >
              Back
            </Button>
          )}
          {step === 1 && (
            <Button size="sm" onClick={() => setStep(2)}>
              Continue
              <IconChevronRight size={14} />
            </Button>
          )}
          {step === 2 && (
            <Button size="sm" disabled={!canContinue || busy} onClick={() => void runDryRun()}>
              {busy ? 'Running dry run…' : 'Continue'}
              {!busy && <IconChevronRight size={14} />}
            </Button>
          )}
          {step === 3 && report !== null && (
            <Button size="sm" disabled={busy || report.newCount === 0} onClick={() => void runCommit()}>
              <IconCheck size={14} />
              {busy
                ? 'Importing…'
                : `Import ${report.newCount} transaction${report.newCount === 1 ? '' : 's'}`}
            </Button>
          )}
        </div>
      </div>

      {step === 3 && report !== null && report.newCount === 0 && (
        <p className="mt-3 text-xs text-faint">
          Nothing new to import — every row in this file is already known.
        </p>
      )}
    </div>
  )
}

function StatTile({ value, label, tone }: { value: number; label: string; tone: 'pos' | 'warn' | 'muted' }) {
  const valueClass = tone === 'pos' ? 'text-pos' : tone === 'warn' ? 'text-warn' : 'text-muted'
  return (
    <div className="flex-1 rounded-[10px] border border-line bg-deep p-3.5 text-center">
      <div className={`font-mono text-[26px] font-bold ${valueClass}`}>{value}</div>
      <div className="mt-0.5 text-[11px] font-medium text-muted">{label}</div>
    </div>
  )
}
