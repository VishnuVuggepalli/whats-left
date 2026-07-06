import { useState } from 'react'
import type { AccountDto, Institution, SyncReport } from '../../../shared/types'
import { getApi } from '../lib/api'
import { errorMessage, useLoad } from '../lib/useLoad'
import { Badge } from '../components/Badge'
import type { BadgeTone } from '../components/Badge'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { MoneyText } from '../components/MoneyText'

const api = getApi()

const SELECT_CLASS =
  'rounded-md border border-line bg-raised px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none'

const STATUS_TONE: Record<AccountDto['status'], BadgeTone> = {
  ok: 'ok',
  reconnect_required: 'warn',
  error: 'danger',
}

export function Accounts() {
  const { data: accounts, error, loading, reload } = useLoad(() => api.listAccounts(), [])
  const [actionError, setActionError] = useState<string | null>(null)
  const [syncReport, setSyncReport] = useState<SyncReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [institution, setInstitution] = useState<Institution>('chase')

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      await action()
      reload()
    } catch (err: unknown) {
      setActionError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const tellerAccounts = (accounts ?? []).filter((a) => a.sourceKind === 'teller')

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Accounts</h1>
        <div className="flex items-center gap-2">
          <select
            className={SELECT_CLASS}
            value={institution}
            onChange={(e) => setInstitution(e.target.value as Institution)}
            aria-label="Institution to connect"
          >
            <option value="chase">Chase</option>
            <option value="amex">American Express</option>
          </select>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const res = await api.startEnrollment(institution)
                if (!res.ok) throw new Error(res.error ?? 'Enrollment failed')
              })
            }
          >
            Add via Teller
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setSyncReport(await api.syncNow())
              })
            }
          >
            Sync now
          </Button>
        </div>
      </div>

      {actionError !== null && <p className="text-neg">{actionError}</p>}
      {error !== null && <p className="text-neg">Failed to load accounts: {error}</p>}
      {loading && <p className="text-muted">Loading accounts…</p>}

      {syncReport !== null && (
        <Card title={`Sync report — ${syncReport.ranAt}`}>
          <ul className="flex flex-col gap-1 text-sm">
            {syncReport.accounts.map((a) => (
              <li key={a.accountId} className="flex items-center gap-2">
                <span className="text-ink-dim">{accounts?.find((x) => x.id === a.accountId)?.name ?? a.accountId}:</span>
                {a.error === null ? (
                  <span className="text-muted">
                    fetched {a.fetched}, inserted {a.inserted}, matched {a.matched}, GC’d {a.gcPending} pending
                  </span>
                ) : (
                  <span className="text-neg">{a.error}</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {(accounts ?? []).map((acct) => (
          <Card key={acct.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">
                  {acct.name}
                  {acct.mask !== null && <span className="ml-1 text-muted">•{acct.mask}</span>}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {acct.institution === 'chase' ? 'Chase' : 'American Express'} · {acct.type}
                  {acct.subtype !== null ? ` (${acct.subtype})` : ''} ·{' '}
                  {acct.sourceKind === 'teller' ? 'Teller feed' : 'CSV only'}
                </p>
              </div>
              <Badge tone={STATUS_TONE[acct.status]}>{acct.status.replace('_', ' ')}</Badge>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <div className="text-xs text-muted">
                {acct.lastSyncAt !== null ? `Last sync: ${acct.lastSyncAt}` : 'Never synced'}
              </div>
              {acct.balanceCents !== null && <MoneyText cents={acct.balanceCents} className="text-lg" />}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {acct.sourceKind === 'teller' && acct.status === 'reconnect_required' && (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const res = await api.reconnect(acct.id)
                      if (!res.ok) throw new Error(res.error ?? 'Reconnect failed')
                    })
                  }
                >
                  Reconnect
                </Button>
              )}
              {acct.sourceKind === 'csv_only' && (
                <LinkHistoryControl account={acct} tellerAccounts={tellerAccounts} busy={busy} run={run} />
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}

interface LinkProps {
  account: AccountDto
  tellerAccounts: AccountDto[]
  busy: boolean
  run: (action: () => Promise<void>) => Promise<void>
}

/** "Link CSV history to this Teller account" (plan §5b). */
function LinkHistoryControl({ account, tellerAccounts, busy, run }: LinkProps) {
  const [targetId, setTargetId] = useState('')
  const [result, setResult] = useState<string | null>(null)
  if (tellerAccounts.length === 0) {
    return <p className="text-xs text-muted">Connect a Teller account to link this CSV history.</p>
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={SELECT_CLASS}
        value={targetId}
        onChange={(e) => setTargetId(e.target.value)}
        aria-label={`Link ${account.name} history to`}
      >
        <option value="">Link history to…</option>
        {tellerAccounts.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <Button
        variant="ghost"
        disabled={busy || targetId === ''}
        onClick={() =>
          void run(async () => {
            const res = await api.linkCsvHistory(account.id, targetId)
            setResult(`Moved ${res.moved} rows, matched ${res.matched}.`)
          })
        }
      >
        Link
      </Button>
      {result !== null && <span className="text-xs text-pos">{result}</span>}
    </div>
  )
}
