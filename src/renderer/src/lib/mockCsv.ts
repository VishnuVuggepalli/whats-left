/**
 * CSV parsing for the MockApi import flow (browser dev mode only — the real
 * importer lives in the main process, plan §5b). Header-detected, never
 * trusts filenames; unknown headers fail loudly.
 *
 * `parseAmountToCents` / `usDateToIso` deliberately duplicate the tiny
 * helpers in src/main/core: the renderer must not import main-process code
 * across the IPC boundary (plan §3 invariant 2).
 */
import Papa from 'papaparse'
import type { CategorySource } from '../../../shared/types'

export type MockCsvFormat = 'chase_checking' | 'chase_credit' | 'amex_extended' | 'amex_basic'

export interface MockCsvRow {
  txnDate: string
  postDate: string | null
  /** canonical sign: negative = money out (Amex charges are inverted) */
  amountCents: number
  description: string
  payee: string
  sourceCategory: string | null
  typeCode: string | null
}

export interface MockCsvParse {
  format: MockCsvFormat
  rows: MockCsvRow[]
}

const HEADERS: Record<MockCsvFormat, string> = {
  chase_checking: 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #',
  chase_credit: 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo',
  amex_extended:
    'Date,Description,Amount,Extended Details,Appears On Your Statement As,Address,City/State,Zip Code,Country,Reference,Category',
  amex_basic: 'Date,Description,Amount',
}

export function parseAmountToCents(raw: string): number {
  const s = raw.trim().replace(/,/g, '')
  if (!/^-?\$?\d+(\.\d{1,2})?$/.test(s)) {
    throw new Error(`Unparseable amount: ${JSON.stringify(raw)}`)
  }
  const neg = s.startsWith('-')
  const unsigned = s.replace(/^-?\$?/, '')
  const dotIdx = unsigned.indexOf('.')
  const whole = dotIdx === -1 ? unsigned : unsigned.slice(0, dotIdx)
  const frac = ((dotIdx === -1 ? '' : unsigned.slice(dotIdx + 1)) + '00').slice(0, 2)
  const cents = Number(whole) * 100 + Number(frac)
  return neg ? -cents : cents
}

/** 'MM/DD/YYYY' → 'YYYY-MM-DD'; pure string rearrangement, no Date. */
export function usDateToIso(s: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim())
  if (!m) throw new Error(`Unparseable US date: ${JSON.stringify(s)}`)
  const [, mm, dd, yyyy] = m
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) {
    throw new Error(`Out-of-range US date: ${JSON.stringify(s)}`)
  }
  return `${yyyy}-${mm}-${dd}`
}

