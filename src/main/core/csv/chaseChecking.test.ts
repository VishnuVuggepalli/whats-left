import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseChaseChecking } from './chaseChecking'

const fixture = readFileSync(
  fileURLToPath(new URL('../../../../fixtures/csv/chase_checking.csv', import.meta.url)),
  'utf8',
)

const HEADER = 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #'

describe('parseChaseChecking', () => {
  it('parses the golden fixture: 7 drafts, no warnings', () => {
    const { drafts, warnings } = parseChaseChecking(fixture, 'acct-chk')
    expect(warnings).toEqual([])
    expect(drafts).toHaveLength(7)
  })

  it('maps the first row field-by-field', () => {
    const { drafts } = parseChaseChecking(fixture, 'acct-chk')
    const first = drafts[0]
    expect(first).toMatchObject({
      source: 'chase_csv',
      externalId: null,
      txnDate: '2026-06-28',
      postDate: '2026-06-28',
      amountCents: -5423,
      status: 'posted',
      rawDescription: "POS DEBIT CARD 1234 TRADER JOE'S #552 SEATTLE WA",
      importedPayee: "POS DEBIT CARD 1234 TRADER JOE'S #552 SEATTLE WA",
      sourceCategory: null,
      counterparty: null,
      typeCode: 'DEBIT_CARD',
    })
    expect(first?.importHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('sets txnDate = postDate = posting date on every row (posting date only format)', () => {
    const { drafts } = parseChaseChecking(fixture, 'acct-chk')
    for (const d of drafts) {
      expect(d.postDate).toBe(d.txnDate)
      expect(d.txnDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('keeps already-signed amounts as-is (payroll credit stays positive)', () => {
    const { drafts } = parseChaseChecking(fixture, 'acct-chk')
    const payroll = drafts[1]
    expect(payroll?.amountCents).toBe(250000)
    expect(payroll?.typeCode).toBe('ACH_CREDIT')
  })

  it('collapses whitespace in importedPayee but keeps rawDescription verbatim', () => {
    const { drafts } = parseChaseChecking(fixture, 'acct-chk')
    const payroll = drafts[1]
    expect(payroll?.rawDescription).toContain('   ') // fixture has space runs
    expect(payroll?.importedPayee).not.toMatch(/\s{2}/)
    expect(payroll?.importedPayee.startsWith('ORIG CO NAME:ACME CORP ')).toBe(true)
  })

  it('maps typeCode from the Type column for all rows', () => {
    const { drafts } = parseChaseChecking(fixture, 'acct-chk')
    expect(drafts.map((d) => d.typeCode)).toEqual([
      'DEBIT_CARD',
      'ACH_CREDIT',
      'ACH_DEBIT',
      'ACH_DEBIT',
      'QUICKPAY_DEBIT',
      'ATM',
      'CHECK_PAID',
    ])
  })

  it('tolerates the trailing comma (8th empty field) and the check-number column', () => {
    const { drafts, warnings } = parseChaseChecking(fixture, 'acct-chk')
    expect(warnings).toEqual([])
    const check = drafts[6]
    expect(check?.amountCents).toBe(-25000)
    expect(check?.rawDescription).toBe('CHECK # 1204')
  })

  it('is deterministic: re-parsing yields identical importHashes', () => {
    const a = parseChaseChecking(fixture, 'acct-chk').drafts.map((d) => d.importHash)
    const b = parseChaseChecking(fixture, 'acct-chk').drafts.map((d) => d.importHash)
    expect(a).toEqual(b)
    expect(new Set(a).size).toBe(a.length)
  })

  it('hashes depend on accountId', () => {
    const a = parseChaseChecking(fixture, 'acct-chk').drafts[0]?.importHash
    const b = parseChaseChecking(fixture, 'other-acct').drafts[0]?.importHash
    expect(a).not.toBe(b)
  })

  it('parses CRLF content identically', () => {
    const crlf = fixture.replace(/\n/g, '\r\n')
    const { drafts, warnings } = parseChaseChecking(crlf, 'acct-chk')
    expect(warnings).toEqual([])
    expect(drafts.map((d) => d.amountCents)).toEqual(
      parseChaseChecking(fixture, 'acct-chk').drafts.map((d) => d.amountCents),
    )
  })

  it('skips a malformed-amount row with a warning, keeps good rows', () => {
    const content = `${HEADER}\nDEBIT,06/28/2026,"OK ROW",-1.00,DEBIT_CARD,10.00,,\nDEBIT,06/28/2026,"BAD ROW",abc,DEBIT_CARD,9.00,,\n`
    const { drafts, warnings } = parseChaseChecking(content, 'acct-chk')
    expect(drafts).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/row 3/i)
    expect(warnings[0]).toMatch(/abc/)
  })

  it('skips a malformed-date row with a warning', () => {
    const content = `${HEADER}\nDEBIT,2026-06-28,"BAD DATE",-1.00,DEBIT_CARD,10.00,,\nDEBIT,06/28/2026,"OK",-2.00,DEBIT_CARD,8.00,,\n`
    const { drafts, warnings } = parseChaseChecking(content, 'acct-chk')
    expect(drafts).toHaveLength(1)
    expect(warnings).toHaveLength(1)
  })

  it('skips rows with too few fields with a warning', () => {
    const content = `${HEADER}\nDEBIT,06/28/2026,"SHORT"\nDEBIT,06/28/2026,"OK",-2.00,DEBIT_CARD,8.00,,\n`
    const { drafts, warnings } = parseChaseChecking(content, 'acct-chk')
    expect(drafts).toHaveLength(1)
    expect(warnings).toHaveLength(1)
  })

  it('skips rows with empty description with a warning', () => {
    const content = `${HEADER}\nDEBIT,06/28/2026,,-1.00,DEBIT_CARD,10.00,,\nDEBIT,06/28/2026,"OK",-2.00,DEBIT_CARD,8.00,,\n`
    const { drafts, warnings } = parseChaseChecking(content, 'acct-chk')
    expect(drafts).toHaveLength(1)
    expect(warnings).toHaveLength(1)
  })

  it('throws on header-only content (zero parsed rows)', () => {
    expect(() => parseChaseChecking(`${HEADER}\n`, 'acct-chk')).toThrow(/0 rows|no data/i)
  })

  it('throws when every row is malformed, surfacing the warnings', () => {
    const content = `${HEADER}\nDEBIT,notadate,"X",-1.00,DEBIT_CARD,10.00,,\n`
    expect(() => parseChaseChecking(content, 'acct-chk')).toThrow(/notadate/)
  })

  it('throws on a wrong header', () => {
    expect(() => parseChaseChecking('Datum,Beschreibung,Betrag\nx,y,z\n', 'acct-chk')).toThrow(
      /Datum/,
    )
  })

  it('throws on empty content', () => {
    expect(() => parseChaseChecking('', 'acct-chk')).toThrow()
  })

  it('throws on empty accountId', () => {
    expect(() => parseChaseChecking(fixture, '')).toThrow(/accountId/)
  })
})
