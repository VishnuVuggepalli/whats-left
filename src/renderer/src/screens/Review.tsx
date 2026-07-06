/**
 * Review queue per the design: dense rows (payee / raw / date, amount,
 * suggested category with confidence as WORDS — "likely" / "unsure"),
 * per-row Accept ✓ and Change (category popover), an Accept-all-likely
 * header action, and the "All caught up" success empty state.
 * ↑ ↓ move the active row, Enter accepts it.
 */
import { useEffect, useState } from 'react'
import type { CategoryDto, ReviewItem } from '../../../shared/types'
import type { TabId } from '../App'
import { getApi } from '../lib/api'
import { categoryColor } from '../lib/categoryColors'
import { shortDate } from '../lib/format'
import { errorMessage, useLoad } from '../lib/useLoad'
import { Banner } from '../components/Banner'
import { Button } from '../components/Button'
import { CategoryPopover } from '../components/CategoryPopover'
import type { PopoverAnchor } from '../components/CategoryPopover'
import { EmptyState } from '../components/EmptyState'
import { Money } from '../components/Money'
import { Skeleton } from '../components/Skeleton'
import { IconCheck, IconRefresh, IconWarning } from '../components/Icons'

const api = getApi()

/** Confidence is shown as words, never raw percentages (design). */
const LIKELY_THRESHOLD = 0.6
const isLikely = (item: ReviewItem): boolean => item.confidence >= LIKELY_THRESHOLD

