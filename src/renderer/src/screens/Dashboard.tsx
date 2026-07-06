/**
 * Dashboard per the design: integrity banner, month stepper (← → keys),
 * pending pill, hero spend figure + MoM delta, "Where it went" category bars
 * with value labels + refunds line, top merchants, 12-month spend-vs-income
 * trend with two line styles (solid spend / dashed income).
 */
import { useEffect, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { TabId } from '../App'
import { getApi } from '../lib/api'
import { categoryColor } from '../lib/categoryColors'
import {
  addMonths,
  centsToDisplay,
  currentMonth,
  monthLabel,
  monthLabelFull,
  monthNameFull,
} from '../lib/format'
import { useLoad } from '../lib/useLoad'
import { Banner, BannerAction } from '../components/Banner'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import { Skeleton } from '../components/Skeleton'
import {
  IconBank,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconDownload,
  IconRefresh,
  IconTrendDown,
  IconTrendUp,
  IconUndo,
  IconWarning,
} from '../components/Icons'

const api = getApi()

const TOOLTIP_STYLE = {
  background: '#0B1222',
  border: '1px solid rgba(255,255,255,0.13)',
  borderRadius: 8,
  color: 'var(--color-ink)',
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
} as const

function formatCents(value: unknown): string {
  return centsToDisplay(Math.round(Number(value)))
}

type DashboardDto = Awaited<ReturnType<typeof api.getDashboard>>

function isTypingTarget(target: EventTarget | null): boolean {
  const tag = target instanceof HTMLElement ? target.tagName : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export interface DashboardProps {
  go: (tab: TabId) => void
}

export function Dashboard({ go }: DashboardProps) {
  const [month, setMonth] = useState(currentMonth())
  const [dismissedBannerMonth, setDismissedBannerMonth] = useState<string | null>(null)
  const { data, error, loading, reload } = useLoad(() => api.getDashboard(month), [month])

  const atCurrentMonth = month >= currentMonth()

  // Design: ← / → step the month when not typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setMonth((m) => addMonths(m, -1))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setMonth((m) => (m >= currentMonth() ? m : addMonths(m, 1)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (loading) return <DashboardSkeleton />

  if (error !== null) {
    return (
      <EmptyState
        tone="danger"
        icon={<IconWarning size={24} strokeWidth={1.8} />}
        title="Couldn't load your dashboard"
        body={error}
        actions={
          <>
            <Button onClick={reload}>
              <IconRefresh size={15} />
              Retry
            </Button>
            <Button variant="secondary" onClick={() => go('accounts')}>
              View accounts
            </Button>
          </>
        }
      />
    )
  }

  if (data === null) return null

  const hasAnyData =
    data.byCategory.length > 0 ||
    data.topMerchants.length > 0 ||
    data.pendingCents !== 0 ||
    data.trend.some((t) => t.spendCents !== 0 || t.incomeCents !== 0)

  if (!hasAnyData) {
    return (
      <EmptyState
        icon={<IconDownload size={24} strokeWidth={1.8} />}
        title="Nothing here yet"
        body="Import a CSV or connect a bank to see where your money goes."
        actions={
          <>
            <Button onClick={() => go('import')}>
              <IconDownload size={15} />
              Import a CSV
            </Button>
            <Button variant="secondary" onClick={() => go('accounts')}>
              <IconBank size={15} />
              Connect a bank
            </Button>
          </>
        }
      />
    )
  }

  const current = data.trend[data.trend.length - 1]
  const previous = data.trend[data.trend.length - 2]
  const spend = Math.abs(current?.spendCents ?? 0)
  const momDelta = previous === undefined ? null : spend - Math.abs(previous.spendCents)
  const showBanner = data.paymentsIntegrity.diverges && dismissedBannerMonth !== month

  return (
    <div className="mx-auto max-w-[1180px] px-[30px] pt-6 pb-11">
      {showBanner && (
        <Banner
          tone="warn"
          className="mb-5"
          action={<BannerAction onClick={() => go('transactions')}>Review</BannerAction>}
          onDismiss={() => setDismissedBannerMonth(month)}
        >
          <strong className="font-semibold">Card payments don't match across accounts.</strong> Checking sent{' '}
          <span className="font-mono">{centsToDisplay(data.paymentsIntegrity.checkingSideCents)}</span> but cards
          received <span className="font-mono">{centsToDisplay(data.paymentsIntegrity.cardSideCents)}</span> in{' '}
          {monthLabel(month)} — a payment row may have leaked into spend.
        </Banner>
      )}

      <div className="mb-6 flex items-center justify-between">
        <div className="inline-flex items-center gap-1">
          <Button
            variant="secondary"
            size="sm"
            className="!p-1.5"
            aria-label="Previous month"
            onClick={() => setMonth(addMonths(month, -1))}
          >
            <IconChevronLeft size={16} />
          </Button>
          <div className="min-w-[132px] text-center text-sm font-semibold text-white">{monthLabelFull(month)}</div>
          <Button
            variant="secondary"
            size="sm"
            className="!p-1.5"
            aria-label="Next month"
            disabled={atCurrentMonth}
            onClick={() => setMonth(addMonths(month, 1))}
          >
            <IconChevronRight size={16} />
          </Button>
          <span className="ml-2.5 text-[11px] font-medium text-ghost">Use ← → to change month</span>
        </div>
        {data.pendingCents !== 0 && (
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-warn-deep/13 px-3 py-[5px] text-xs font-medium text-warn"
            role="status"
          >
            <IconClock size={13} />
            <span className="font-mono">{centsToDisplay(Math.abs(data.pendingCents))}</span> pending · excluded from
            totals
          </span>
        )}
      </div>

      <div className="mb-8">
        <div className="mb-2.5 text-xs font-medium tracking-[0.07em] text-muted uppercase">
          Spent in {monthNameFull(month)}
        </div>
        <div className="font-mono text-[clamp(2.5rem,5.5vw,4rem)] leading-none font-bold tracking-tight text-white tabular-nums">
          {centsToDisplay(spend)}
        </div>
        <div className="mt-3.5 flex items-center gap-2 text-[13px] font-medium text-muted">
          {momDelta !== null && (momDelta > 0 ? <IconTrendUp size={15} /> : <IconTrendDown size={15} />)}
          <span className="font-mono text-ink-dim">
            {momDelta === null
              ? 'No prior month'
              : `${momDelta >= 0 ? '+' : '−'}${centsToDisplay(Math.abs(momDelta))} vs ${monthNameFull(addMonths(month, -1))}`}
          </span>
        </div>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-5 xl:grid-cols-[1.4fr_1fr]">
        <Card title="Where it went" subtitle="By category · sorted by spend">
          <CategoryBars data={data} />
        </Card>
        <Card title="Top merchants" subtitle="This month · by net spend">
          <TopMerchants data={data} />
        </Card>
      </div>

      <Card
        title="Spend vs income"
        subtitle="Last 12 months"
        actions={
          <div className="flex items-center gap-4" aria-hidden="true">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-dim">
              <svg width="22" height="8">
                <line x1="0" y1="4" x2="22" y2="4" stroke="#E2E8F0" strokeWidth="2" />
              </svg>
              Spend
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
              <svg width="22" height="8">
                <line x1="0" y1="4" x2="22" y2="4" stroke="#64748B" strokeWidth="2" strokeDasharray="4 3" />
              </svg>
              Income
            </span>
          </div>
        }
      >
        <TrendLines data={data} />
      </Card>
    </div>
  )
}

function CategoryBars({ data }: { data: DashboardDto }) {
  // Spend definition (§4): net-negative categories chart as positive spend;
  // net-positive (refund-dominated) categories aggregate into the refunds
  // line below instead of rendering as negative bars.
  const bars = data.byCategory
    .filter((c) => c.netCents < 0)
    .map((c) => ({ name: c.categoryName, spend: -c.netCents, color: categoryColor(c.categoryId) }))
    .sort((a, b) => b.spend - a.spend)
  const refundCents = data.byCategory.filter((c) => c.netCents > 0).reduce((sum, c) => sum + c.netCents, 0)

  if (bars.length === 0) return <p className="text-muted">No categorized spend this month.</p>

  return (
    <>
      <ResponsiveContainer width="100%" height={Math.max(120, bars.length * 33 + 16)}>
        <BarChart data={bars} layout="vertical" margin={{ top: 4, right: 84, bottom: 4, left: 4 }}>
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="name"
            width={110}
            tickLine={false}
            axisLine={false}
            tick={{ fill: 'var(--color-ink-dim)', fontSize: 12, fontFamily: 'var(--font-sans)' }}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            formatter={formatCents}
          />
          <Bar dataKey="spend" name="Net spend" radius={[0, 5, 5, 0]} barSize={22} background={{ fill: 'rgba(255,255,255,0.04)', radius: 5 }}>
            {bars.map((b) => (
              <Cell key={b.name} fill={b.color} />
            ))}
            <LabelList
              dataKey="spend"
              position="right"
              formatter={(v: unknown) => formatCents(v)}
              style={{ fill: 'var(--color-ink)', fontSize: 13, fontFamily: 'var(--font-mono)', fontWeight: 500 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {refundCents > 0 && (
        <div className="mt-3.5 flex items-center justify-between border-t border-line pt-3.5">
          <span className="inline-flex items-center gap-2 text-xs font-medium text-muted">
            <IconUndo size={14} className="text-pos" />
            Refunds received
          </span>
          <span className="font-mono text-[13px] font-medium text-pos">+{centsToDisplay(refundCents)}</span>
        </div>
      )}
    </>
  )
}

function TopMerchants({ data }: { data: DashboardDto }) {
  if (data.topMerchants.length === 0) return <p className="text-muted">No spend this month.</p>
  return (
    <ol className="m-0 list-none p-0">
      {data.topMerchants.map((m, i) => (
        <li key={m.payee} className="flex items-center gap-3 border-b border-white/5 py-2 last:border-b-0">
          <span className="w-4 shrink-0 text-right font-mono text-xs font-medium text-ghost" aria-hidden="true">
            {i + 1}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
            {m.payee}
            <span className="ml-2 text-xs text-faint">
              {m.count} txn{m.count === 1 ? '' : 's'}
            </span>
          </span>
          <span className="shrink-0 font-mono text-[13px] font-medium text-ink">
            {centsToDisplay(Math.abs(m.netCents))}
          </span>
        </li>
      ))}
    </ol>
  )
}

function TrendLines({ data }: { data: DashboardDto }) {
  // Math.abs: renderer tolerates either sign convention for trend values.
  const points = data.trend.map((t) => ({
    month: t.month,
    Spend: Math.abs(t.spendCents),
    Income: Math.abs(t.incomeCents),
  }))
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={points} margin={{ top: 6, right: 12, bottom: 0, left: 12 }}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis
          dataKey="month"
          tickLine={false}
          axisLine={false}
          tick={{ fill: 'var(--color-ghost)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
          tickFormatter={(m) => monthLabel(String(m)).slice(0, 3)}
        />
        <YAxis hide domain={['auto', 'auto']} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelStyle={{ color: 'var(--color-muted)', fontFamily: 'var(--font-sans)', marginBottom: 4 }}
          labelFormatter={(m) => monthLabelFull(String(m))}
          formatter={formatCents}
        />
        {/* Two line STYLES (not just colors): solid spend vs dashed income. */}
        <Line
          type="monotone"
          dataKey="Income"
          stroke="#64748B"
          strokeWidth={1.5}
          strokeDasharray="5 4"
          dot={false}
          activeDot={{ r: 3.5, fill: 'var(--color-bg)', stroke: '#94A3B8', strokeWidth: 1.5 }}
        />
        <Line
          type="monotone"
          dataKey="Spend"
          stroke="#E2E8F0"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 3.5, fill: 'var(--color-bg)', stroke: '#E2E8F0', strokeWidth: 2 }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

function DashboardSkeleton() {
  return (
    <div className="mx-auto max-w-[1180px] px-[30px] pt-6 pb-11" aria-busy="true" aria-label="Loading dashboard">
      <Skeleton className="mb-6 h-[13px] w-[150px] rounded-md" />
      <Skeleton className="mb-3.5 h-3 w-[110px] rounded-md" />
      <Skeleton className="mb-3.5 h-[58px] w-[300px] rounded-lg" />
      <Skeleton className="mb-8 h-3 w-[170px] rounded-md" />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.4fr_1fr]">
        <div className="rounded-xl border border-line bg-surface p-5">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="mb-[11px] h-[22px]" />
          ))}
        </div>
        <div className="rounded-xl border border-line bg-surface p-5">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="mb-3.5 h-[18px]" />
          ))}
        </div>
      </div>
      <div className="mt-5 h-[238px] rounded-xl border border-line bg-surface" />
    </div>
  )
}
