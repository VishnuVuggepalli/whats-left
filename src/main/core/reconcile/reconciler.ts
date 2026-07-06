/**
 * Cross-source reconciler (plan §5c) — adapted from Actual Budget's matcher.
 *
 * Pass 0  idempotency: exact (source, importHash) or external-id hit (keyed by
 *         id VALUE — an adopted id on a cross-source row still counts) →
 *         match when the draft carries a state delta (pending→posted upgrade,
 *         postDate fill, earlier txnDate), skip_duplicate when it does not.
 *         Either way the row is consumed.
 * Pass 1  fuzzy candidates: same account (asserted uniform), EXACT amountCents,
 *         post-or-txn date within ±7 days, sorted by date distance ascending.
 * Pass 2  prefer the candidate whose normalized payee equals the draft's.
 * Pass 3  else first remaining candidate.
 *
 * Review-critical semantics (v2):
 * - strictIdChecking is NAMESPACE-SCOPED, and the namespace is derived from
 *   the ID ITSELF (idNamespace: 'txn_…' = teller, digits = amex), not from
 *   row.source — a csv row that adopted a teller id keeps teller semantics.
 *   A fuzzy merge is blocked when both sides carry ids of the same known
 *   namespace and the ids differ (unrecognized id shapes fall back to the
 *   old same-source rule). Synthesized importHashes are never ids;
 *   cross-namespace pairs (csv ↔ teller) are always fuzzy-eligible.
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
  // A dup that carries a state delta (pending→posted, postDate fill, earlier
  // txnDate, id adoption) is a MATCH so the delta is persisted — the common
  // case where the bank keeps the same id across pending→posted must not be
  // dropped as a no-op skip (plan §5a).
  incoming.forEach((draft, i) => {
    const dup =
      byHash.get(nsKey(draft.source, draft.importHash)) ??
      (draft.externalId !== null ? byExternalId.get(draft.externalId) : undefined)
    if (dup !== undefined) {
      consumedIds.add(dup.id)
      const updates = buildUpdates(dup, draft)
      decisions[i] = hasStateDelta(updates)
        ? { kind: 'match', existingId: dup.id, draft, updates }
        : { kind: 'skip_duplicate', draft, existingId: dup.id }
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

/**
 * byHash stays source-namespaced (hashes are synthesized per source), but
 * byExternalId is keyed by the id VALUE alone: bank-issued ids are globally
 * namespace-unique (ux_txn_external), and a csv row that adopted a teller id
 * via an earlier fuzzy merge must still register as that teller transaction.
 */
function indexExisting(existing: ExistingTxn[]): {
  byHash: Map<string, ExistingTxn>
  byExternalId: Map<string, ExistingTxn>
} {
  const byHash = new Map<string, ExistingTxn>()
  const byExternalId = new Map<string, ExistingTxn>()
  for (const row of existing) {
    const hashKey = nsKey(row.source, row.importHash)
    if (!byHash.has(hashKey)) byHash.set(hashKey, row)
    if (row.externalId !== null && !byExternalId.has(row.externalId)) {
      byExternalId.set(row.externalId, row)
    }
  }
  return { byHash, byExternalId }
}

/** anything beyond the always-present linkedSourceId means the draft carries news */
function hasStateDelta(updates: MatchUpdates): boolean {
  return (
    updates.txnDate !== undefined ||
    updates.postDate !== undefined ||
    updates.status !== undefined ||
    updates.externalId !== undefined
  )
}

/** posting-or-transaction date: the best-known "when it hit the account" */
function anchorDate(row: { postDate: IsoDate | null; txnDate: IsoDate }): IsoDate {
  return row.postDate ?? row.txnDate
}

/** issuing namespace of a bank id, derived from the id itself (not row.source) */
export function idNamespace(externalId: string): 'teller' | 'amex' | 'unknown' {
  if (/^txn_/.test(externalId)) return 'teller'
  if (/^\d+$/.test(externalId)) return 'amex'
  return 'unknown'
}

/**
 * Namespace-scoped strictIdChecking: two DIFFERENT ids from the same known
 * issuing namespace are two different bank transactions, no matter which
 * source's row carries them (a csv row may have adopted a teller id).
 * Ids of unrecognized shape fall back to the same-source rule.
 */
function isStrictIdBlocked(draft: TxnDraft, row: ExistingTxn): boolean {
  if (draft.externalId === null || row.externalId === null) return false
  if (draft.externalId === row.externalId) return false
  const draftNs = idNamespace(draft.externalId)
  const rowNs = idNamespace(row.externalId)
  if (draftNs !== 'unknown' && draftNs === rowNs) return true
  if ((draftNs === 'unknown' || rowNs === 'unknown') && draft.source === row.source) return true
  return false
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
