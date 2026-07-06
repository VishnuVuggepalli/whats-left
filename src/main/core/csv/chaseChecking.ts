/**
 * Chase checking export (plan §5b):
 *   Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
 * - Amounts arrive ALREADY signed (debits negative) → taken as-is.
 * - Only a posting date exists → it fills BOTH postDate and txnDate.
 * - Data rows carry a trailing comma (8th empty field) — tolerated.
 */

import type { TxnDraft } from '../../../shared/types'
import { usDateToIso } from '../dates'
import { parseAmountToCents } from '../money'
import { createOccurrenceCounter, importHash } from './importHash'
import { canonicalCents, collapseWhitespace, fieldAt, mapRowsToDrafts } from './parse'
import type { CsvParseResult } from './parse'

const LABEL = 'Chase checking CSV'
/** columns consumed: 0..4 (Balance and Check/Slip # are not imported) */
const MIN_FIELDS = 5

export function parseChaseChecking(content: string, accountId: string): CsvParseResult {
  const occurrences = createOccurrenceCounter()
  return mapRowsToDrafts({
    content,
    accountId,
    format: 'chase_checking',
    label: LABEL,
    minFields: MIN_FIELDS,
    mapRow: (row): TxnDraft => {
      const postingDate = usDateToIso(fieldAt(row, 1))
      const rawDescription = fieldAt(row, 2)
      if (rawDescription.trim() === '') {
        throw new Error('empty Description')
      }
      const amountCents = canonicalCents(parseAmountToCents(fieldAt(row, 3)))
      const typeCode = fieldAt(row, 4).trim()
      const occurrenceIndex = occurrences.next(postingDate, amountCents, rawDescription)
      return {
        source: 'chase_csv',
        externalId: null,
        importHash: importHash(accountId, postingDate, amountCents, rawDescription, occurrenceIndex),
        txnDate: postingDate,
        postDate: postingDate,
        amountCents,
        status: 'posted',
        rawDescription,
        importedPayee: collapseWhitespace(rawDescription),
        sourceCategory: null,
        counterparty: null,
        typeCode: typeCode === '' ? null : typeCode,
      }
    },
  })
}
