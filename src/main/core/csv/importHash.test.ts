import { describe, expect, it } from 'vitest'
import { createOccurrenceCounter, importHash } from './importHash'

describe('importHash', () => {
  it('returns 64-char lowercase hex', () => {
    const h = importHash('acct-1', '2026-06-28', -5423, 'COFFEE SHOP', 0)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('matches known sha256 vector for account|date|cents|description|occurrence', () => {
    expect(importHash('acct-1', '2026-06-28', -5423, 'COFFEE SHOP', 0)).toBe(
      '78c3de614283e50e6c4c72d52875dcfe87c1f8a53149585d993debff20bd080d',
    )
  })

  it('encodes null postDate as empty date component (known vector)', () => {
    expect(importHash('acct-1', null, -5423, 'COFFEE SHOP', 0)).toBe(
      '612c23e5217da996aeb7ca52b7014c001ca2a830481bd38cb894d20712388364',
    )
  })

  it('is deterministic', () => {
    const a = importHash('acct-1', '2026-06-28', -5423, 'COFFEE SHOP', 1)
    const b = importHash('acct-1', '2026-06-28', -5423, 'COFFEE SHOP', 1)
    expect(a).toBe(b)
  })

  it('changes when any component changes', () => {
    const base = importHash('acct-1', '2026-06-28', -5423, 'COFFEE SHOP', 0)
    expect(importHash('acct-2', '2026-06-28', -5423, 'COFFEE SHOP', 0)).not.toBe(base)
    expect(importHash('acct-1', '2026-06-29', -5423, 'COFFEE SHOP', 0)).not.toBe(base)
    expect(importHash('acct-1', '2026-06-28', -5424, 'COFFEE SHOP', 0)).not.toBe(base)
    expect(importHash('acct-1', '2026-06-28', -5423, 'COFFEE SHOP X', 0)).not.toBe(base)
    expect(importHash('acct-1', '2026-06-28', -5423, 'COFFEE SHOP', 1)).not.toBe(base)
  })

  it('throws on empty accountId', () => {
    expect(() => importHash('', '2026-06-28', -5423, 'X', 0)).toThrow(/accountId/)
  })

  it('throws on non-integer amountCents', () => {
    expect(() => importHash('acct-1', '2026-06-28', -54.23, 'X', 0)).toThrow(/amountCents/)
  })

  it('throws on negative or non-integer occurrenceIndex', () => {
    expect(() => importHash('acct-1', '2026-06-28', -5423, 'X', -1)).toThrow(/occurrenceIndex/)
    expect(() => importHash('acct-1', '2026-06-28', -5423, 'X', 0.5)).toThrow(/occurrenceIndex/)
  })
})

describe('createOccurrenceCounter', () => {
  it('numbers identical tuples 0,1,2 in encounter order', () => {
    const counter = createOccurrenceCounter()
    expect(counter.next('2026-06-27', -675, 'COFFEE')).toBe(0)
    expect(counter.next('2026-06-27', -675, 'COFFEE')).toBe(1)
    expect(counter.next('2026-06-27', -675, 'COFFEE')).toBe(2)
  })

  it('counts distinct tuples independently', () => {
    const counter = createOccurrenceCounter()
    expect(counter.next('2026-06-27', -675, 'COFFEE')).toBe(0)
    expect(counter.next('2026-06-27', -676, 'COFFEE')).toBe(0)
    expect(counter.next('2026-06-28', -675, 'COFFEE')).toBe(0)
    expect(counter.next('2026-06-27', -675, 'TEA')).toBe(0)
    expect(counter.next(null, -675, 'COFFEE')).toBe(0)
    expect(counter.next('2026-06-27', -675, 'COFFEE')).toBe(1)
  })
})
