/**
 * Deterministic import identity for CSV rows (plan §5b):
 *   import_hash = sha256(account_id|post_date|amount_cents|raw_description|occurrence_index)
 *
 * occurrence_index disambiguates identical same-day rows WITHIN one parsed
 * file (0,1,2… per identical tuple), so two real same-day coffees survive
 * dedup while a re-import of the same file is a no-op via
 * UNIQUE(account_id, source, import_hash).
 */

import { createHash } from 'node:crypto'

export function importHash(
  accountId: string,
  postDate: string | null,
  amountCents: number,
  rawDescription: string,
  occurrenceIndex: number,
): string {
  if (accountId.trim() === '') {
    throw new Error('importHash: accountId must be non-empty')
  }
  if (!Number.isInteger(amountCents)) {
    throw new Error(`importHash: amountCents must be integer cents, got ${amountCents}`)
  }
  if (!Number.isInteger(occurrenceIndex) || occurrenceIndex < 0) {
    throw new Error(`importHash: occurrenceIndex must be a non-negative integer, got ${occurrenceIndex}`)
  }
  const material = [
    accountId,
    postDate ?? '',
    String(amountCents),
    rawDescription,
    String(occurrenceIndex),
  ].join('|')
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

export interface OccurrenceCounter {
  /** 0 on first sight of a (date, amount, description) tuple, then 1, 2, … */
  next(postDate: string | null, amountCents: number, rawDescription: string): number
}

/** One counter per parsed file — occurrence numbering never leaks across files. */
export function createOccurrenceCounter(): OccurrenceCounter {
  const counts = new Map<string, number>()
  return {
    next(postDate, amountCents, rawDescription) {
      const key = `${postDate ?? ''}|${amountCents}|${rawDescription}`
      const index = counts.get(key) ?? 0
      counts.set(key, index + 1)
      return index
    },
  }
}
