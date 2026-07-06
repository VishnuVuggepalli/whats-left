/**
 * Tolerant CSV parsing shared by all format parsers (plan §5b).
 *
 * papaparse handles the real-world mess: CRLF line endings, quoted multiline
 * fields (Amex "SEATTLE\nWA" City/State), embedded commas/quotes, and
 * trailing-comma rows (which simply yield an extra empty field).
 */

import Papa from 'papaparse'
const papaParse = Papa.parse
import type { TxnDraft } from '../../../shared/types'
import { detectFormat, type CsvFormat } from './detect'

export interface CsvParseResult {
  drafts: TxnDraft[]
  warnings: string[]
}

export interface RawCsv {
  rows: string[][]
  /** papaparse structural errors, formatted — surfaced, never swallowed */
  errors: string[]
}

export function parseCsvRows(content: string): RawCsv {
  const result = papaParse<string[]>(content, {
    delimiter: ',',
    header: false,
    skipEmptyLines: 'greedy',
  })
  const errors = result.errors.map((e) =>
    e.row === undefined
      ? `CSV parse error: ${e.message}`
      : `CSV parse error (record ${e.row + 1}): ${e.message}`,
  )
  return { rows: result.data, errors }
}

/** trim + collapse whitespace runs — the raw description stays verbatim */
export function collapseWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

/** safe indexed access under noUncheckedIndexedAccess; missing cell → '' */
export function fieldAt(row: readonly string[], index: number): string {
  return row[index] ?? ''
}

/** normalize -0 to 0 so hashes and stored values are canonical */
export function canonicalCents(cents: number): number {
  return cents === 0 ? 0 : cents
}

/**
 * Shared row loop for all format parsers:
 * - verifies the header is EXACTLY the expected format (else throws)
 * - malformed rows are collected as warnings and skipped — never silently
 * - zero importable rows → throw (surfacing collected warnings)
 */
export function mapRowsToDrafts(args: {
  content: string
  accountId: string
  format: CsvFormat
  label: string
  /** minimum field count a row must have to be mappable */
  minFields: number
  mapRow: (row: string[]) => TxnDraft
}): CsvParseResult {
  const { content, accountId, format, label, minFields, mapRow } = args
  if (accountId.trim() === '') {
    throw new Error(`${label}: accountId is required for import attribution`)
  }
  const { rows, errors } = parseCsvRows(content)
  const header = rows[0]
  if (!header) {
    throw new Error(`${label}: file is empty`)
  }
  const detected = detectFormat(header)
  if (detected !== format) {
    throw new Error(
      `${label}: unexpected header (detected: ${detected ?? 'unknown'}): ${header.join(',')}`,
    )
  }

  const warnings: string[] = [...errors]
  const drafts: TxnDraft[] = []
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]
    if (row === undefined) continue
    const recordNumber = i + 1 // 1-based, header = row 1
    if (row.length < minFields) {
      warnings.push(
        `${label}: row ${recordNumber} skipped: expected at least ${minFields} fields, got ${row.length}`,
      )
      continue
    }
    try {
      drafts.push(mapRow(row))
    } catch (err) {
      warnings.push(`${label}: row ${recordNumber} skipped: ${errorMessage(err)}`)
    }
  }

  if (drafts.length === 0) {
    const detail =
      warnings.length > 0 ? ` (${warnings.length} warning(s): ${warnings.join('; ')})` : ''
    throw new Error(`${label}: 0 rows imported — no importable data rows${detail}`)
  }
  return { drafts, warnings }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
