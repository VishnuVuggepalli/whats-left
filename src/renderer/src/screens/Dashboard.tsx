import { useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { getApi } from '../lib/api'
import { addMonths, centsToCompact, centsToDisplay, currentMonth, monthLabel } from '../lib/format'
import { useLoad } from '../lib/useLoad'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { MoneyText } from '../components/MoneyText'

const api = getApi()

const TOOLTIP_STYLE = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-line)',
  borderRadius: 8,
  color: 'var(--color-ink)',
  fontSize: 12,
} as const

const AXIS_TICK = { fill: 'var(--chart-muted)', fontSize: 12 } as const

function formatCents(value: unknown): string {
  return centsToDisplay(Math.round(Number(value)))
}

export function Dashboard() {
  const [month, setMonth] = useState(currentMonth())
  const { data, error, loading } = useLoad(() => api.getDashboard(month), [month])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Dashboard</h1>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setMonth(addMonths(month, -1))}>
            ←
          </Button>
          <span className="w-24 text-center font-medium">{monthLabel(month)}</span>
          <Button variant="ghost" disabled={month >= currentMonth()} onClick={() => setMonth(addMonths(month, 1))}>
            →
          </Button>
        </div>
      </div>

      {loading && <p className="text-muted">Loading dashboard…</p>}
      {error !== null && <p className="text-neg">Failed to load dashboard: {error}</p>}

      {data !== null && !loading && error === null && (
        <>
          {data.paymentsIntegrity.diverges && (
            <div className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
              <strong>Payments integrity check failed for {monthLabel(month)}.</strong> Card payments seen leaving
              checking ({centsToDisplay(-data.paymentsIntegrity.checkingSideCents)}) don't match payments received on
              cards ({centsToDisplay(data.paymentsIntegrity.cardSideCents)}) — a payment row may have leaked into
              spend.
            </div>
          )}

          <KpiRow data={data} />

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card title={`Net spend by category — ${monthLabel(month)}`}>
              <CategoryBars data={data} />
            </Card>
            <Card title="12-month trend">
              <TrendLines data={data} />
            </Card>
          </div>

          <Card title={`Top merchants — ${monthLabel(month)}`}>
            {data.topMerchants.length === 0 ? (
              <p className="text-muted">No spend this month.</p>
            ) : (
              <ul className="divide-y divide-line/60">
                {data.topMerchants.map((m) => (
                  <li key={m.payee} className="flex items-center justify-between py-2">
                    <span>
                      {m.payee}
                      <span className="ml-2 text-xs text-muted">
                        {m.count} txn{m.count === 1 ? '' : 's'}
                      </span>
                    </span>
                    <MoneyText cents={m.netCents} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  )
}

type DashboardDto = Awaited<ReturnType<typeof api.getDashboard>>

function KpiRow({ data }: { data: DashboardDto }) {
  const current = data.trend[data.trend.length - 1]
  const previous = data.trend[data.trend.length - 2]
  const spend = current?.spendCents ?? 0
  const momDelta = previous === undefined ? null : spend - previous.spendCents
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Card>
        <p className="text-xs text-muted uppercase">Spend</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{centsToDisplay(spend)}</p>
        {momDelta !== null && (
          <p className={`mt-1 text-xs ${momDelta > 0 ? 'text-neg' : 'text-pos'}`}>
            {momDelta >= 0 ? '+' : ''}
            {centsToDisplay(momDelta)} vs last month
          </p>
        )}
      </Card>
      <Card>
        <p className="text-xs text-muted uppercase">Income</p>
        <p className="mt-1 text-2xl font-semibold text-pos tabular-nums">{centsToDisplay(current?.incomeCents ?? 0)}</p>
      </Card>
      <Card>
        <p className="text-xs text-muted uppercase">Pending</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{centsToDisplay(data.pendingCents)}</p>
        {data.pendingCents !== 0 && (
          <Badge tone="warn" className="mt-1">
            excluded from totals
          </Badge>
        )}
      </Card>
      <Card>
        <p className="text-xs text-muted uppercase">Payments check</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">
          {data.paymentsIntegrity.diverges ? '✕' : '✓'}
        </p>
        <Badge tone={data.paymentsIntegrity.diverges ? 'warn' : 'ok'} className="mt-1">
          {data.paymentsIntegrity.diverges ? 'diverges' : 'balanced'}
        </Badge>
      </Card>
    </div>
  )
}

function CategoryBars({ data }: { data: DashboardDto }) {
  // Spend definition (§4): net-negative categories chart as positive spend;
  // net-positive (refund-dominated) categories are clamped out of the chart
  // and listed separately instead of rendering as negative bars.
  const bars = data.byCategory
    .filter((c) => c.netCents < 0)
    .map((c) => ({ name: c.categoryName, spend: -c.netCents }))
  const clamped = data.byCategory.filter((c) => c.netCents > 0)
  if (bars.length === 0) return <p className="text-muted">No categorized spend this month.</p>
  return (
    <>
      <ResponsiveContainer width="100%" height={Math.max(180, bars.length * 36)}>
        <BarChart data={bars} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
          <XAxis
            type="number"
            tick={AXIS_TICK}
            tickFormatter={(v) => centsToCompact(Math.round(Number(v)))}
            stroke="var(--chart-grid)"
          />
          <YAxis type="category" dataKey="name" width={130} tick={AXIS_TICK} stroke="var(--chart-grid)" />
          <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--color-raised)' }} formatter={formatCents} />
          <Bar dataKey="spend" name="Net spend" fill="var(--chart-1)" radius={[0, 4, 4, 0]} barSize={14} />
        </BarChart>
      </ResponsiveContainer>
      {clamped.length > 0 && (
        <p className="mt-2 text-xs text-muted">
          Net refunds (excluded from chart):{' '}
          {clamped.map((c) => `${c.categoryName} ${centsToDisplay(c.netCents)}`).join(', ')}
        </p>
      )}
    </>
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
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={points} margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis
          dataKey="month"
          tick={AXIS_TICK}
          tickFormatter={(m) => monthLabel(String(m)).slice(0, 3)}
          stroke="var(--chart-grid)"
        />
        <YAxis tick={AXIS_TICK} tickFormatter={(v) => centsToCompact(Math.round(Number(v)))} stroke="var(--chart-grid)" />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(m) => monthLabel(String(m))}
          formatter={formatCents}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="Spend" stroke="var(--chart-1)" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="Income" stroke="var(--chart-2)" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}
