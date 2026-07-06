import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseCsv } from './index'

const load = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../fixtures/csv/${name}`, import.meta.url)), 'utf8')

describe('parseCsv (detect + dispatch)', () => {
  it('detects and parses the chase_checking fixture', () => {
    const result = parseCsv(load('chase_checking.csv'), 'acct-1')
    expect(result.format).toBe('chase_checking')
    expect(result.drafts).toHaveLength(7)
    expect(result.warnings).toEqual([])
    expect(result.drafts.every((d) => d.source === 'chase_csv')).toBe(true)
  })

  it('detects and parses the chase_credit fixture', () => {
    const result = parseCsv(load('chase_credit.csv'), 'acct-1')
    expect(result.format).toBe('chase_credit')
    expect(result.drafts).toHaveLength(9)
  })

  it('detects and parses the amex_extended fixture', () => {
    const result = parseCsv(load('amex_extended.csv'), 'acct-1')
    expect(result.format).toBe('amex_extended')
    expect(result.drafts).toHaveLength(7)
    expect(result.drafts.every((d) => d.source === 'amex_csv')).toBe(true)
  })

  it('detects and parses the amex_basic fixture', () => {
    const result = parseCsv(load('amex_basic.csv'), 'acct-1')
    expect(result.format).toBe('amex_basic')
    expect(result.drafts).toHaveLength(3)
  })

  it('inverts the Amex MEMBERSHIP REWARDS -45.00 row to +4500 cents', () => {
    const { drafts } = parseCsv(load('amex_extended.csv'), 'acct-1')
    const mr = drafts.find((d) => d.rawDescription.includes('MEMBERSHIP REWARDS'))
    expect(mr?.amountCents).toBe(4500)
  })

  it('gives the duplicate same-day coffee rows distinct hashes end-to-end', () => {
    const { drafts } = parseCsv(load('chase_credit.csv'), 'acct-1')
    const coffees = drafts.filter((d) => d.rawDescription.includes('COFFEE HOUSE'))
    expect(coffees).toHaveLength(2)
    expect(coffees[0]?.importHash).not.toBe(coffees[1]?.importHash)
  })

  it('throws on unknown_format.csv with the offending header in the message', () => {
    expect(() => parseCsv(load('unknown_format.csv'), 'acct-1')).toThrow(
      /Datum,Beschreibung,Betrag/,
    )
  })

  it('throws on empty content', () => {
    expect(() => parseCsv('', 'acct-1')).toThrow(/empty/i)
  })

  it('throws on whitespace-only content', () => {
    expect(() => parseCsv('\n\n', 'acct-1')).toThrow(/empty/i)
  })

  it('never trusts filenames: dispatch is purely header-driven', () => {
    // amex_basic-shaped content parses as amex_basic no matter what the caller believes
    const content = 'Date,Description,Amount\n06/26/2026,SHOP,1.00\n'
    expect(parseCsv(content, 'acct-1').format).toBe('amex_basic')
  })
})
