import { useState } from 'react'
import type { CategoryDto, TransactionDto } from '../../../shared/types'
import { getApi } from '../lib/api'
import { useLoad, errorMessage } from '../lib/useLoad'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { MoneyText } from '../components/MoneyText'
import { Table } from '../components/Table'
import type { Column } from '../components/Table'

const api = getApi()

const SELECT_CLASS =
  'rounded-md border border-line bg-raised px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none'

interface PendingChange {
  txn: TransactionDto
  categoryId: string
}

export function Transactions() {
  const [accountId, setAccountId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [text, setText] = useState('')
  const [pending, setPending] = useState<PendingChange | null>(null)

  const meta = useLoad(async () => {
    const [accounts, categories] = await Promise.all([api.listAccounts(), api.listCategories()])
    return { accounts, categories }
  }, [])

  const txns = useLoad(
    () =>
      api.listTransactions({
        ...(accountId !== '' ? { accountId } : {}),
        ...(categoryId !== '' ? { categoryId } : {}),
        ...(text.trim() !== '' ? { text: text.trim() } : {}),
      }),
    [accountId, categoryId, text],
  )

  const accounts = meta.data?.accounts ?? []
  const categories = meta.data?.categories ?? []
  const accountName = (id: string): string => accounts.find((a) => a.id === id)?.name ?? id

  const columns: Column<TransactionDto>[] = [
    { key: 'date', header: 'Date', className: 'whitespace-nowrap', render: (t) => t.txnDate },
    {
      key: 'payee',
      header: 'Payee',
      render: (t) => (
        <div>
          <div className="font-medium">{t.payee}</div>
          <div className="max-w-105 truncate text-xs text-muted" title={t.rawDescription}>
            {t.rawDescription}
          </div>
        </div>
      ),
    },
    { key: 'account', header: 'Account', render: (t) => <span className="text-ink-dim">{accountName(t.accountId)}</span> },
    {
      key: 'category',
      header: 'Category',
      render: (t) => (
        <select
          className={SELECT_CLASS}
          value={t.categoryId ?? ''}
          onChange={(e) => setPending({ txn: t, categoryId: e.target.value })}
          aria-label={`Category for ${t.payee}`}
        >
          <option value="" disabled>
            Uncategorized
          </option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      ),
    },
    { key: 'amount', header: 'Amount', className: 'text-right', render: (t) => <MoneyText cents={t.amountCents} /> },
    {
      key: 'status',
      header: 'Status',
      render: (t) => (
        <div className="flex gap-1">
          {t.status === 'pending' && <Badge tone="warn">pending</Badge>}
          <Badge tone="neutral">{t.source}</Badge>
        </div>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Transactions</h1>

      <div className="flex flex-wrap items-center gap-2">
        <select className={SELECT_CLASS} value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Filter by account">
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select className={SELECT_CLASS} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Filter by category">
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          className={`${SELECT_CLASS} min-w-56 flex-1`}
          placeholder="Search payee or description…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Search transactions"
        />
        {txns.data !== null && <span className="text-xs text-muted">{txns.data.total} transactions</span>}
      </div>

      {meta.error !== null && <p className="text-neg">Failed to load filters: {meta.error}</p>}
      {txns.error !== null && <p className="text-neg">Failed to load transactions: {txns.error}</p>}
      {txns.loading && <p className="text-muted">Loading transactions…</p>}
      {txns.data !== null && !txns.loading && (
        <Table columns={columns} rows={txns.data.rows} rowKey={(t) => t.id} emptyText="No transactions match." />
      )}

      {pending !== null && (
        <RecategorizeDialog
          pending={pending}
          categories={categories}
          onClose={() => setPending(null)}
          onDone={() => {
            setPending(null)
            txns.reload()
          }}
        />
      )}
    </div>
  )
}

interface DialogProps {
  pending: PendingChange
  categories: CategoryDto[]
  onClose: () => void
  onDone: () => void
}

/** Two explicit actions (plan §6): this-transaction-only vs always-for-merchant. */
function RecategorizeDialog({ pending, categories, onClose, onDone }: DialogProps) {
  const [scope, setScope] = useState<'txn' | 'merchant'>('txn')
  const [applyToExisting, setApplyToExisting] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const categoryName = categories.find((c) => c.id === pending.categoryId)?.name ?? pending.categoryId

  const apply = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.recategorize({
        txnId: pending.txn.id,
        categoryId: pending.categoryId,
        scope,
        ...(scope === 'merchant' ? { applyToExisting } : {}),
      })
      onDone()
    } catch (err: unknown) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-5">
        <h2 className="text-base font-semibold">
          Recategorize as “{categoryName}”
        </h2>
        <p className="mt-1 text-sm text-muted">
          {pending.txn.payee} · {pending.txn.txnDate}
        </p>
        <div className="mt-4 flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="scope" checked={scope === 'txn'} onChange={() => setScope('txn')} />
            This transaction only
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="scope" checked={scope === 'merchant'} onChange={() => setScope('merchant')} />
            Always for “{pending.txn.payee}”
          </label>
          {scope === 'merchant' && (
            <label className="ml-6 flex items-center gap-2 text-ink-dim">
              <input
                type="checkbox"
                checked={applyToExisting}
                onChange={(e) => setApplyToExisting(e.target.checked)}
              />
              Also apply to existing transactions (keeps your manual edits)
            </label>
          )}
        </div>
        {error !== null && <p className="mt-3 text-sm text-neg">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void apply()} disabled={busy}>
            {busy ? 'Applying…' : 'Apply'}
          </Button>
        </div>
      </div>
    </div>
  )
}
