/**
 * Accounts per the design: connection cards (institution tile, ••mask · type,
 * status pill with dot, balance-owed/available figure, last-synced line) with
 * contextual bottom sections — Reconnect (amber), Fix connection (red), and
 * the link-CSV-history flow for imported accounts — plus the header actions
 * (Add account, Sync now) and the lifetime quota line
 * ("Plaid Items used: n of 10 (lifetime)").
 */
import { useState } from 'react'
import type { AccountDto, Institution, SyncReport } from '../../../shared/types'
import type { TabId } from '../App'
import { getApi } from '../lib/api'
import { centsToDisplay } from '../lib/format'
import { errorMessage, useLoad } from '../lib/useLoad'
import { Banner } from '../components/Banner'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import { SELECT_CLASS } from '../components/controls'
import { Pill } from '../components/Pill'
import type { PillTone } from '../components/Pill'
import { Skeleton } from '../components/Skeleton'
import {
  IconBank,
  IconClock,
  IconDownload,
  IconLink,
  IconPlus,
  IconRefresh,
  IconWarning,
  IconWifiOff,
} from '../components/Icons'

const api = getApi()

const INSTITUTION_LABEL: Record<Institution, string> = {
  chase: 'Chase',
  amex: 'American Express',
  other: 'Other bank',
}

const STATUS_PILL: Record<AccountDto['status'], { tone: PillTone; label: string }> = {
  ok: { tone: 'ok', label: 'Connected' },
  reconnect_required: { tone: 'warn', label: 'Reconnect needed' },
  error: { tone: 'danger', label: 'Sync error' },
}

export interface AccountsProps {
  go: (tab: TabId) => void
}

