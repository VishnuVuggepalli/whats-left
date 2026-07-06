import { useState } from 'react'
import type { ChangeEvent } from 'react'
import type { ImportReport, Institution } from '../../../shared/types'
import { getApi } from '../lib/api'
import { errorMessage, useLoad } from '../lib/useLoad'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card } from '../components/Card'

const api = getApi()

const INPUT_CLASS =
  'rounded-md border border-line bg-raised px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none'

interface FilePick {
  fileName: string
  content: string
}

export function Import() {
  const accountsLoad = useLoad(() => api.listAccounts(), [])
  const [file, setFile] = useState<FilePick | null>(null)
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [accountId, setAccountId] = useState('')
  const [newName, setNewName] = useState('')
  const [newInstitution, setNewInstitution] = useState<Institution>('chase')
  const [newType, setNewType] = useState<'depository' | 'credit'>('credit')
  const [newMask, setNewMask] = useState('')
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setReport(null)
    setError(null)
    const picked = e.target.files?.[0]
    if (!picked) {
      setFile(null)
      return
    }
    const reader = new FileReader()
    reader.onerror = () => setError(`Could not read ${picked.name}`)
    reader.onload = () => {
      if (typeof reader.result === 'string') setFile({ fileName: picked.name, content: reader.result })
      else setError(`Could not read ${picked.name} as text`)
    }
    reader.readAsText(picked)
  }

  /** Account attribution is explicit (plan §5b): create-or-select is REQUIRED. */
  const resolveAccountId = async (): Promise<string> => {
    if (mode === 'existing') {
      if (accountId === '') throw new Error('Select the target account before importing.')
      return accountId
    }
    if (newName.trim() === '') throw new Error('Name the new account before importing.')
    const created = await api.createCsvAccount({
      name: newName.trim(),
      institution: newInstitution,
      type: newType,
      ...(newMask.trim() !== '' ? { mask: newMask.trim() } : {}),
    })
    setMode('existing')
    setAccountId(created.id)
    accountsLoad.reload()
    return created.id
  }

  const runImport = async (commit: boolean): Promise<void> => {
    if (file === null) {
      setError('Choose a CSV file first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const target = await resolveAccountId()
      const result = await api.importCsv({ accountId: target, fileName: file.fileName, content: file.content, commit })
      setReport(result)
    } catch (err: unknown) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const accounts = accountsLoad.data ?? []

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-lg font-semibold">Import CSV</h1>

      <Card title="1 · Choose a bank export">
        <input type="file" accept=".csv,text/csv" onChange={onFileChange} className="text-sm" aria-label="CSV file" />
        {file !== null && (
          <p className="mt-2 text-xs text-muted">
            {file.fileName} · {file.content.split('\n').length - 1} lines. Format is detected from the header, never
            the filename.
          </p>
        )}
      </Card>

      <Card title="2 · Target account (required — CSVs carry no account identity)">
        <div className="flex flex-col gap-3">
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="acctmode" checked={mode === 'existing'} onChange={() => setMode('existing')} />
              Existing account
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="acctmode" checked={mode === 'new'} onChange={() => setMode('new')} />
              Create new
            </label>
          </div>
          {accountsLoad.error !== null && <p className="text-neg">Failed to load accounts: {accountsLoad.error}</p>}
          {mode === 'existing' ? (
            <select className={INPUT_CLASS} value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Target account">
              <option value="">Select account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.mask !== null ? ` •${a.mask}` : ''}
                </option>
              ))}
            </select>
          ) : (
            <div className="grid grid-cols-2 gap-2">
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
                className={INPUT_CLASS}
                value={newInstitution}
                onChange={(e) => setNewInstitution(e.target.value as Institution)}
                aria-label="New account institution"
              >
                <option value="chase">Chase</option>
                <option value="amex">American Express</option>
              </select>
              <select
                className={INPUT_CLASS}
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
      </Card>

      <Card title="3 · Dry run, then commit">
        <div className="flex items-center gap-2">
          <Button variant="ghost" disabled={busy || file === null} onClick={() => void runImport(false)}>
            Dry run
          </Button>
          <Button
            disabled={busy || file === null || report === null || report.committed}
            onClick={() => void runImport(true)}
          >
            Commit import
          </Button>
          {busy && <span className="text-xs text-muted">Working…</span>}
        </div>
        {error !== null && <p className="mt-3 text-sm text-neg">{error}</p>}
        {report !== null && <ReportView report={report} />}
      </Card>
    </div>
  )
}

function ReportView({ report }: { report: ImportReport }) {
  return (
    <div className="mt-3 rounded-md border border-line bg-raised/50 p-3 text-sm">
      <div className="flex items-center gap-2">
        <Badge tone={report.committed ? 'ok' : 'info'}>{report.committed ? 'committed' : 'dry run'}</Badge>
        <Badge tone="neutral">{report.format}</Badge>
      </div>
      <p className="mt-2">
        {report.parsed} parsed → <strong>{report.newCount} new</strong>, {report.matchedCount} matched,{' '}
        {report.skippedDuplicates} duplicates skipped → into <strong>{report.accountName}</strong>
      </p>
      {report.warnings.length > 0 && (
        <ul className="mt-2 list-inside list-disc text-warn">
          {report.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
