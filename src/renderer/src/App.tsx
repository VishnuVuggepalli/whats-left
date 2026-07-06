/**
 * App shell per the design: 52px top header (logo, horizontal nav with
 * active underline + review-count badge, connection-health pill), then a
 * 52px title row with the "Left, 12 mo" figure, then the scrolling screen.
 * The design's Goals screen is out of scope — no nav item for it.
 */
import { useState } from 'react'
import { getApi } from './lib/api'
import { currentMonth } from './lib/format'
import { useLoad } from './lib/useLoad'
import { formatSignedMoney } from './components/Money'
import { IconLogo, IconWarning } from './components/Icons'
import { Accounts } from './screens/Accounts'
import { Dashboard } from './screens/Dashboard'
import { Import } from './screens/Import'
import { Review } from './screens/Review'
import { Settings } from './screens/Settings'
import { Transactions } from './screens/Transactions'

const api = getApi()

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'import', label: 'Import' },
  { id: 'review', label: 'Review' },
  { id: 'settings', label: 'Settings' },
] as const

export type TabId = (typeof TABS)[number]['id']

export function App() {
  const [tab, setTab] = useState<TabId>('dashboard')

  // Header adornments: review-queue badge + account-health pill. Reloaded on
  // every tab switch so they stay fresh as the user works; failures here are
  // non-fatal (each screen surfaces its own errors) so we render nothing.
  const header = useLoad(async () => {
    const [reviewItems, accounts] = await Promise.all([api.listReviewQueue(), api.listAccounts()])
    return { reviewCount: reviewItems.length, accounts }
  }, [tab])

  // "Left, 12 mo" — income minus spend over the trailing year (the app's
  // namesake figure, shown in the title row on every screen per the design).
  const annual = useLoad(() => api.getDashboard(currentMonth()), [tab])
  const annualNet =
    annual.data !== null
      ? annual.data.trend.reduce((sum, t) => sum + t.incomeCents - t.spendCents, 0)
      : null

  const reviewCount = header.data?.reviewCount ?? 0
  const attention =
    header.data?.accounts.filter((a) => a.sourceKind === 'teller' && a.status !== 'ok' && !a.closed).length ?? 0

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="relative z-30 flex h-[52px] shrink-0 items-center border-b border-line bg-bg/72 px-5 backdrop-blur-xl">
        <div className="mr-7 flex shrink-0 items-center gap-2.5">
          <div className="flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-[7px] bg-accent text-white">
            <IconLogo size={13} />
          </div>
          <span className="text-sm font-semibold tracking-tight whitespace-nowrap text-white">What's Left</span>
        </div>

        <nav className="flex shrink-0 items-center gap-px" aria-label="Main">
          {TABS.map((t) => {
            const active = tab === t.id
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={active ? 'page' : undefined}
                className={`relative flex h-[52px] cursor-pointer items-center gap-1.5 border-0 bg-transparent px-3 text-[13px] font-medium whitespace-nowrap transition-colors ${
                  active ? 'text-white' : 'text-muted hover:text-white'
                }`}
              >
                {t.label}
                {t.id === 'review' && reviewCount > 0 && (
                  <span
                    className="rounded-full bg-warn-deep/20 px-1.5 py-px font-mono text-[10px] font-semibold text-warn"
                    aria-label={`${reviewCount} to review`}
                  >
                    {reviewCount}
                  </span>
                )}
                <span
                  aria-hidden="true"
                  className={`absolute right-3 bottom-0 left-3 h-0.5 rounded-t-sm ${active ? 'bg-accent' : 'bg-transparent'}`}
                />
              </button>
            )
          })}
        </nav>

        <div className="flex flex-1 items-center justify-end gap-2">
          {attention > 0 ? (
            <button
              type="button"
              onClick={() => setTab('accounts')}
              className="flex cursor-pointer items-center gap-1.5 rounded-full border border-warn-deep/32 bg-warn-deep/9 px-2.5 py-[5px] text-[11.5px] font-medium whitespace-nowrap text-warn transition-colors hover:bg-warn-deep/15"
            >
              <IconWarning size={13} className="shrink-0" />
              {attention} account{attention === 1 ? '' : 's'} need{attention === 1 ? 's' : ''} attention
            </button>
          ) : (
            header.data !== null &&
            header.data.accounts.length > 0 && (
              <div className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-[5px] text-[11.5px] font-medium whitespace-nowrap text-muted">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-pos-deep" aria-hidden="true" />
                All connections healthy
              </div>
            )
          )}
        </div>
      </header>

      <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-white/6 px-[30px]">
        <div className="flex min-w-0 items-center gap-4">
          <h1 className="m-0 text-base font-semibold tracking-tight text-white">
            {TABS.find((t) => t.id === tab)?.label}
          </h1>
          {annualNet !== null && (
            <div className="flex items-center gap-2.5">
              <span className="h-4 w-px bg-white/12" aria-hidden="true" />
              <span className="text-[11px] font-medium text-faint">Left, 12 mo</span>
              <span className={`font-mono text-[13px] font-semibold ${annualNet >= 0 ? 'text-pos' : 'text-ink'}`}>
                {formatSignedMoney(annualNet)}
              </span>
            </div>
          )}
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <ActiveScreen tab={tab} go={setTab} />
      </main>
    </div>
  )
}

function ActiveScreen({ tab, go }: { tab: TabId; go: (tab: TabId) => void }) {
  switch (tab) {
    case 'dashboard':
      return <Dashboard go={go} />
    case 'transactions':
      return <Transactions go={go} />
    case 'accounts':
      return <Accounts go={go} />
    case 'import':
      return <Import go={go} />
    case 'review':
      return <Review go={go} />
    case 'settings':
      return <Settings />
  }
}
