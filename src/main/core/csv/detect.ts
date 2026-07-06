/**
 * CSV format detection — header-driven, never filename-driven (plan §5b).
 * Formats are matched on EXACT known headers; anything else returns null and
 * the caller must fail loudly (bank export formats are undocumented and have
 * changed before — guessing silently corrupts data).
 */

export type CsvFormat = 'chase_checking' | 'chase_credit' | 'amex_extended' | 'amex_basic'

const KNOWN_HEADERS: ReadonlyArray<{ format: CsvFormat; columns: readonly string[] }> = [
  {
    format: 'chase_checking',
    columns: ['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance', 'Check or Slip #'],
  },
  {
    format: 'chase_credit',
    columns: ['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount', 'Memo'],
  },
  {
    format: 'amex_extended',
    columns: [
      'Date',
      'Description',
      'Amount',
      'Extended Details',
      'Appears On Your Statement As',
      'Address',
      'City/State',
      'Zip Code',
      'Country',
      'Reference',
      'Category',
    ],
  },
  {
    format: 'amex_basic',
    columns: ['Date', 'Description', 'Amount'],
  },
]

/**
 * Match a parsed header row against the known formats.
 * Tolerates: a UTF-8 BOM on the first cell, surrounding whitespace per cell,
 * and trailing empty cells (a trailing comma on the header line).
 * Unknown header → null; the caller must throw, never guess.
 */
export function detectFormat(headerRow: string[]): CsvFormat | null {
  const cells = normalizeHeader(headerRow)
  for (const { format, columns } of KNOWN_HEADERS) {
    if (cells.length === columns.length && columns.every((col, i) => cells[i] === col)) {
      return format
    }
  }
  return null
}

function normalizeHeader(headerRow: string[]): string[] {
  const trimmed = headerRow.map((cell, i) =>
    (i === 0 ? cell.replace(/^﻿/, '') : cell).trim(),
  )
  let end = trimmed.length
  while (end > 0 && trimmed[end - 1] === '') end -= 1
  return trimmed.slice(0, end)
}
