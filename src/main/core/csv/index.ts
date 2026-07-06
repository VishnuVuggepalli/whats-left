/**
 * CSV import entry point (plan §5b): detect the format from the header row —
 * never the filename — and dispatch to the matching parser. Unknown headers
 * throw loudly with the offending header in the message.
 */

import type { TxnDraft } from '../../../shared/types'
import { detectFormat } from './detect'
import type { CsvFormat } from './detect'
import { parseCsvRows } from './parse'
import type { CsvParseResult } from './parse'
import { parseAmexBasic, parseAmexExtended } from './amex'
import { parseChaseChecking } from './chaseChecking'
import { parseChaseCredit } from './chaseCredit'

export interface ParsedCsvFile {
  format: CsvFormat
  drafts: TxnDraft[]
  warnings: string[]
}

const PARSERS: Record<CsvFormat, (content: string, accountId: string) => CsvParseResult> = {
  chase_checking: parseChaseChecking,
  chase_credit: parseChaseCredit,
  amex_extended: parseAmexExtended,
  amex_basic: parseAmexBasic,
}

export function parseCsv(content: string, accountId: string): ParsedCsvFile {
  const { rows } = parseCsvRows(content)
  const header = rows[0]
  if (!header) {
    throw new Error('CSV import: file is empty')
  }
  const format = detectFormat(header)
  if (format === null) {
    throw new Error(`CSV import: unknown header format — refusing to guess: ${header.join(',')}`)
  }
  const { drafts, warnings } = PARSERS[format](content, accountId)
  return { format, drafts, warnings }
}

export { detectFormat } from './detect'
export type { CsvFormat } from './detect'
export { createOccurrenceCounter, importHash } from './importHash'
export type { OccurrenceCounter } from './importHash'
export { collapseWhitespace, parseCsvRows } from './parse'
export type { CsvParseResult, RawCsv } from './parse'
export { parseChaseChecking } from './chaseChecking'
export { parseChaseCredit } from './chaseCredit'
export { parseAmexBasic, parseAmexExtended } from './amex'
