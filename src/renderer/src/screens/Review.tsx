import { useState } from 'react'
import type { ReviewItem } from '../../../shared/types'
import { getApi } from '../lib/api'
import { errorMessage, useLoad } from '../lib/useLoad'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { MoneyText } from '../components/MoneyText'

const api = getApi()

const SELECT_CLASS =
  'rounded-md border border-line bg-raised px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none'

export function Review() {
  const queue = useLoad(() => api.listReviewQueue(), [])
  const categories = useLoad(() => api.listCategories(), [])

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-lg font-semibold">Review queue</h1>
      <p className="text-sm text-muted">
        Low-confidence categorizations from the local LLM. Confirm or fix — your choice is remembered for the
        merchant.
      </p>
      {queue.error !== null && <p className="text-neg">Failed to load review queue: {queue.error}</p>}
      {categories.error !== null && <p className="text-neg">Failed to load categories: {categories.error}</p>}
      {queue.loading && <p className="text-muted">Loading queue…</p>}
      {queue.data !== null && !queue.loading && queue.data.length === 0 && (
        <Card>
          <p className="text-muted">Nothing to review — the resolver is confident about everything.</p>
        </Card>
      )}
      {(queue.data ?? []).map((item) => (
        <ReviewRow key={item.txnId} item={item} categories={categories.data ?? []} onResolved={queue.reload} />
      ))}
    </div>
  )
}

interface RowProps {
  item: ReviewItem
  categories: Array<{ id: string; name: string }>
  onResolved: () => void
}

function ReviewRow({ item, categories, onResolved }: RowProps) {
  const [categoryId, setCategoryId] = useState(item.suggestedCategoryId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.resolveReview(item.txnId, categoryId)
      onResolved()
    } catch (err: unknown) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            {item.payee} <span className="ml-1 text-xs text-muted">{item.txnDate}</span>
          </p>
          <p className="max-w-105 truncate text-xs text-muted" title={item.rawDescription}>
            {item.rawDescription}
          </p>
        </div>
        <MoneyText cents={item.amountCents} />
        <Badge tone={item.confidence < 0.6 ? 'danger' : 'warn'}>{Math.round(item.confidence * 100)}% confident</Badge>
        <div className="flex items-center gap-2">
          <select
            className={SELECT_CLASS}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            aria-label={`Category for ${item.payee}`}
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <Button disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Saving…' : 'Confirm'}
          </Button>
        </div>
      </div>
      {error !== null && <p className="mt-2 text-sm text-neg">{error}</p>}
    </Card>
  )
}
