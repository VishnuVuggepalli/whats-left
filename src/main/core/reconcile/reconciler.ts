/**
 * Cross-source reconciler (plan §5c) — adapted from Actual Budget's matcher.
 *
 * Pass 0  idempotency: exact (source, importHash) or same-namespace
 *         (source, externalId) hit → skip_duplicate, row consumed.
 * Pass 1  fuzzy candidates: same account (asserted uniform), EXACT amountCents,
 *         post-or-txn date within ±7 days, sorted by date distance ascending.
 * Pass 2  prefer the candidate whose normalized payee equals the draft's.
 * Pass 3  else first remaining candidate.
 *
 * Review-critical semantics (v2):
 * - strictIdChecking is NAMESPACE-SCOPED: a fuzzy merge is blocked only when
 *   draft and candidate BOTH carry bank-issued externalIds in the SAME source
 *   namespace and the ids differ. Synthesized importHashes are never ids;
 *   cross-source pairs (csv ↔ teller) are always fuzzy-eligible.
 * - Candidate consumption: each existing row is claimed by at most one
 *   incoming draft per reconcile() call. Pass 0 runs for the whole batch
 *   before any fuzzy matching so an exact duplicate always claims its row
 *   ahead of a near-miss in the same batch.
 * - Date precedence: resulting txnDate = earliest of the two (minIso); a
 *   posting-only source never overwrites a populated txnDate with a later
 *   date. postDate only fills a gap. pending→posted upgrades, never the
 *   reverse. The reconciler NEVER touches categorization (invariant 5) —
 *   the updates type structurally has no category/payee fields.
 */
import { daysBetween, isIsoDate, minIso } from '../dates'
import type { IsoDate, Source, TxnDraft } from '../../../shared/types'
import type { ExistingTxn, ReconcileDecision, ReconcileOutcome } from '../ports'

export interface ReconcileOpts {
  /** payee normalizer for pass 2; defaults to trim + lowercase + collapse whitespace */
  normalize?: (payee: string) => string
}

type MatchUpdates = Extract<ReconcileDecision, { kind: 'match' }>['updates']

const FUZZY_WINDOW_DAYS = 7

export function reconcile(
  incoming: TxnDraft[],
  existing: ExistingTxn[],
  opts: ReconcileOpts = {},
): ReconcileOutcome {
  assertSingleAccount(existing)
  incoming.forEach(assertValidDraft)
  const normalize = opts.normalize ?? defaultNormalize

  const { byHash, byExternalId } = indexExisting(existing)
  const consumedIds = new Set<string>()
  const decisions: Array<ReconcileDecision | null> = incoming.map(() => null)

  // Pass 0 — idempotency for the whole batch before any fuzzy matching.
  incoming.forEach((draft, i) => {
    const dup =
      byHash.get(nsKey(draft.source, draft.importHash)) ??
      (draft.externalId !== null ? byExternalId.get(nsKey(draft.source, draft.externalId)) : undefined)
    if (dup !== undefined) {
      consumedIds.add(dup.id)
      decisions[i] = { kind: 'skip_duplicate', draft, existingId: dup.id }
    }
  })

  // Passes 1–3 — fuzzy match remaining drafts in input order.
  incoming.forEach((draft, i) => {
    if (decisions[i] !== null) return
    const candidates = fuzzyCandidates(draft, existing, consumedIds)
    const target = pickCandidate(candidates, draft, normalize)
    if (target === null) {
      decisions[i] = { kind: 'insert', draft }
      return
    }
    consumedIds.add(target.id)
    decisions[i] = { kind: 'match', existingId: target.id, draft, updates: buildUpdates(target, draft) }
  })

  const finalDecisions = decisions.map((d, i) => {
    if (d === null) throw new Error(`reconcile: draft at index ${i} left undecided (internal bug)`)
    return d
  })
  return {
    decisions: finalDecisions,
    inserted: finalDecisions.filter((d) => d.kind === 'insert').length,
    matched: finalDecisions.filter((d) => d.kind === 'match').length,
    skipped: finalDecisions.filter((d) => d.kind === 'skip_duplicate').length,
  }
}

/** (source, value) namespace key — NUL separator cannot appear in either part */
function nsKey(source: Source, value: string): string {
  return `${source}\u0000${value}`
}

