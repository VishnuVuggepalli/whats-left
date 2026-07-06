import { describe, expect, it } from 'vitest'
import { detectFormat } from './detect'

const CHASE_CHECKING = [
  'Details',
  'Posting Date',
  'Description',
  'Amount',
  'Type',
  'Balance',
  'Check or Slip #',
]
const CHASE_CREDIT = [
  'Transaction Date',
  'Post Date',
  'Description',
  'Category',
  'Type',
  'Amount',
  'Memo',
]
const AMEX_EXTENDED = [
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
]
const AMEX_BASIC = ['Date', 'Description', 'Amount']

describe('detectFormat', () => {
  it('detects chase_checking', () => {
    expect(detectFormat(CHASE_CHECKING)).toBe('chase_checking')
  })

  it('detects chase_credit', () => {
    expect(detectFormat(CHASE_CREDIT)).toBe('chase_credit')
  })

  it('detects amex_extended', () => {
    expect(detectFormat(AMEX_EXTENDED)).toBe('amex_extended')
  })

  it('detects amex_basic', () => {
    expect(detectFormat(AMEX_BASIC)).toBe('amex_basic')
  })

  it('returns null for unknown headers', () => {
    expect(detectFormat(['Datum', 'Beschreibung', 'Betrag'])).toBeNull()
    expect(detectFormat(['Description', 'Date', 'Amount'])).toBeNull() // wrong order
    expect(detectFormat([])).toBeNull()
  })

  it('is case-sensitive (formats are exact contracts)', () => {
    expect(detectFormat(['date', 'description', 'amount'])).toBeNull()
  })

  it('returns null when a real extra column is present', () => {
    expect(detectFormat([...AMEX_BASIC, 'Extra'])).toBeNull()
  })

  it('tolerates trailing empty cells (trailing comma in header row)', () => {
    expect(detectFormat([...CHASE_CHECKING, ''])).toBe('chase_checking')
    expect(detectFormat([...AMEX_BASIC, '', ''])).toBe('amex_basic')
  })

  it('tolerates surrounding whitespace in header cells', () => {
    expect(detectFormat([' Date', 'Description ', ' Amount '])).toBe('amex_basic')
  })

  it('tolerates a UTF-8 BOM on the first cell', () => {
    expect(detectFormat(['﻿Date', 'Description', 'Amount'])).toBe('amex_basic')
  })

  it('does not treat an interior empty cell as removable', () => {
    expect(detectFormat(['Date', '', 'Description', 'Amount'])).toBeNull()
  })
})
