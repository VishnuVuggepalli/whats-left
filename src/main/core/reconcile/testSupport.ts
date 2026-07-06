/**
 * Builders for reconciler tests. Not a test file — imported by the colocated
 * *.test.ts files. Each call mints unique ids/hashes unless overridden.
 */
import type { TxnDraft } from '../../../shared/types'
import type { ExistingTxn, ReconcileDecision, ReconcileOutcome } from '../ports'

let seq = 0

function nextSeq(): number {
  seq += 1
  return seq
}

export function makeDraft(overrides: Partial<TxnDraft> = {}): TxnDraft {
  const n = nextSeq()
  return {
    source: 'teller',
    externalId: null,
    importHash: `hash_draft_${n}`,
    txnDate: '2026-02-02',
    postDate: null,
    amountCents: -450,
    status: 'posted',
    rawDescription: 'RAW DESCRIPTION',
    importedPayee: 'Blue Bottle',
    sourceCategory: null,
    counterparty: null,
    typeCode: null,
    ...overrides,
  }
}

export function makeExisting(overrides: Partial<ExistingTxn> = {}): ExistingTxn {
  const n = nextSeq()
  return {
    id: `txn_${n}`,
    accountId: 'acct_1',
    source: 'chase_csv',
    externalId: null,
    importHash: `hash_existing_${n}`,
    txnDate: '2026-02-02',
    postDate: null,
    amountCents: -450,
    status: 'posted',
    normalizedPayee: 'blue bottle',
    categorySource: null,
    ...overrides,
  }
}

/** index-safe decision accessor (noUncheckedIndexedAccess) */
export function decisionAt(outcome: ReconcileOutcome, index: number): ReconcileDecision {
  const d = outcome.decisions[index]
  if (d === undefined) throw new Error(`no decision at index ${index}`)
  return d
}

export function expectMatch(
  d: ReconcileDecision | undefined,
): Extract<ReconcileDecision, { kind: 'match' }> {
  if (d === undefined || d.kind !== 'match') {
    throw new Error(`expected a match decision, got ${d === undefined ? 'undefined' : d.kind}`)
  }
  return d
}

/** deep-freeze inputs so any in-place mutation inside reconcile() throws */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}
