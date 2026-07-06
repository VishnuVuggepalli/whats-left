/**
 * Amex credit-card exports (plan §5b). Two shapes:
 *   extended: Date,Description,Amount,Extended Details,Appears On Your
 *             Statement As,Address,City/State,Zip Code,Country,Reference,Category
 *   basic:    Date,Description,Amount
 *
 * - Charges arrive POSITIVE → sign is INVERTED to canonical (negative = out),
 *   so a -45.00 Membership Rewards credit becomes +4500 cents.
 * - City/State is a quoted multiline field ("SEATTLE\nWA") — papaparse keeps
 *   the row intact.
 * - Reference may carry Excel-guard apostrophes ('320261…') → stripped; used
 *   as externalId only if non-empty afterwards, else null. The importHash is
 *   ALWAYS computed regardless (idempotent re-import never depends on ids).
 * - Amex exports posted transactions only → status 'posted', postDate null.
 *   The transaction date is the stable date component of the hash (the plan's
 *   post_date slot) since no post date exists in the file.
 */

import type { TxnDraft } from '../../../shared/types'
import { usDateToIso } from '../dates'
import { parseAmountToCents } from '../money'
import { createOccurrenceCounter, importHash } from './importHash'
import type { OccurrenceCounter } from './importHash'
import { collapseWhitespace, fieldAt, mapRowsToDrafts } from './parse'
import type { CsvParseResult } from './parse'

/** columns consumed in extended shape: 0..2 + Reference(9) + Category(10) */
const EXTENDED_MIN_FIELDS = 10
const BASIC_MIN_FIELDS = 3

export function parseAmexExtended(content: string, accountId: string): CsvParseResult {
  const occurrences = createOccurrenceCounter()
  return mapRowsToDrafts({
    content,
    accountId,
    format: 'amex_extended',
    label: 'Amex extended CSV',
    minFields: EXTENDED_MIN_FIELDS,
    mapRow: (row): TxnDraft => {
      const base = mapCommonFields(row, accountId, occurrences)
      const category = fieldAt(row, 10).trim()
      return {
        ...base,
        externalId: stripReference(fieldAt(row, 9)),
        sourceCategory: category === '' ? null : category,
      }
    },
  })
}

export function parseAmexBasic(content: string, accountId: string): CsvParseResult {
  const occurrences = createOccurrenceCounter()
  return mapRowsToDrafts({
    content,
    accountId,
    format: 'amex_basic',
    label: 'Amex basic CSV',
    minFields: BASIC_MIN_FIELDS,
    mapRow: (row): TxnDraft => mapCommonFields(row, accountId, occurrences),
  })
}

/** Date/Description/Amount are columns 0/1/2 in both Amex shapes. */
function mapCommonFields(
  row: string[],
  accountId: string,
  occurrences: OccurrenceCounter,
): TxnDraft {
  const txnDate = usDateToIso(fieldAt(row, 0))
  const rawDescription = fieldAt(row, 1)
  if (rawDescription.trim() === '') {
    throw new Error('empty Description')
  }
  const amountCents = invertToCanonical(parseAmountToCents(fieldAt(row, 2)))
  const occurrenceIndex = occurrences.next(txnDate, amountCents, rawDescription)
  return {
    source: 'amex_csv',
    externalId: null,
    importHash: importHash(accountId, txnDate, amountCents, rawDescription, occurrenceIndex),
    txnDate,
    postDate: null,
    amountCents,
    status: 'posted',
    rawDescription,
    importedPayee: collapseWhitespace(rawDescription),
    sourceCategory: null,
    counterparty: null,
    typeCode: null,
  }
}

/** Amex signs are inverted vs canonical; keep 0 as 0, never -0. */
function invertToCanonical(cents: number): number {
  return cents === 0 ? 0 : -cents
}

/** strip Excel-guard apostrophes; empty after strip → null (hash-only row) */
function stripReference(cell: string): string | null {
  const stripped = cell.trim().replace(/^'+/, '').replace(/'+$/, '').trim()
  return stripped === '' ? null : stripped
}
