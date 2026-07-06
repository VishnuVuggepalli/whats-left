/**
 * Chase credit-card export (plan §5b):
 *   Transaction Date,Post Date,Description,Category,Type,Amount,Memo
 * - Purchases arrive negative → taken as-is.
 * - Chase's 16-category label is kept verbatim as sourceCategory ('' → null).
 * - typeCode: Sale | Payment | Return | Adjustment | Fee.
 */

import type { TxnDraft } from '../../../shared/types'
import { usDateToIso } from '../dates'
import { parseAmountToCents } from '../money'
import { createOccurrenceCounter, importHash } from './importHash'
import { canonicalCents, collapseWhitespace, fieldAt, mapRowsToDrafts } from './parse'
import type { CsvParseResult } from './parse'

const LABEL = 'Chase credit CSV'
/** columns consumed: 0..5 (Memo is not imported; rows may omit it) */
const MIN_FIELDS = 6

export function parseChaseCredit(content: string, accountId: string): CsvParseResult {
  const occurrences = createOccurrenceCounter()
  return mapRowsToDrafts({
    content,
    accountId,
    format: 'chase_credit',
    label: LABEL,
    minFields: MIN_FIELDS,
    mapRow: (row): TxnDraft => {
      const txnDate = usDateToIso(fieldAt(row, 0))
      const postDate = usDateToIso(fieldAt(row, 1))
      const rawDescription = fieldAt(row, 2)
      if (rawDescription.trim() === '') {
        throw new Error('empty Description')
      }
      const category = fieldAt(row, 3).trim()
      const typeCode = fieldAt(row, 4).trim()
      const amountCents = canonicalCents(parseAmountToCents(fieldAt(row, 5)))
      const occurrenceIndex = occurrences.next(postDate, amountCents, rawDescription)
      return {
        source: 'chase_csv',
        externalId: null,
        importHash: importHash(accountId, postDate, amountCents, rawDescription, occurrenceIndex),
        txnDate,
        postDate,
        amountCents,
        status: 'posted',
        rawDescription,
        importedPayee: collapseWhitespace(rawDescription),
        sourceCategory: category === '' ? null : category,
        counterparty: null,
        typeCode: typeCode === '' ? null : typeCode,
      }
    },
  })
}