function isTypingTarget(target: EventTarget | null): boolean {
  const tag = target instanceof HTMLElement ? target.tagName : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export interface ReviewProps {
  go: (tab: TabId) => void
}

export function Review({ go }: ReviewProps) {
  const queue = useLoad(() => api.listReviewQueue(), [])
  const categoriesLoad = useLoad(() => api.listCategories(), [])
  const [activeIdx, setActiveIdx] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [popover, setPopover] = useState<{ item: ReviewItem; anchor: PopoverAnchor } | null>(null)
  const [popoverBusy, setPopoverBusy] = useState(false)
  const [popoverError, setPopoverError] = useState<string | null>(null)

  const items = queue.data ?? []
  const categories = categoriesLoad.data ?? []
  const likelyCount = items.filter(isLikely).length

  const accept = async (item: ReviewItem, categoryId: string = item.suggestedCategoryId): Promise<void> => {
    setBusyId(item.txnId)
    setActionError(null)
    try {
      await api.resolveReview(item.txnId, categoryId)
      queue.reload()
    } catch (err: unknown) {
      setActionError(errorMessage(err))
    } finally {
      setBusyId(null)
    }
  }

  const acceptAllLikely = async (): Promise<void> => {
    setBusyId('__all__')
    setActionError(null)
    try {
      for (const item of items.filter(isLikely)) {
        await api.resolveReview(item.txnId, item.suggestedCategoryId)
      }
      queue.reload()
    } catch (err: unknown) {
      setActionError(errorMessage(err))
    } finally {
      setBusyId(null)
    }
  }

  // Keyboard: ↑ ↓ move, Enter accepts the active row.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (popover !== null || isTypingTarget(e.target) || items.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx((i) => Math.min(items.length - 1, i + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((i) => Math.max(0, i - 1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const item = items[Math.min(activeIdx, items.length - 1)]
        if (item !== undefined && busyId === null) void accept(item)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- items identity churns per load
  }, [items, activeIdx, popover, busyId])

  if (queue.loading || categoriesLoad.loading) return <ReviewSkeleton />

  const loadError = queue.error ?? categoriesLoad.error
  if (loadError !== null) {
    return (
      <EmptyState
        tone="danger"
        icon={<IconWarning size={24} strokeWidth={1.8} />}
        title="Couldn't load the review queue"
        body={loadError}
        actions={
          <>
            <Button
              onClick={() => {
                queue.reload()
                categoriesLoad.reload()
              }}
            >
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

  if (items.length === 0) {
    return (
      <EmptyState
        tone="success"
        icon={<IconCheck size={26} strokeWidth={2} />}
        title="All caught up ✓"
        body="Every transaction is categorized. New uncertain ones will show up here after the next sync."
      />
    )
  }

  return (
    <div className="mx-auto max-w-[1000px] px-[30px] pt-6 pb-11">
      <div className="mb-[18px] flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[15px] font-semibold text-white">Needs your review</div>
          <div className="mt-0.5 text-xs font-medium text-faint">
            <span className="font-mono">{items.length}</span> transaction{items.length === 1 ? '' : 's'} the local
            model wasn't sure how to categorize · use ↑ ↓ and Enter
          </div>
        </div>
        {likelyCount > 0 && (
          <Button variant="secondary" size="sm" disabled={busyId !== null} onClick={() => void acceptAllLikely()}>
            <IconCheck size={14} />
            {busyId === '__all__' ? 'Accepting…' : (
              <>
                Accept all likely (<span className="font-mono">{likelyCount}</span>)
              </>
            )}
          </Button>
        )}
      </div>

      {actionError !== null && (
        <Banner tone="danger" className="mb-3.5" onDismiss={() => setActionError(null)}>
          {actionError}
        </Banner>
      )}

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {items.map((item, idx) => (
          <ReviewRow
            key={item.txnId}
            item={item}
            categories={categories}
            active={idx === activeIdx}
            busy={busyId !== null}
            onAccept={() => void accept(item)}
            onChange={(anchor) => {
              setPopoverError(null)
              setPopover({ item, anchor })
            }}
          />
        ))}
      </div>

      {popover !== null && (
        <CategoryPopover
          anchor={popover.anchor}
          title="Change category"
          payee={popover.item.payee}
          categories={categories}
          initialCategoryId={popover.item.suggestedCategoryId}
          confirmLabel="Accept"
          busy={popoverBusy}
          error={popoverError}
          onConfirm={(result) => {
            setPopoverBusy(true)
            setPopoverError(null)
            api.resolveReview(popover.item.txnId, result.categoryId).then(
              () => {
                setPopoverBusy(false)
                setPopover(null)
                queue.reload()
              },
              (err: unknown) => {
                setPopoverBusy(false)
                setPopoverError(errorMessage(err))
              },
            )
          }}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  )
}

interface ReviewRowProps {
  item: ReviewItem
  categories: CategoryDto[]
  active: boolean
  busy: boolean
  onAccept: () => void
  onChange: (anchor: PopoverAnchor) => void
}

function ReviewRow({ item, categories, active, busy, onAccept, onChange }: ReviewRowProps) {
  const category = categories.find((c) => c.id === item.suggestedCategoryId)
  const likely = isLikely(item)
  return (
    <div
      className={`flex items-center gap-4 border-b border-white/5 px-[18px] py-[13px] transition-colors last:border-b-0 ${
        active ? 'bg-accent/6' : ''
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium text-white">{item.payee}</div>
        <div className="mt-0.5 truncate font-mono text-[11px] font-medium text-faint" title={item.rawDescription}>
          {item.rawDescription} · {shortDate(item.txnDate)}
        </div>
      </div>
      <div className="w-[88px] shrink-0 text-right">
        <Money cents={item.amountCents} className="text-sm font-semibold" />
      </div>
      <div className="flex w-[178px] shrink-0 flex-col gap-1.5">
        <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ink-dim">
          <span
            className="h-2 w-2 shrink-0 rounded-[2px]"
            style={{ background: categoryColor(item.suggestedCategoryId, category) }}
            aria-hidden="true"
          />
          {category?.name ?? item.suggestedCategoryId}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-semibold tracking-[0.06em] text-ghost uppercase">Suggested</span>
          <span
            className={`rounded-[5px] px-[7px] py-0.5 text-[10px] font-semibold ${
              likely ? 'bg-white/5 text-muted' : 'bg-warn-deep/12 text-warn'
            }`}
          >
            {likely ? 'likely' : 'unsure'}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            onChange({ left: rect.left, top: rect.top, bottom: rect.bottom })
          }}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/12 bg-transparent px-3 py-[7px] text-xs font-semibold text-muted transition-colors hover:border-white/24 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          Change
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onAccept}
          aria-label={`Accept ${category?.name ?? 'suggested category'} for ${item.payee}`}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-pos-deep/40 bg-pos-deep/12 px-[13px] py-[7px] text-xs font-semibold text-pos transition-colors hover:bg-pos-deep/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <IconCheck size={14} strokeWidth={2.2} />
          Accept
        </button>
      </div>
    </div>
  )
}

function ReviewSkeleton() {
  return (
    <div className="mx-auto max-w-[1000px] px-[30px] pt-6 pb-11" aria-busy="true" aria-label="Loading review queue">
      <Skeleton className="mb-5 h-3.5 w-[200px] rounded-md" />
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-white/5 px-[18px] py-[15px] last:border-b-0">
            <div className="flex-1">
              <Skeleton className="mb-2 h-3 w-2/5" />
              <Skeleton className="h-2.5 w-3/5" />
            </div>
            <Skeleton className="h-5 w-[120px] rounded-md" />
            <Skeleton className="h-[30px] w-[150px] rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  )
}
