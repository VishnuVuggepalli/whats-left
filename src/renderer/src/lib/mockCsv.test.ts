import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { categorizeMockRow, normalizePayee, parseAmountToCents, parseMockCsv, usDateToIso } from './mockCsv'

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../fixtures/csv/${name}`, import.meta.url)), 'utf8')
}

describe('parseAmountToCents', () => {
  it('parses plain and negative decimals', () => {
    expect(parseAmountToCents('-54.23')).toBe(-5423)
    expect(parseAmountToCents('87.10')).toBe(8710)
  })

  it('parses thousands separators and whole numbers', () => {
    expect(parseAmountToCents('2,500.00')).toBe(250000)
    expect(parseAmountToCents('120')).toBe(12000)
  })

  it('pads single-digit fractions', () => {
    expect(parseAmountToCents('4.5')).toBe(450)
  })

  it('throws on malformed input', () => {
    expect(() => parseAmountToCents('')).toThrow()
    expect(() => parseAmountToCents('12.345')).toThrow()
    expect(() => parseAmountToCents('abc')).toThrow()
  })
})

describe('usDateToIso', () => {
  it('converts MM/DD/YYYY', () => {
    expect(usDateToIso('06/26/2026')).toBe('2026-06-26')
  })

  it('throws on malformed or out-of-range dates', () => {
    expect(() => usDateToIso('2026-06-26')).toThrow()
    expect(() => usDateToIso('13/01/2026')).toThrow()
    expect(() => usDateToIso('06/32/2026')).toThrow()
  })
})

describe('normalizePayee', () => {
  it('strips processor prefixes', () => {
    expect(normalizePayee('TST* COFFEE HOUSE 0042 SEATTLE WA')).toBe('Coffee House 0042 Seattle Wa')
    expect(normalizePayee('DD *DOORDASH BURGERPL 6505553801 CA')).toBe('Doordash Burgerpl Ca')
  })

  it('collapses Amazon marketplace noise', () => {
    expect(normalizePayee('AMZN Mktp US*RT4Y66TR3 Amzn.com/bill WA')).toBe('Amazon')
  })

  it('extracts ACH originator names', () => {
    expect(
      normalizePayee('ORIG CO NAME:ACME CORP           ORIG ID:1234567890 DESC DATE:260627'),
    ).toBe('Acme Corp')
  })

  it('title-cases and collapses whitespace', () => {
    expect(normalizePayee('  WHOLE   FOODS MARKET  ')).toBe('Whole Foods Market')
  })

  it('throws on empty description', () => {
    expect(() => normalizePayee('   ')).toThrow()
  })
})

describe('parseMockCsv — format detection', () => {
  it('detects all four known formats by header', () => {
    expect(parseMockCsv(fixture('chase_checking.csv')).format).toBe('chase_checking')
    expect(parseMockCsv(fixture('chase_credit.csv')).format).toBe('chase_credit')
    expect(parseMockCsv(fixture('amex_extended.csv')).format).toBe('amex_extended')
    expect(parseMockCsv(fixture('amex_basic.csv')).format).toBe('amex_basic')
  })

  it('fails loudly on unknown headers', () => {
    expect(() => parseMockCsv(fixture('unknown_format.csv'))).toThrow(/header/i)
  })

  it('fails loudly on empty content', () => {
    expect(() => parseMockCsv('')).toThrow()
  })
})

describe('parseMockCsv — chase_credit', () => {
  const parsed = parseMockCsv(fixture('chase_credit.csv'))

  it('parses all rows with signs as-is', () => {
    expect(parsed.rows).toHaveLength(9)
    const coffee = parsed.rows.filter((r) => r.description.includes('COFFEE HOUSE'))
    expect(coffee).toHaveLength(2)
    expect(coffee[0]!.amountCents).toBe(-675)
  })

  it('keeps both transaction and post dates', () => {
    const grocery = parsed.rows.find((r) => r.description.startsWith('WHOLEFDS'))!
    expect(grocery.txnDate).toBe('2026-06-24')
    expect(grocery.postDate).toBe('2026-06-25')
  })

  it('keeps the bank category label verbatim', () => {
    const grocery = parsed.rows.find((r) => r.description.startsWith('WHOLEFDS'))!
    expect(grocery.sourceCategory).toBe('Groceries')
  })

  it('keeps payments positive with their type code', () => {
    const payment = parsed.rows.find((r) => r.typeCode === 'Payment')!
    expect(payment.amountCents).toBe(84355)
  })
})

describe('parseMockCsv — chase_checking', () => {
  const parsed = parseMockCsv(fixture('chase_checking.csv'))

  it('tolerates the trailing-comma 8th field', () => {
    expect(parsed.rows).toHaveLength(7)
  })

  it('uses posting date for both dates (posting-only source)', () => {
    const tj = parsed.rows.find((r) => r.description.includes("TRADER JOE'S"))!
    expect(tj.txnDate).toBe('2026-06-28')
    expect(tj.postDate).toBe('2026-06-28')
    expect(tj.amountCents).toBe(-5423)
  })

  it('keeps credits positive', () => {
    const payroll = parsed.rows.find((r) => r.typeCode === 'ACH_CREDIT')!
    expect(payroll.amountCents).toBe(250000)
  })
})

describe('parseMockCsv — amex_extended', () => {
  const parsed = parseMockCsv(fixture('amex_extended.csv'))

  it('parses rows with embedded quoted newlines', () => {
    expect(parsed.rows).toHaveLength(7)
  })

  it('inverts signs: charges become negative', () => {
    const wf = parsed.rows.find((r) => r.description.startsWith('WHOLE FOODS'))!
    expect(wf.amountCents).toBe(-8710)
  })

  it('inverts signs: credits become positive', () => {
    const mr = parsed.rows.find((r) => r.description.startsWith('MEMBERSHIP REWARDS'))!
    expect(mr.amountCents).toBe(4500)
    const autopay = parsed.rows.find((r) => r.description.startsWith('AUTOPAY'))!
    expect(autopay.amountCents).toBe(41209)
  })

  it('has no post date (transaction date only)', () => {
    expect(parsed.rows[0]!.postDate).toBeNull()
    expect(parsed.rows[0]!.txnDate).toBe('2026-06-26')
  })
})

describe('categorizeMockRow — shipped default rules mirror (§5d)', () => {
  const checking = parseMockCsv(fixture('chase_checking.csv'))
  const credit = parseMockCsv(fixture('chase_credit.csv'))
  const amex = parseMockCsv(fixture('amex_extended.csv'))

  it('routes checking-side card payments to loan_payments, never spend', () => {
    const autopay = checking.rows.find((r) => r.description.includes('CHASE CREDIT CRD AUTOPAY'))!
    expect(categorizeMockRow('chase_checking', autopay)?.categoryId).toBe('loan_payments')
    const amexPmt = checking.rows.find((r) => r.description.includes('AMEX EPAYMENT'))!
    expect(categorizeMockRow('chase_checking', amexPmt)?.categoryId).toBe('loan_payments')
  })

  it('routes Zelle to transfer_out', () => {
    const zelle = checking.rows.find((r) => r.description.includes('ZELLE'))!
    expect(categorizeMockRow('chase_checking', zelle)?.categoryId).toBe('transfer_out')
  })

  it('routes payroll ACH credits to income', () => {
    const payroll = checking.rows.find((r) => r.typeCode === 'ACH_CREDIT')!
    expect(categorizeMockRow('chase_checking', payroll)?.categoryId).toBe('income')
  })

  it('routes card-side Payment type to loan_payments', () => {
    const pmt = credit.rows.find((r) => r.typeCode === 'Payment')!
    expect(categorizeMockRow('chase_credit', pmt)?.categoryId).toBe('loan_payments')
  })

  it('maps bank source labels to taxonomy ids', () => {
    const grocery = credit.rows.find((r) => r.sourceCategory === 'Groceries')!
    expect(categorizeMockRow('chase_credit', grocery)).toEqual({ categoryId: 'groceries', categorySource: 'source' })
    const wholesale = amex.rows.find((r) => r.sourceCategory === 'Merchandise & Supplies-Wholesale Stores')!
    expect(categorizeMockRow('amex_extended', wholesale)?.categoryId).toBe('general_merchandise')
  })

  it('returns null for unknown labels (stays uncategorized, no silent guess)', () => {
    const row = {
      txnDate: '2026-06-01',
      postDate: null,
      amountCents: -100,
      description: 'SOMETHING NEW',
      payee: 'Something New',
      sourceCategory: 'Label Nobody Mapped',
      typeCode: null,
    }
    expect(categorizeMockRow('amex_extended', row)).toBeNull()
  })
})
