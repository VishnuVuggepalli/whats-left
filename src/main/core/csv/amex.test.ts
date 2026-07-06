import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseAmexBasic, parseAmexExtended } from './amex'

const load = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../fixtures/csv/${name}`, import.meta.url)), 'utf8')

const extended = load('amex_extended.csv')
const basic = load('amex_basic.csv')

const EXT_HEADER =
  'Date,Description,Amount,Extended Details,Appears On Your Statement As,Address,City/State,Zip Code,Country,Reference,Category'

describe('parseAmexExtended', () => {
  it('parses the golden fixture: 7 drafts, no warnings (multiline City/State fields intact)', () => {
    const { drafts, warnings } = parseAmexExtended(extended, 'acct-amex')
    expect(warnings).toEqual([])
    expect(drafts).toHaveLength(7)
  })

  it('maps the Whole Foods row field-by-field, inverting the charge sign', () => {
    const { drafts } = parseAmexExtended(extended, 'acct-amex')
    expect(drafts[0]).toMatchObject({
      source: 'amex_csv',
      externalId: '320261770123456789', // leading apostrophe stripped
      txnDate: '2026-06-26',
      postDate: null,
      amountCents: -8710, // 87.10 charge → negative
      status: 'posted',
      rawDescription: 'WHOLE FOODS MARKET SEATTLE WA',
      importedPayee: 'WHOLE FOODS MARKET SEATTLE WA',
      sourceCategory: 'Merchandise & Supplies-Groceries',
      counterparty: null,
      typeCode: null,
    })
  })

  it('inverts every amount: charges negative, credits positive', () => {
    const { drafts } = parseAmexExtended(extended, 'acct-amex')
    expect(drafts.map((d) => d.amountCents)).toEqual([
      -8710, -3462, -2845, -742, 4500, -21487, 41209,
    ])
  })

  it('turns the MEMBERSHIP REWARDS -45.00 credit into +4500 cents with null sourceCategory', () => {
    const { drafts } = parseAmexExtended(extended, 'acct-amex')
    const mr = drafts.find((d) => d.rawDescription === 'MEMBERSHIP REWARDS REDEMPTION')
    expect(mr?.amountCents).toBe(4500)
    expect(mr?.sourceCategory).toBeNull()
  })

  it('strips apostrophes from Reference and uses it as externalId on all fixture rows', () => {
    const { drafts } = parseAmexExtended(extended, 'acct-amex')
    for (const d of drafts) {
      expect(d.externalId).toMatch(/^\d+$/)
    }
    expect(drafts.map((d) => d.externalId)).toContain('320261680999888777')
  })

  it('sets externalId null when Reference is empty after stripping', () => {
    const content = `${EXT_HEADER}\n06/26/2026,SOME SHOP,10.00,x,x,,,,US,'',Misc\n06/27/2026,OTHER SHOP,11.00,x,x,,,,US,,Misc\n`
    const { drafts } = parseAmexExtended(content, 'acct-amex')
    expect(drafts.map((d) => d.externalId)).toEqual([null, null])
  })

  it('still computes an importHash even when externalId is set, unique per row', () => {
    const { drafts } = parseAmexExtended(extended, 'acct-amex')
    for (const d of drafts) expect(d.importHash).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(drafts.map((d) => d.importHash)).size).toBe(drafts.length)
  })

  it('is deterministic across re-parses', () => {
    const a = parseAmexExtended(extended, 'acct-amex').drafts.map((d) => d.importHash)
    const b = parseAmexExtended(extended, 'acct-amex').drafts.map((d) => d.importHash)
    expect(a).toEqual(b)
  })

  it('marks all rows posted with null postDate (Amex exports posted only)', () => {
    const { drafts } = parseAmexExtended(extended, 'acct-amex')
    for (const d of drafts) {
      expect(d.status).toBe('posted')
      expect(d.postDate).toBeNull()
    }
  })

  it('normalizes a 0.00 amount to 0 (never -0)', () => {
    const content = `${EXT_HEADER}\n06/26/2026,ZERO SHOP,0.00,x,x,,,,US,'1',Misc\n`
    const { drafts } = parseAmexExtended(content, 'acct-amex')
    expect(Object.is(drafts[0]?.amountCents, 0)).toBe(true)
  })

  it('skips malformed rows with warnings, keeps good rows', () => {
    const content = `${EXT_HEADER}\n06/26/2026,GOOD,10.00,x,x,,,,US,'1',Misc\nnot-a-date,BAD,10.00,x,x,,,,US,'2',Misc\n06/26/2026,BADAMT,ten,x,x,,,,US,'3',Misc\n`
    const { drafts, warnings } = parseAmexExtended(content, 'acct-amex')
    expect(drafts).toHaveLength(1)
    expect(warnings).toHaveLength(2)
  })

  it('throws on header-only content and on a wrong header', () => {
    expect(() => parseAmexExtended(`${EXT_HEADER}\n`, 'acct-amex')).toThrow()
    expect(() => parseAmexExtended('Date,Description,Amount\n06/26/2026,X,1.00\n', 'acct-amex')).toThrow()
  })
})

describe('parseAmexBasic', () => {
  it('parses the golden fixture: 3 drafts, inverted amounts', () => {
    const { drafts, warnings } = parseAmexBasic(basic, 'acct-amex')
    expect(warnings).toEqual([])
    expect(drafts.map((d) => d.amountCents)).toEqual([-8710, -3462, -2845])
  })

  it('maps fields: no externalId, no sourceCategory, null postDate', () => {
    const { drafts } = parseAmexBasic(basic, 'acct-amex')
    expect(drafts[0]).toMatchObject({
      source: 'amex_csv',
      externalId: null,
      txnDate: '2026-06-26',
      postDate: null,
      status: 'posted',
      rawDescription: 'WHOLE FOODS MARKET SEATTLE WA',
      sourceCategory: null,
      counterparty: null,
      typeCode: null,
    })
  })

  it('gives identical same-day duplicate rows distinct hashes via occurrenceIndex', () => {
    const content = 'Date,Description,Amount\n06/26/2026,COFFEE,4.50\n06/26/2026,COFFEE,4.50\n'
    const { drafts } = parseAmexBasic(content, 'acct-amex')
    expect(drafts).toHaveLength(2)
    expect(drafts[0]?.importHash).not.toBe(drafts[1]?.importHash)
  })

  it('skips malformed rows with a warning', () => {
    const content = 'Date,Description,Amount\n06/26/2026,GOOD,4.50\n06/26/2026,BAD,\n'
    const { drafts, warnings } = parseAmexBasic(content, 'acct-amex')
    expect(drafts).toHaveLength(1)
    expect(warnings).toHaveLength(1)
  })

  it('throws when handed the extended header', () => {
    expect(() => parseAmexBasic(extended, 'acct-amex')).toThrow()
  })

  it('throws on header-only content', () => {
    expect(() => parseAmexBasic('Date,Description,Amount\n', 'acct-amex')).toThrow()
  })
})