/** Demo-grade payee cleanup mirroring the plan §6 regex-table approach. */
export function normalizePayee(description: string): string {
  const trimmed = description.trim()
  if (trimmed === '') throw new Error('Cannot normalize an empty description')
  const ach = /ORIG CO NAME:(.+?)(?:\s{2,}|ORIG ID)/.exec(trimmed)
  let s = ach?.[1] ?? trimmed
  if (/^AMZN MKTP/i.test(s)) return 'Amazon'
  s = s.replace(/^(TST\*\s*|SQ \*\s*|DD \*|PAYPAL \*)/i, '')
  s = s.replace(/\b\d{10}\b|\b\d{3}-\d{3}-\d{4}\b/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  return s
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

function requireField(record: Record<string, string | undefined>, field: string): string {
  const v = record[field]
  if (v === undefined) throw new Error(`CSV row missing field ${JSON.stringify(field)}`)
  return v
}

export function parseMockCsv(content: string): MockCsvParse {
  if (content.trim() === '') throw new Error('CSV file is empty')
  const result = Papa.parse<Record<string, string>>(content.trim(), { header: true, skipEmptyLines: true })
  const fields = (result.meta.fields ?? []).join(',')
  const format = (Object.keys(HEADERS) as MockCsvFormat[]).find((f) => HEADERS[f] === fields)
  if (!format) {
    throw new Error(`Unrecognized CSV header — refusing to guess a format: ${JSON.stringify(fields)}`)
  }
  // Chase checking rows carry a trailing comma (8th field) — tolerated by
  // design (plan §5b); any other parse error is fatal.
  const fatal = result.errors.filter((e) => !(format === 'chase_checking' && e.code === 'TooManyFields'))
  if (fatal.length > 0) {
    throw new Error(`CSV parse failed: ${fatal[0]!.message} (row ${fatal[0]!.row ?? '?'})`)
  }
  return { format, rows: result.data.map((record) => toRow(format, record)) }
}

function toRow(format: MockCsvFormat, record: Record<string, string>): MockCsvRow {
  switch (format) {
    case 'chase_checking': {
      const postDate = usDateToIso(requireField(record, 'Posting Date'))
      const description = requireField(record, 'Description')
      return {
        txnDate: postDate, // posting-only source: fills both (plan §5b)
        postDate,
        amountCents: parseAmountToCents(requireField(record, 'Amount')),
        description,
        payee: normalizePayee(description),
        sourceCategory: null,
        typeCode: record['Type'] ?? null,
      }
    }
    case 'chase_credit': {
      const description = requireField(record, 'Description')
      return {
        txnDate: usDateToIso(requireField(record, 'Transaction Date')),
        postDate: usDateToIso(requireField(record, 'Post Date')),
        amountCents: parseAmountToCents(requireField(record, 'Amount')),
        description,
        payee: normalizePayee(description),
        sourceCategory: record['Category'] || null,
        typeCode: record['Type'] ?? null,
      }
    }
    case 'amex_extended':
    case 'amex_basic': {
      const description = requireField(record, 'Description')
      return {
        txnDate: usDateToIso(requireField(record, 'Date')),
        postDate: null,
        // Amex charges are positive in the export → invert to canonical sign.
        amountCents: -parseAmountToCents(requireField(record, 'Amount')),
        description,
        payee: normalizePayee(description),
        sourceCategory: record['Category'] || null,
        typeCode: null,
      }
    }
  }
}

/** Bank label → taxonomy id (subset — demo mirror of the §6 tier-3 maps). */
const SOURCE_LABEL_MAP: Record<string, string> = {
  'Food & Drink': 'food_and_drink',
  Groceries: 'groceries',
  Gas: 'transportation',
  Shopping: 'general_merchandise',
  'Bills & Utilities': 'rent_and_utilities',
  Travel: 'travel',
  'Merchandise & Supplies-Groceries': 'groceries',
  'Merchandise & Supplies-Wholesale Stores': 'general_merchandise',
  'Restaurant-Restaurant': 'food_and_drink',
  'Fees & Adjustments-Fees': 'bank_fees',
}

/**
 * Shipped-default-rule mirror (§5d) + source-label mapping (§6 tier 3).
 * Rules run first so checking-side card payments NEVER count as spend.
 * Returns null when nothing matches — row stays uncategorized, no guessing.
 */
export function categorizeMockRow(
  format: MockCsvFormat,
  row: MockCsvRow,
): { categoryId: string; categorySource: CategorySource } | null {
  const desc = row.description.toUpperCase()
  if (format === 'chase_checking') {
    if (/CHASE CREDIT CRD (AUTOPAY|EPAY)|AMEX EPAYMENT|AMERICAN EXPRESS ACH PMT/.test(desc)) {
      return { categoryId: 'loan_payments', categorySource: 'rule' }
    }
    if (/ZELLE|QUICKPAY/.test(desc) || row.typeCode === 'ACCT_XFER') {
      return { categoryId: 'transfer_out', categorySource: 'rule' }
    }
    if (row.typeCode === 'ACH_CREDIT' && /PAYROLL/.test(desc)) {
      return { categoryId: 'income', categorySource: 'rule' }
    }
  }
  if (format === 'chase_credit' && row.typeCode === 'Payment') {
    return { categoryId: 'loan_payments', categorySource: 'rule' }
  }
  if ((format === 'amex_extended' || format === 'amex_basic') && /AUTOPAY PAYMENT|ONLINE PAYMENT/.test(desc)) {
    return { categoryId: 'loan_payments', categorySource: 'rule' }
  }
  const mapped = row.sourceCategory === null ? undefined : SOURCE_LABEL_MAP[row.sourceCategory]
  return mapped === undefined ? null : { categoryId: mapped, categorySource: 'source' }
}
