/**
 * Transactions per the design: filter row (search with "/" shortcut, account /
 * category / month selects) + removable filter chips, dense table with
 * checkbox multi-select + bulk recategorize bar, amber left border on pending
 * rows, source glyphs (CSV vs bank sync), and the category popover with the
 * two-scope choice + apply-to-N-past checkbox. ↑ ↓ move the active row,
 * Enter opens the popover, Esc closes it.
 */
import { useEffect, useRef, useState } from 'react'
import type { TransactionDto } from '../../../shared/types'
import type { TabId } from '../App'
import { getApi } from '../lib/api'
import { categoryColor } from '../lib/categoryColors'
import { currentMonth, lastNMonths, monthLabelFull, shortDate } from '../lib/format'
import { errorMessage, useLoad } from '../lib/useLoad'
import { Button } from '../components/Button'
import { CategoryPopover } from '../components/CategoryPopover'
import type { PopoverAnchor } from '../components/CategoryPopover'
import { EmptyState } from '../components/EmptyState'
import { SELECT_CLASS } from '../components/controls'
import { Money } from '../components/Money'
import { Skeleton, SkeletonRows } from '../components/Skeleton'
import {
  IconArrowLeftRight,
  IconDownload,
  IconFileText,
  IconPencil,
  IconRefresh,
  IconSearch,
  IconWarning,
  IconX,
} from '../components/Icons'

const api = getApi()

type PopoverState =
  | { kind: 'row'; txn: TransactionDto; anchor: PopoverAnchor }
  | { kind: 'bulk'; anchor: PopoverAnchor }

interface Filters {
  accountId: string
  categoryId: string
  month: string
  text: string
}

const NO_FILTERS: Filters = { accountId: '', categoryId: '', month: '', text: '' }

