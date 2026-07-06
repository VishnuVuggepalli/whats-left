/**
 * Anchored category-picker popover per the design: search field, swatch-dotted
 * category list, optional two-scope choice ("Only this transaction" vs
 * "Always for <payee>") with an apply-to-N-past checkbox, Cancel/confirm
 * footer. Esc and backdrop-click close; the search field autofocuses.
 */
import { useEffect, useMemo, useState } from 'react'
import type { CategoryDto } from '../../../shared/types'
import { categoryColor } from '../lib/categoryColors'
import { IconCheck, IconSearch } from './Icons'

export type CategoryScope = 'txn' | 'merchant'

export interface CategoryPopoverResult {
  categoryId: string
  scope: CategoryScope
  applyToExisting: boolean
}

export interface PopoverAnchor {
  left: number
  top: number
  bottom: number
}

export interface CategoryPopoverProps {
  anchor: PopoverAnchor
  title: string
  /** payee shown under the title */
  payee?: string
  categories: readonly CategoryDto[]
  initialCategoryId: string | null
  /** when present, show the two-scope choice for this merchant */
  scopeChoice?: { payee: string; pastCount: number }
  /** confirm label when no scope choice is shown (default "Apply") */
  confirmLabel?: string
  busy?: boolean
  error?: string | null
  onConfirm: (result: CategoryPopoverResult) => void
  onClose: () => void
}

const POPOVER_WIDTH = 266
const POPOVER_EST_HEIGHT = 390

function placePopover(anchor: PopoverAnchor): { left: number; top: number } {
  let left = anchor.left
  if (left + POPOVER_WIDTH > window.innerWidth - 12) left = window.innerWidth - 12 - POPOVER_WIDTH
  if (left < 12) left = 12
  let top = anchor.bottom + 6
  if (top + POPOVER_EST_HEIGHT > window.innerHeight - 12) {
    top = Math.max(12, anchor.top - 6 - POPOVER_EST_HEIGHT)
  }
  return { left, top }
}

export function CategoryPopover({
  anchor,
  title,
  payee,
  categories,
  initialCategoryId,
  scopeChoice,
  confirmLabel = 'Apply',
  busy = false,
  error = null,
  onConfirm,
  onClose,
}: CategoryPopoverProps) {
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState<string | null>(initialCategoryId)
  const [scope, setScope] = useState<CategoryScope>('txn')
  const [applyToExisting, setApplyToExisting] = useState(false)

  const position = useMemo(() => placePopover(anchor), [anchor])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const filtered = categories.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()))
  const canConfirm = categoryId !== null && !busy
  const label = scopeChoice !== undefined ? (scope === 'merchant' ? 'Apply always' : 'Apply') : confirmLabel

  const confirm = (): void => {
    if (categoryId === null || busy) return
    onConfirm({ categoryId, scope: scopeChoice !== undefined ? scope : 'txn', applyToExisting })
  }

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fadein fixed z-50 w-[266px] overflow-hidden rounded-xl border border-white/13 bg-inset shadow-[0_18px_48px_rgba(0,0,0,0.55)]"
        style={{ left: position.left, top: position.top }}
      >
        <div className="border-b border-white/7 px-3.5 pt-3 pb-2.5">
          <div className="text-[13px] font-semibold text-white">{title}</div>
          {payee !== undefined && <div className="mt-0.5 truncate text-[11px] font-medium text-faint">{payee}</div>}
        </div>

        <div className="relative px-3 pt-2.5 pb-2">
          <IconSearch size={14} className="pointer-events-none absolute top-[19px] left-[22px] text-faint" />
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- design: search takes focus on open
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a category…"
            aria-label="Find a category"
            className="w-full rounded-[7px] border border-white/10 bg-deep py-[7px] pr-2.5 pl-8 text-[12.5px] text-white placeholder:text-faint"
          />
        </div>

        <div className="max-h-[194px] overflow-y-auto px-2 pt-0.5 pb-2" role="listbox" aria-label="Categories">
          {filtered.map((c) => {
            const selected = c.id === categoryId
            return (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => setCategoryId(c.id)}
                className={`flex w-full cursor-pointer items-center gap-2.5 rounded-[7px] border-0 px-2 py-[7px] text-left text-[12.5px] font-medium transition-colors hover:bg-white/6 ${
                  selected ? 'bg-accent/14 text-white' : 'bg-transparent text-ink-dim'
                }`}
              >
                <span
                  className="h-[9px] w-[9px] shrink-0 rounded-[2px]"
                  style={{ background: categoryColor(c.id, c) }}
                  aria-hidden="true"
                />
                <span className="flex-1">{c.name}</span>
                {selected && <IconCheck size={14} strokeWidth={2.4} className="text-accent" />}
              </button>
            )
          })}
          {filtered.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-faint">No category matches.</div>
          )}
        </div>

        {scopeChoice !== undefined && (
          <fieldset className="m-0 border-t border-white/7 px-3.5 py-2.5">
            <legend className="sr-only">Where to apply this category</legend>
            <label className="flex w-full cursor-pointer items-center gap-2.5 py-[5px] text-[12.5px] font-medium text-ink">
              <input
                type="radio"
                name="cat-scope"
                checked={scope === 'txn'}
                onChange={() => setScope('txn')}
                className="h-[15px] w-[15px] shrink-0 accent-accent"
              />
              Only this transaction
            </label>
            <label className="flex w-full cursor-pointer items-center gap-2.5 py-[5px] text-[12.5px] font-medium text-ink">
              <input
                type="radio"
                name="cat-scope"
                checked={scope === 'merchant'}
                onChange={() => setScope('merchant')}
                className="h-[15px] w-[15px] shrink-0 accent-accent"
              />
              <span className="truncate">Always for “{scopeChoice.payee}”</span>
            </label>
            {scope === 'merchant' && (
              <label className="mt-1.5 ml-6 flex cursor-pointer items-center gap-2.5 py-1 text-xs font-medium text-muted">
                <input
                  type="checkbox"
                  checked={applyToExisting}
                  onChange={(e) => setApplyToExisting(e.target.checked)}
                  className="h-[15px] w-[15px] shrink-0 accent-accent"
                />
                <span>
                  Also update <span className="mx-0.5 font-mono">{scopeChoice.pastCount}</span> past transaction
                  {scopeChoice.pastCount === 1 ? '' : 's'}
                </span>
              </label>
            )}
          </fieldset>
        )}

        {error !== null && (
          <p role="alert" className="border-t border-white/7 px-3.5 py-2 text-xs text-neg">
            {error}
          </p>
        )}

        <div className="flex gap-2 border-t border-white/7 px-3.5 py-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 cursor-pointer rounded-lg border border-white/14 bg-transparent p-2 text-[12.5px] font-semibold text-ink transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!canConfirm}
            className={`flex-1 rounded-lg border-0 p-2 text-[12.5px] font-semibold transition-colors ${
              canConfirm
                ? 'cursor-pointer bg-accent text-white hover:bg-accent-deep'
                : 'cursor-not-allowed bg-accent/35 text-white/50'
            }`}
          >
            {busy ? 'Applying…' : label}
          </button>
        </div>
      </div>
    </>
  )
}
