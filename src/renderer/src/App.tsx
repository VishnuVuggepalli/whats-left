import { useState } from 'react'
import { Accounts } from './screens/Accounts'
import { Dashboard } from './screens/Dashboard'
import { Import } from './screens/Import'
import { Review } from './screens/Review'
import { Settings } from './screens/Settings'
import { Transactions } from './screens/Transactions'

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'import', label: 'Import' },
  { id: 'review', label: 'Review' },
  { id: 'settings', label: 'Settings' },
] as const

type TabId = (typeof TABS)[number]['id']

export function App() {
  const [tab, setTab] = useState<TabId>('dashboard')

  return (
    <div className="flex h-full">
      <aside className="flex w-52 shrink-0 flex-col border-r border-line bg-surface">
        <div className="px-4 py-5">
          <p className="text-base font-bold tracking-tight">What's Left</p>
          <p className="text-xs text-muted">local-first expense tracker</p>
        </div>
        <nav className="flex flex-col gap-0.5 px-2" aria-label="Main">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
                tab === t.id ? 'bg-accent/15 text-accent' : 'text-ink-dim hover:bg-raised hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        <ActiveScreen tab={tab} />
      </main>
    </div>
  )
}

function ActiveScreen({ tab }: { tab: TabId }) {
  switch (tab) {
    case 'dashboard':
      return <Dashboard />
    case 'transactions':
      return <Transactions />
    case 'accounts':
      return <Accounts />
    case 'import':
      return <Import />
    case 'review':
      return <Review />
    case 'settings':
      return <Settings />
  }
}