function indexExisting(existing: ExistingTxn[]): {
  byHash: Map<string, ExistingTxn>
  byExternalId: Map<string, ExistingTxn>
} {
  const byHash = new Map<string, ExistingTxn>()
  const byExternalId = new Map<string, ExistingTxn>()
  for (const row of existing) {
    const hashKey = nsKey(row.source, row.importHash)
    if (!byHash.has(hashKey)) byHash.set(hashKey, row)
    if (row.externalId !== null) {
      const idKey = nsKey(row.source, row.externalId)
      if (!byExternalId.has(idKey)) byExternalId.set(idKey, row)
    }
  }
  return { byHash, byExternalId }
}

/** posting-or-transaction date: the best-known "when it hit the account" */
function anchorDate(row: { postDate: IsoDate | null; txnDate: IsoDate }): IsoDate {
  return row.postDate ?? row.txnDate
}

/**
 * Namespace-scoped strictIdChecking: block only when both sides carry
 * bank-issued ids from the SAME source namespace and the ids differ.
 */
function isStrictIdBlocked(draft: TxnDraft, row: ExistingTxn): boolean {
  return (
    draft.externalId !== null &&
    row.externalId !== null &&
    draft.source === row.source &&
    draft.externalId !== row.externalId
  )
}

/** unconsumed rows with exact amount, within ±7 days, sorted by date distance */
function fuzzyCandidates(
  draft: TxnDraft,
  existing: ExistingTxn[],
  consumedIds: ReadonlySet<string>,
): ExistingTxn[] {
  const draftAnchor = anchorDate(draft)
  return existing
    .filter((row) => !consumedIds.has(row.id) && row.amountCents === draft.amountCents)
    .map((row) => ({ row, distance: Math.abs(daysBetween(draftAnchor, anchorDate(row))) }))
    .filter(({ row, distance }) => distance <= FUZZY_WINDOW_DAYS && !isStrictIdBlocked(draft, row))
    .sort((a, b) => a.distance - b.distance) // stable: ties keep input order
    .map(({ row }) => row)
}

/** pass 2: same normalized payee wins; pass 3: closest date distance */
function pickCandidate(
  candidates: ExistingTxn[],
  draft: TxnDraft,
  normalize: (payee: string) => string,
): ExistingTxn | null {
  const closest = candidates[0]
  if (closest === undefined) return null
  const wanted = normalize(draft.importedPayee)
  const samePayee = candidates.find((row) => normalize(row.normalizedPayee) === wanted)
  return samePayee ?? closest
}

function buildUpdates(row: ExistingTxn, draft: TxnDraft): MatchUpdates {
  const updates: MatchUpdates = { linkedSourceId: draft.externalId ?? draft.importHash }
  const earliest = minIso(row.txnDate, draft.txnDate)
  if (earliest !== row.txnDate) updates.txnDate = earliest
  if (row.postDate === null && draft.postDate !== null) updates.postDate = draft.postDate
  if (row.status === 'pending' && draft.status === 'posted') updates.status = 'posted'
  if (row.externalId === null && draft.externalId !== null) updates.externalId = draft.externalId
  return updates
}

/** the reconciler operates on exactly one account's rows — never match across accounts */
function assertSingleAccount(existing: ExistingTxn[]): void {
  const accountIds = new Set(existing.map((row) => row.accountId))
  if (accountIds.size > 1) {
    throw new Error(
      `reconcile: existing rows span multiple accounts: ${[...accountIds].sort().join(', ')}`,
    )
  }
}

function assertValidDraft(draft: TxnDraft, index: number): void {
  if (!isIsoDate(draft.txnDate)) {
    throw new Error(`reconcile: draft[${index}] txnDate is not YYYY-MM-DD: ${JSON.stringify(draft.txnDate)}`)
  }
  if (draft.postDate !== null && !isIsoDate(draft.postDate)) {
    throw new Error(`reconcile: draft[${index}] postDate is not YYYY-MM-DD: ${JSON.stringify(draft.postDate)}`)
  }
  if (!Number.isInteger(draft.amountCents)) {
    throw new Error(`reconcile: draft[${index}] amountCents is not an integer: ${String(draft.amountCents)}`)
  }
  if (typeof draft.importHash !== 'string' || draft.importHash.length === 0) {
    throw new Error(`reconcile: draft[${index}] importHash is empty`)
  }
}

function defaultNormalize(payee: string): string {
  return payee.trim().toLowerCase().replace(/\s+/g, ' ')
}