export function Accounts({ go }: AccountsProps) {
  const { data: accounts, error, loading, reload } = useLoad(() => api.listAccounts(), [])
  const { data: settings, reload: reloadSettings } = useLoad(() => api.getSettings(), [])
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
      reloadSettings() // enrollment updates the lifetime quota counters
    } catch (err: unknown) {
      setActionError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const provider = settings?.provider ?? 'plaid'

  const addAccount = (): void =>
    void run(async () => {
      // Plaid Link picks the institution inside the widget
      const res = await api.startEnrollment(provider === 'teller' ? institution : undefined)
      if (!res.ok) throw new Error(res.error ?? 'Enrollment failed')
    })

  if (loading) return <AccountsSkeleton />

  if (error !== null) {
    return (
      <EmptyState
        tone="danger"
        icon={<IconWarning size={24} strokeWidth={1.8} />}
        title="Couldn't reach the account service"
        body={error}
        actions={
          <>
            <Button onClick={reload}>
              <IconRefresh size={15} />
              Retry
            </Button>
            <Button variant="secondary" onClick={() => go('settings')}>
              Open settings
            </Button>
          </>
        }
      />
    )
  }

  if (accounts !== null && accounts.length === 0) {
    return (
      <>
        {actionError !== null && (
          <div className="mx-auto max-w-[1080px] px-[30px] pt-6">
            <Banner tone="danger">{actionError}</Banner>
          </div>
        )}
        <EmptyState
          icon={<IconBank size={24} strokeWidth={1.8} />}
          title="No accounts connected"
          body="Connect Chase or Amex to pull transactions automatically, or import a CSV to get started."
          actions={
            <>
              <Button disabled={busy} onClick={addAccount}>
                <IconPlus size={15} />
                Add account
              </Button>
              <Button variant="secondary" onClick={() => go('import')}>
                Import a CSV
              </Button>
            </>
          }
        />
      </>
    )
  }

  const list = accounts ?? []
  const tellerAccounts = list.filter((a) => a.sourceKind === 'teller')

  return (
    <div className="mx-auto max-w-[1080px] px-[30px] pt-6 pb-11">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[15px] font-semibold text-white">Connected accounts</div>
          <div className="mt-0.5 text-[11px] font-medium text-faint">
            Balances and sync status across your banks
          </div>
        </div>
        <div className="flex items-center gap-2">
          {provider === 'teller' && (
            <select
              className={SELECT_CLASS}
              value={institution}
              onChange={(e) => setInstitution(e.target.value as Institution)}
              aria-label="Institution to connect"
            >
              <option value="chase">Chase</option>
              <option value="amex">American Express</option>
            </select>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void run(async () => setSyncReport(await api.syncNow()))}
          >
            <IconRefresh size={14} />
            Sync now
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={addAccount}>
            <IconPlus size={14} />
            Add account
          </Button>
        </div>
      </div>

      {actionError !== null && (
        <Banner tone="danger" className="mb-4" onDismiss={() => setActionError(null)}>
          {actionError}
        </Banner>
      )}

      {syncReport !== null && (
        <Card title="Sync report" subtitle={syncReport.ranAt} className="mb-4">
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
            {syncReport.accounts.map((a) => (
              <li key={a.accountId} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-ink-dim">
                  {list.find((x) => x.id === a.accountId)?.name ?? a.accountId}:
                </span>
                {a.error === null ? (
                  <span className="text-muted">
                    fetched <span className="font-mono">{a.fetched}</span>, inserted{' '}
                    <span className="font-mono">{a.inserted}</span>, matched{' '}
                    <span className="font-mono">{a.matched}</span>, GC’d{' '}
                    <span className="font-mono">{a.gcPending}</span> pending
                    {a.uncategorized > 0 && (
                      <span className="text-warn">
                        {' '}
                        · <span className="font-mono">{a.uncategorized}</span> uncategorized — see Review
                      </span>
                    )}
                    {a.warning !== null && <span className="text-warn"> · {a.warning}</span>}
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
        {list.map((acct) => (
          <AccountCard
            key={acct.id}
            account={acct}
            tellerAccounts={tellerAccounts}
            busy={busy}
            run={run}
          />
        ))}
      </div>

      <div className="mt-5 text-xs font-medium text-ghost">
        {provider === 'plaid' ? (
          <>
            Plaid Items used: <span className="font-mono text-muted">{settings?.plaidItemsUsed ?? 0} of 10</span>{' '}
            (lifetime)
          </>
        ) : (
          <>
            Bank connections used:{' '}
            <span className="font-mono text-muted">{settings?.enrollmentsUsed ?? 0} of 100</span> (lifetime)
          </>
        )}
      </div>
    </div>
  )
}

interface AccountCardProps {
  account: AccountDto
  tellerAccounts: AccountDto[]
  busy: boolean
  run: (action: () => Promise<void>) => Promise<void>
}

function AccountCard({ account, tellerAccounts, busy, run }: AccountCardProps) {
  const isCsv = account.sourceKind === 'csv_only'
  const pill = isCsv ? { tone: 'neutral' as PillTone, label: 'CSV import' } : STATUS_PILL[account.status]
  const typeLabel = account.type === 'credit' ? 'Credit card' : 'Checking'

  return (
    <div className="rounded-xl border border-line bg-surface px-5 py-[18px]">
      <div className="flex items-start gap-3">
        <div
          className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[9px] border border-line bg-[#1E293B] text-[15px] font-bold text-ink-dim"
          aria-hidden="true"
        >
          {INSTITUTION_LABEL[account.institution].charAt(0)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-white">{account.name}</div>
          <div className="mt-0.5 font-mono text-xs font-medium text-faint">
            {account.mask !== null ? `••${account.mask} · ` : ''}
            {typeLabel}
            {account.subtype !== null && account.subtype !== 'checking' && account.subtype !== 'credit_card'
              ? ` (${account.subtype})`
              : ''}
            {isCsv ? ' · imported CSV' : ''}
          </div>
        </div>
        <Pill tone={pill.tone} dot>
          {pill.label}
        </Pill>
      </div>

      <div className="mt-4 flex items-end justify-between">
        <div>
          <div className="mb-1 text-[10.5px] font-medium tracking-[0.05em] text-faint uppercase">
            {account.balanceCents !== null && account.balanceCents < 0 ? 'Balance owed' : 'Available balance'}
          </div>
          <div className="font-mono text-2xl font-semibold tracking-tight text-white">
            {account.balanceCents !== null
              ? `${account.balanceCents < 0 ? '−' : ''}${centsToDisplay(Math.abs(account.balanceCents))}`
              : '—'}
          </div>
        </div>
        <div className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-faint">
          <IconClock size={13} />
          {isCsv
            ? 'Imported · not auto-synced'
            : account.lastSyncAt !== null
              ? `Last synced ${account.lastSyncAt}`
              : 'Never synced'}
        </div>
      </div>

      {!isCsv && account.status === 'reconnect_required' && (
        <div className="mt-4 border-t border-white/7 pt-4">
          <div className="mb-3 text-[12.5px] leading-normal text-warn-soft">
            {INSTITUTION_LABEL[account.institution]} expired the saved login. Reconnect to resume automatic syncing —
            your history is safe.
          </div>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const res = await api.reconnect(account.id)
                if (!res.ok) throw new Error(res.error ?? 'Reconnect failed')
              })
            }
          >
            <IconRefresh size={14} />
            Reconnect
          </Button>
        </div>
      )}

      {!isCsv && account.status === 'error' && (
        <div className="mt-4 border-t border-white/7 pt-4">
          <div className="mb-3 text-[12.5px] leading-normal text-neg">
            {INSTITUTION_LABEL[account.institution]} returned an authentication error. Re-enter your credentials to
            restore the connection.
          </div>
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const res = await api.reconnect(account.id)
                if (!res.ok) throw new Error(res.error ?? 'Reconnect failed')
              })
            }
          >
            <IconWifiOff size={14} />
            Fix connection
          </Button>
        </div>
      )}

      {isCsv && <LinkHistorySection account={account} tellerAccounts={tellerAccounts} busy={busy} run={run} />}
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
function LinkHistorySection({ account, tellerAccounts, busy, run }: LinkProps) {
  const [targetId, setTargetId] = useState('')
  const [result, setResult] = useState<string | null>(null)

  return (
    <div className="mt-4 border-t border-white/7 pt-4">
      <div className="mb-3 text-[12.5px] leading-normal text-muted">
        Imported from a CSV file. Link it to a live connection to keep it syncing automatically.
      </div>
      {tellerAccounts.length === 0 ? (
        <p className="m-0 text-xs text-faint">Connect a bank account first, then link this history to it.</p>
      ) : (
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
                {t.mask !== null ? ` ••${t.mask}` : ''}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || targetId === ''}
            onClick={() =>
              void run(async () => {
                const res = await api.linkCsvHistory(account.id, targetId)
                setResult(`Moved ${res.moved} rows, matched ${res.matched}.`)
              })
            }
          >
            <IconLink size={14} />
            Link imported history
          </Button>
          {result !== null && (
            <span className="text-xs font-medium text-pos" role="status">
              {result}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function AccountsSkeleton() {
  return (
    <div className="mx-auto max-w-[1080px] px-[30px] pt-6 pb-11" aria-busy="true" aria-label="Loading accounts">
      <Skeleton className="mb-5 h-3.5 w-[180px] rounded-md" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-40 rounded-xl border border-line bg-surface p-[18px]">
            <div className="mb-5 flex gap-3">
              <Skeleton className="h-[38px] w-[38px] rounded-[9px]" />
              <div className="flex-1">
                <Skeleton className="mb-2 h-3 w-3/5" />
                <Skeleton className="h-2.5 w-2/5" />
              </div>
            </div>
            <Skeleton className="h-[26px] w-[120px] rounded-md" />
          </div>
        ))}
      </div>
    </div>
  )
}