function isTypingTarget(target: EventTarget | null): boolean {
  const tag = target instanceof HTMLElement ? target.tagName : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function isCsvSource(source: TransactionDto['source']): boolean {
  return source === 'chase_csv' || source === 'amex_csv'
}

export interface TransactionsProps {
  go: (tab: TabId) => void
}

export function Transactions({ go }: TransactionsProps) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [activeIdx, setActiveIdx] = useState(0)
  const [popover, setPopover] = useState<PopoverState | null>(null)
  const [popoverBusy, setPopoverBusy] = useState(false)
  const [popoverError, setPopoverError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const meta = useLoad(async () => {
    const [accounts, categories] = await Promise.all([api.listAccounts(), api.listCategories()])
    return { accounts, categories }
  }, [])

  const txns = useLoad(
    () =>
      api.listTransactions({
        ...(filters.accountId !== '' ? { accountId: filters.accountId } : {}),
        ...(filters.categoryId !== '' ? { categoryId: filters.categoryId } : {}),
        ...(filters.month !== '' ? { from: `${filters.month}-01`, to: `${filters.month}-31` } : {}),
        ...(filters.text.trim() !== '' ? { text: filters.text.trim() } : {}),
      }),
    [filters.accountId, filters.categoryId, filters.month, filters.text],
  )

  const rows = txns.data?.rows ?? []
  const accounts = meta.data?.accounts ?? []
  const categories = meta.data?.categories ?? []
  const hasFilters =
    filters.accountId !== '' || filters.categoryId !== '' || filters.month !== '' || filters.text.trim() !== ''

  const patchFilters = (patch: Partial<Filters>): void => {
    setFilters((f) => ({ ...f, ...patch }))
    setActiveIdx(0)
    setSelected(new Set())
  }

  // Keyboard: "/" focuses search; ↑ ↓ move the active row; Enter recategorizes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (popover !== null) return // popover owns Esc / typing
      const typing = isTypingTarget(e.target)
      if (e.key === '/' && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (typing || rows.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx((i) => Math.min(rows.length - 1, i + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((i) => Math.max(0, i - 1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const idx = Math.min(activeIdx, rows.length - 1)
        const txn = rows[idx]
        if (txn === undefined) return
        const el = document.querySelector(`[data-cat-btn="${txn.id}"]`)
        const rect = el?.getBoundingClientRect()
        openRowPopover(txn, rect ?? { left: window.innerWidth / 2 - 133, top: 200, bottom: 224 })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rows identity churns per load
  }, [popover, rows, activeIdx])

  const openRowPopover = (txn: TransactionDto, rect: PopoverAnchor): void => {
    setPopoverError(null)
    setPopover({ kind: 'row', txn, anchor: { left: rect.left, top: rect.top, bottom: rect.bottom } })
  }

  const toggleRow = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
  }

  const applyRowChange = async (
    txn: TransactionDto,
    result: { categoryId: string; scope: 'txn' | 'merchant'; applyToExisting: boolean },
  ): Promise<void> => {
    setPopoverBusy(true)
    setPopoverError(null)
    try {
      await api.recategorize({
        txnId: txn.id,
        categoryId: result.categoryId,
        scope: result.scope,
        ...(result.scope === 'merchant' ? { applyToExisting: result.applyToExisting } : {}),
      })
      setPopover(null)
      txns.reload()
    } catch (err: unknown) {
      setPopoverError(errorMessage(err))
    } finally {
      setPopoverBusy(false)
    }
  }

  const applyBulkChange = async (categoryId: string): Promise<void> => {
    setPopoverBusy(true)
    setPopoverError(null)
    try {
      for (const txnId of selected) {
        await api.recategorize({ txnId, categoryId, scope: 'txn' })
      }
      setPopover(null)
      setSelected(new Set())
      txns.reload()
    } catch (err: unknown) {
      setPopoverError(errorMessage(err))
    } finally {
      setPopoverBusy(false)
    }
  }

  if ((meta.loading || txns.loading) && txns.data === null) return <TransactionsSkeleton />

  const loadError = meta.error ?? txns.error
  if (loadError !== null) {
    return (
      <EmptyState
        tone="danger"
        icon={<IconWarning size={24} strokeWidth={1.8} />}
        title="Couldn't load transactions"
        body={loadError}
        actions={
          <Button
            onClick={() => {
              meta.reload()
              txns.reload()
            }}
          >
            <IconRefresh size={15} />
            Retry
          </Button>
        }
      />
    )
  }

  if (txns.data !== null && txns.data.total === 0 && !hasFilters) {
    return (
      <EmptyState
        icon={<IconArrowLeftRight size={24} strokeWidth={1.8} />}
        title="No transactions yet"
        body="Once you import a statement or connect a bank, every transaction lands here."
        actions={
          <Button onClick={() => go('import')}>
            <IconDownload size={15} />
            Import transactions
          </Button>
        }
      />
    )
  }

  const chips: Array<{ key: string; label: string; onRemove: () => void }> = []
  if (filters.text.trim() !== '')
    chips.push({ key: 'text', label: `“${filters.text.trim()}”`, onRemove: () => patchFilters({ text: '' }) })
  if (filters.accountId !== '')
    chips.push({
      key: 'account',
      label: accounts.find((a) => a.id === filters.accountId)?.name ?? filters.accountId,
      onRemove: () => patchFilters({ accountId: '' }),
    })
  if (filters.categoryId !== '')
    chips.push({
      key: 'category',
      label: categories.find((c) => c.id === filters.categoryId)?.name ?? filters.categoryId,
      onRemove: () => patchFilters({ categoryId: '' }),
    })
  if (filters.month !== '')
    chips.push({ key: 'month', label: monthLabelFull(filters.month), onRemove: () => patchFilters({ month: '' }) })

  const accountLabel = (id: string): string => {
    const acct = accounts.find((a) => a.id === id)
    if (acct === undefined) return id
    return acct.mask !== null ? `••${acct.mask}` : acct.name
  }

  return (
    <div className="mx-auto max-w-[1180px] px-[30px] pt-[18px] pb-10">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative max-w-[300px] min-w-[210px] flex-1">
          <IconSearch size={15} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <input
            ref={searchRef}
            value={filters.text}
            onChange={(e) => patchFilters({ text: e.target.value })}
            placeholder="Search payee or description…"
            aria-label="Search transactions"
            className="w-full rounded-lg border border-white/10 bg-deep py-2 pr-8 pl-[34px] text-[13px] text-white placeholder:text-faint"
          />
          <kbd
            className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-white/12 px-1.5 py-px font-mono text-[10px] font-semibold text-ghost"
            aria-hidden="true"
          >
            /
          </kbd>
        </div>
        <select
          className={SELECT_CLASS}
          value={filters.accountId}
          onChange={(e) => patchFilters({ accountId: e.target.value })}
          aria-label="Filter by account"
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.mask !== null ? ` ••${a.mask}` : ''}
            </option>
          ))}
        </select>
        <select
          className={SELECT_CLASS}
          value={filters.categoryId}
          onChange={(e) => patchFilters({ categoryId: e.target.value })}
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          className={SELECT_CLASS}
          value={filters.month}
          onChange={(e) => patchFilters({ month: e.target.value })}
          aria-label="Filter by month"
        >
          <option value="">All months</option>
          {lastNMonths(currentMonth(), 12)
            .slice()
            .reverse()
            .map((m) => (
              <option key={m} value={m}>
                {monthLabelFull(m)}
              </option>
            ))}
        </select>
      </div>

      {chips.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium text-ghost">Filters</span>
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={chip.onRemove}
              aria-label={`Remove filter ${chip.label}`}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 py-[3px] pr-2 pl-2.5 text-xs font-medium text-accent-soft transition-colors hover:bg-accent/18"
            >
              {chip.label}
              <IconX size={12} strokeWidth={2.4} />
            </button>
          ))}
          <button
            type="button"
            onClick={() => patchFilters(NO_FILTERS)}
            className="cursor-pointer border-0 bg-transparent px-1 py-[3px] text-xs font-medium text-faint hover:text-ink-dim"
          >
            Clear all
          </button>
        </div>
      )}

      {selected.size > 0 && (
        <div
          className="fadein mt-3.5 flex items-center gap-3.5 rounded-[10px] border border-accent/28 bg-accent/10 px-3.5 py-2"
          role="status"
        >
          <span className="text-[13px] font-semibold text-accent-soft">
            <span className="font-mono">{selected.size}</span> selected
          </span>
          <Button
            size="sm"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setPopoverError(null)
              setPopover({ kind: 'bulk', anchor: { left: rect.left, top: rect.top, bottom: rect.bottom } })
            }}
          >
            <IconPencil size={13} />
            Recategorize
          </Button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="cursor-pointer border-0 bg-transparent text-xs font-medium text-faint hover:text-ink-dim"
          >
            Clear selection
          </button>
        </div>
      )}

      <div className="mt-3.5 overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex h-[38px] items-center border-b border-line bg-inset px-4 text-[10.5px] font-semibold tracking-[0.06em] text-faint uppercase">
          <div className="flex w-[34px] shrink-0">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              aria-label="Select all visible transactions"
              className="h-[15px] w-[15px] cursor-pointer accent-accent"
            />
          </div>
          <div className="w-[92px] shrink-0">Date</div>
          <div className="min-w-0 flex-1">Payee</div>
          <div className="w-[158px] shrink-0">Category</div>
          <div className="w-[100px] shrink-0">Account</div>
          <div className="w-[116px] shrink-0 text-right">Amount</div>
        </div>

        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-5 py-14 text-center" role="status">
            <IconSearch size={26} strokeWidth={1.7} className="mb-3.5 text-ghost" />
            <div className="mb-1.5 text-sm font-semibold text-white">No transactions match</div>
            <div className="mb-4 text-[12.5px] text-muted">Try widening your filters or clearing the search.</div>
            <Button variant="secondary" size="sm" onClick={() => patchFilters(NO_FILTERS)}>
              Clear all filters
            </Button>
          </div>
        ) : (
          rows.map((t, idx) => {
            const pending = t.status === 'pending'
            const active = idx === activeIdx
            const isSelected = selected.has(t.id)
            const category = categories.find((c) => c.id === t.categoryId)
            return (
              <div
                key={t.id}
                className={`flex h-[42px] items-center border-b border-white/4 px-4 transition-colors last:border-b-0 hover:bg-white/3 ${
                  pending ? 'border-l-[3px] border-l-warn-deep' : 'border-l-[3px] border-l-transparent'
                } ${active ? 'bg-accent/9' : isSelected ? 'bg-accent/5' : ''}`}
              >
                <div className="flex w-[34px] shrink-0">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleRow(t.id)}
                    aria-label={`Select ${t.payee} on ${t.txnDate}`}
                    className="h-[15px] w-[15px] cursor-pointer accent-accent"
                  />
                </div>
                <div className={`w-[92px] shrink-0 font-mono text-xs font-medium ${pending ? 'text-faint' : 'text-muted'}`}>
                  {shortDate(t.txnDate)}
                </div>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    className={`truncate text-[13px] ${pending ? 'text-faint' : 'text-[#F1F5F9]'}`}
                    title={t.rawDescription}
                  >
                    {t.payee}
                  </span>
                  <span
                    className="flex shrink-0 cursor-default text-ghost"
                    title={isCsvSource(t.source) ? 'Imported from CSV' : 'Auto-synced from bank'}
                    role="img"
                    aria-label={isCsvSource(t.source) ? 'Imported from CSV' : 'Auto-synced from bank'}
                  >
                    {isCsvSource(t.source) ? <IconFileText size={12} /> : <IconRefresh size={12} />}
                  </span>
                  {pending && (
                    <span className="shrink-0 rounded border border-warn-deep/35 px-[5px] py-px text-[9.5px] font-semibold tracking-wider text-warn-deep uppercase">
                      Pending
                    </span>
                  )}
                </div>
                <div className="w-[158px] shrink-0">
                  <button
                    type="button"
                    data-cat-btn={t.id}
                    onClick={(e) => openRowPopover(t, e.currentTarget.getBoundingClientRect())}
                    aria-label={`Category for ${t.payee}: ${t.categoryName ?? 'Uncategorized'}. Change`}
                    className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-[7px] border border-white/9 bg-transparent px-2 py-1 text-xs font-medium text-ink-dim transition-colors hover:border-accent/55 hover:bg-accent/9 hover:text-white"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-[2px]"
                      style={{ background: categoryColor(t.categoryId, category) }}
                      aria-hidden="true"
                    />
                    <span className="truncate">{t.categoryName ?? 'Uncategorized'}</span>
                    <IconPencil size={11} className="ml-auto shrink-0 opacity-40" />
                  </button>
                </div>
                <div className="w-[100px] shrink-0 truncate font-mono text-xs font-medium text-muted">
                  {accountLabel(t.accountId)}
                </div>
                <div className="w-[116px] shrink-0 text-right">
                  <Money cents={t.amountCents} muted={pending} className="text-[13px]" />
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="mt-3 text-xs font-medium text-ghost">
        <span className="font-mono text-muted">{txns.data?.total ?? rows.length}</span> transaction
        {(txns.data?.total ?? rows.length) === 1 ? '' : 's'} · use ↑ ↓ to move, Enter to recategorize, / to search
      </div>

      {popover !== null && popover.kind === 'row' && (
        <CategoryPopover
          anchor={popover.anchor}
          title="Categorize"
          payee={popover.txn.payee}
          categories={categories}
          initialCategoryId={popover.txn.categoryId}
          scopeChoice={{
            payee: popover.txn.payee,
            pastCount: rows.filter((r) => r.payee === popover.txn.payee && r.id !== popover.txn.id).length,
          }}
          busy={popoverBusy}
          error={popoverError}
          onConfirm={(result) => void applyRowChange(popover.txn, result)}
          onClose={() => setPopover(null)}
        />
      )}
      {popover !== null && popover.kind === 'bulk' && (
        <CategoryPopover
          anchor={popover.anchor}
          title={`Recategorize ${selected.size} transaction${selected.size === 1 ? '' : 's'}`}
          categories={categories}
          initialCategoryId={null}
          confirmLabel={`Recategorize ${selected.size}`}
          busy={popoverBusy}
          error={popoverError}
          onConfirm={(result) => void applyBulkChange(result.categoryId)}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  )
}

function TransactionsSkeleton() {
  return (
    <div className="mx-auto max-w-[1180px] px-[30px] pt-[18px] pb-10" aria-busy="true" aria-label="Loading transactions">
      <div className="mb-4 flex gap-2.5">
        <Skeleton className="h-9 w-[280px] rounded-lg" />
        <Skeleton className="h-9 w-[150px] rounded-lg" />
        <Skeleton className="h-9 w-[150px] rounded-lg" />
        <Skeleton className="h-9 w-[150px] rounded-lg" />
      </div>
      <SkeletonRows rows={12} />
    </div>
  )
}
