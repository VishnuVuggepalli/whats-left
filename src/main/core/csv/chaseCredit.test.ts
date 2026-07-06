import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseChaseCredit } from './chaseCredit'

const fixture = readFileSync(
  fileURLToPath(new URL('../../../../fixtures/csv/chase_credit.csv', import.meta.url)),
  'utf8',
)

const HEADER = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo'

describe('parseChaseCredit', () => {
  it('parses the golden fixture: 9 drafts, no warnings', () => {
    const { drafts, warnings } = parseChaseCredit(fixture, 'acct-cc')
    expect(warnings).toEqual([])
    expect(drafts).toHaveLength(9)
  })

  it('maps the first coffee row field-by-field', () => {
    const { drafts } = parseChaseCredit(fixture, 'acct-cc')
    expect(drafts[0]).toMatchObject({
      source: 'chase_csv',
      externalId: null,
      txnDate: '2026-06-25',
      postDate: '2026-06-27',
      amountCents: -675,
      status: 'posted',
      rawDescription: 'TST* COFFEE HOUSE 0042 SEATTLE WA',
      importedPayee: 'TST* COFFEE HOUSE 0042 SEATTLE WA',
      sourceCategory: 'Food & Drink',
      counterparty: null,
      typeCode: 'Sale',
    })
  })

  it('gives the two identical same-day coffee rows different importHashes (occurrenceIndex)', () => {
    const { drafts } = parseChaseCredit(fixture, 'acct-cc')
    const coffees = drafts.filter((d) => d.rawDescription === 'TST* COFFEE HOUSE 0042 SEATTLE WA')
    expect(coffees).toHaveLength(2)
    expect(coffees[0]?.importHash).not.toBe(coffees[1]?.importHash)
    // and everything else about them is identical
    expect(coffees[0]?.amountCents).toBe(coffees[1]?.amountCents)
    expect(coffees[0]?.postDate).toBe(coffees[1]?.postDate)
  })

  it('produces unique hashes across the whole file', () => {
    const hashes = parseChaseCredit(fixture, 'acct-cc').drafts.map((d) => d.importHash)
    expect(new Set(hashes).size).toBe(hashes.length)
  })

  it('keeps purchases negative and returns positive as-is', () => {
    const { drafts } = parseChaseCredit(fixture, 'acct-cc')
    const ret = drafts.find((d) => d.typeCode === 'Return')
    expect(ret?.amountCents).toBe(6499)
    const united = drafts.find((d) => d.rawDescription.startsWith('UNITED'))
    expect(united?.amountCents).toBe(-41260)
  })

  it('maps the Payment row: positive amount, empty Category becomes null', () => {
    const { drafts } = parseChaseCredit(fixture, 'acct-cc')
    const payment = drafts.find((d) => d.typeCode === 'Payment')
    expect(payment).toMatchObject({
      amountCents: 84355,
      sourceCategory: null,
      txnDate: '2026-06-30',
      postDate: '2026-06-30',
      rawDescription: 'Payment Thank You-Mobile',
    })
  })

  it('sets externalId null on every row (Chase CSVs carry no bank id)', () => {
    const { drafts } = parseChaseCredit(fixture, 'acct-cc')
    expect(drafts.every((d) => d.externalId === null)).toBe(true)
  })

  it('is deterministic across re-parses of the same file', () => {
    const a = parseChaseCredit(fixture, 'acct-cc').drafts.map((d) => d.importHash)
    const b = parseChaseCredit(fixture, 'acct-cc').drafts.map((d) => d.importHash)
    expect(a).toEqual(b)
  })

  it('skips malformed rows with a warning and keeps good ones', () => {
    const content = `${HEADER}\n06/25/2026,06/27/2026,GOOD,Food & Drink,Sale,-6.75,\nbad-date,06/27/2026,BAD,Food & Drink,Sale,-6.75,\n06/25/2026,06/27/2026,BADAMT,Food & Drink,Sale,six,\n`
    const { drafts, warnings } = parseChaseCredit(content, 'acct-cc')
    expect(drafts).toHaveLength(1)
    expect(warnings).toHaveLength(2)
  })

  it('throws on header-only content', () => {
    expect(() => parseChaseCredit(`${HEADER}\n`, 'acct-cc')).toThrow()
  })

  it('throws on a wrong header (checking header into credit parser)', () => {
    const checking = 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n'
    expect(() => parseChaseCredit(checking, 'acct-cc')).toThrow(/Posting Date/)
  })
})
