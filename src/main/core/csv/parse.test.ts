import { describe, expect, it } from 'vitest'
import { collapseWhitespace, fieldAt, parseCsvRows } from './parse'

describe('parseCsvRows', () => {
  it('parses simple LF content into string rows', () => {
    const { rows, errors } = parseCsvRows('a,b,c\n1,2,3\n')
    expect(errors).toEqual([])
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('parses CRLF content identically', () => {
    const { rows } = parseCsvRows('a,b,c\r\n1,2,3\r\n')
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('keeps trailing-comma rows intact as an extra empty field', () => {
    const { rows } = parseCsvRows('a,b\n1,2,\n')
    expect(rows[1]).toEqual(['1', '2', ''])
  })

  it('handles quoted multiline fields (Amex City/State style)', () => {
    const { rows, errors } = parseCsvRows('h1,h2,h3\nx,"SEATTLE\nWA",y\n')
    expect(errors).toEqual([])
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual(['x', 'SEATTLE\nWA', 'y'])
  })

  it('handles quoted fields with embedded commas and escaped quotes', () => {
    const { rows } = parseCsvRows('h1,h2\n"one, two","say ""hi"""\n')
    expect(rows[1]).toEqual(['one, two', 'say "hi"'])
  })

  it('skips blank lines', () => {
    const { rows } = parseCsvRows('a,b\n\n1,2\n\n')
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('returns zero rows for empty content', () => {
    expect(parseCsvRows('').rows).toEqual([])
    expect(parseCsvRows('\n\n').rows).toEqual([])
  })

  it('surfaces papaparse errors as strings instead of swallowing them', () => {
    // Unclosed quote at end of input produces a papaparse error entry.
    const { errors } = parseCsvRows('a,b\n"unclosed,2\n3,4')
    expect(errors.length).toBeGreaterThan(0)
    expect(typeof errors[0]).toBe('string')
  })
})

describe('collapseWhitespace', () => {
  it('trims and collapses internal runs of whitespace to single spaces', () => {
    expect(collapseWhitespace('  ORIG CO NAME:ACME    CORP   ')).toBe('ORIG CO NAME:ACME CORP')
  })

  it('collapses newlines and tabs too', () => {
    expect(collapseWhitespace('SEATTLE\nWA\tUS')).toBe('SEATTLE WA US')
  })

  it('returns empty string for whitespace-only input', () => {
    expect(collapseWhitespace('   \n ')).toBe('')
  })
})

describe('fieldAt', () => {
  it('returns the cell when present and empty string when out of range', () => {
    expect(fieldAt(['a', 'b'], 1)).toBe('b')
    expect(fieldAt(['a', 'b'], 5)).toBe('')
  })
})
