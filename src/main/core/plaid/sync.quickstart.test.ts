import { describe, expect, it } from 'vitest'
import { PlaidApiError } from './client'
import { PlaidFetchTransport } from './transport'
import { PlaidSyncEngine, type PlaidSyncClientPort } from './sync'
import type { PlaidSyncResponse } from './types'
import { FakePlaidRepo, MemoryCursorStore, mkPage } from './syncTestSupport'

/**
 * Behaviors verified against Plaid's canonical quickstart (github.com/plaid/quickstart):
 * empty-next_cursor initial-sync wait, mutation-during-pagination restart from
 * the persisted cursor, and the pinned Plaid-Version header.
 */

const ACCOUNTS = [{ id: 'acc-local-1', plaidAccountId: 'plaid-acc-1' }]
const INPUT = { itemId: 'item-1', accessToken: 'access-token', accounts: ACCOUNTS }

const emptyReconcile = () => ({ decisions: [], inserted: 0, matched: 0, skipped: 0 })

function notReadyPage(): PlaidSyncResponse {
  return mkPage({ next_cursor: '', has_more: false })
}

class ScriptedClient implements PlaidSyncClientPort {
  readonly seenCursors: Array<string | undefined> = []
  constructor(private script: Array<PlaidSyncResponse | PlaidApiError>) {}
  async transactionsSync(_token: string, cursor?: string): Promise<PlaidSyncResponse> {
    this.seenCursors.push(cursor)
    const next = this.script.shift()
    if (next === undefined) throw new Error('ScriptedClient: script exhausted')
    if (next instanceof PlaidApiError) throw next
    return next
  }
}

function makeScriptedEngine(script: Array<PlaidSyncResponse | PlaidApiError>) {
  const client = new ScriptedClient(script)
  const repo = new FakePlaidRepo()
  const cursors = new MemoryCursorStore()
  const sleeps: number[] = []
  const engine = new PlaidSyncEngine({
    client,
    repo,
    reconcile: emptyReconcile,
    cursors,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  return { engine, client, cursors, sleeps }
}

describe('PlaidSyncEngine — empty next_cursor (initial sync not ready)', () => {
  it('retries the same request and proceeds once the cursor turns real', async () => {
    const ready = mkPage({ next_cursor: 'cursor-ready', has_more: false })
    const { engine, client, cursors, sleeps } = makeScriptedEngine([
      notReadyPage(),
      notReadyPage(),
      ready,
    ])
    const result = await engine.syncItem(INPUT)
    expect(sleeps).toEqual([2000, 2000])
    // the retry must NOT advance the cursor between attempts
    expect(client.seenCursors).toEqual([undefined, undefined, undefined])
    expect(cursors.get('item-1')).toBe('cursor-ready')
    expect(result.accounts[0]?.warning).toBeNull()
  })

  it('gives up after the retry budget: not-ready warning, cursor never persisted', async () => {
    const { engine, cursors, sleeps } = makeScriptedEngine(
      Array.from({ length: 6 }, () => notReadyPage()),
    )
    const result = await engine.syncItem(INPUT)
    expect(sleeps).toHaveLength(5)
    expect(cursors.get('item-1')).toBeNull()
    expect(result.error).toBeNull()
    expect(result.accounts[0]?.warning).toContain('still preparing')
  })
})

describe('PlaidSyncEngine — TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', () => {
  const mutation = () =>
    new PlaidApiError(400, 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 'mutation mid-pagination')

  it('restarts the whole batch from the last persisted cursor', async () => {
    const { engine, client, cursors } = makeScriptedEngine([
      mkPage({ next_cursor: 'page-a', has_more: true }),
      mutation(),
      mkPage({ next_cursor: 'final', has_more: false }),
    ])
    cursors.set('item-1', 'persisted-0')
    const result = await engine.syncItem(INPUT)
    // 1st call from persisted, 2nd advanced, 3rd RESTARTED from persisted
    expect(client.seenCursors).toEqual(['persisted-0', 'page-a', 'persisted-0'])
    expect(cursors.get('item-1')).toBe('final')
    expect(result.error).toBeNull()
  })

  it('rethrows once the restart budget is exhausted — cursor untouched', async () => {
    const { engine, cursors } = makeScriptedEngine(
      Array.from({ length: 8 }, () => mutation()),
    )
    cursors.set('item-1', 'persisted-0')
    await expect(engine.syncItem(INPUT)).rejects.toThrow('mutation mid-pagination')
    expect(cursors.get('item-1')).toBe('persisted-0')
  })
})

describe('PlaidFetchTransport — pinned API version', () => {
  it('sends Plaid-Version 2020-09-14 on every request', async () => {
    let captured: Record<string, string> | null = null
    const fakeFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured = (init?.headers ?? {}) as Record<string, string>
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const transport = new PlaidFetchTransport({ fetchImpl: fakeFetch })
    await transport.post('https://sandbox.plaid.com/accounts/get', {})
    expect(captured).not.toBeNull()
    expect(captured!['plaid-version']).toBe('2020-09-14')
  })
})
