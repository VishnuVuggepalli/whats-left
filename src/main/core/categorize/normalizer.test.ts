import { describe, expect, it } from 'vitest'
import { normalizePayee } from './normalizer'

/**
 * Named cases from the plan (§6) plus fixture-derived descriptors.
 * Expected values document the deterministic output of the regex pipeline —
 * best-effort cleanup, not perfect merchant resolution (plan: 'Wholefds' is
 * explicitly "acceptable").
 */
const CASES: ReadonlyArray<readonly [raw: string, expected: string]> = [
  // processor prefixes
  ['TST* COFFEE HOUSE 0042 SEATTLE WA', 'Coffee House'],
  ['SQ * BLUE BOTTLE COFFEE', 'Blue Bottle Coffee'],
  ['PAYPAL *STEAMGAMES', 'Steamgames'],
  ['PP*DIGITALOCEAN', 'Digitalocean'],
  ['CASH APP*JANE', 'Jane'],
  ['VENMO * JOHN SMITH', 'John Smith'],
  ['GOOGLE *YOUTUBE TV', 'Youtube Tv'],
  ['SP * CANDLE STUDIO', 'Candle Studio'],
  // special-cased processors
  ['AMZN Mktp US*RT4Y66TR3 Amzn.com/bill WA', 'Amazon Marketplace'],
  ['AMAZON.COM*RT123 SEATTLE WA', 'Amazon'],
  ['APPLE.COM/BILL 866-712-7753 CA', 'Apple'],
  ['UBER *EATS 8005928996 CA', 'Uber Eats'],
  ['DD *DOORDASH BURGERPL 6505553801 CA', 'Burgerpl'],
  // Chase-checking ACH boilerplate → ORIG CO NAME extraction
  [
    'ORIG CO NAME:ACME CORP           ORIG ID:1234567890 DESC DATE:260627 CO ENTRY DESCR:PAYROLL    SEC:PPD    TRACE#:021000021234567 EED:260627   IND ID:00012345            IND NAME:VISHNU VUGGEPALLI TRN: 1234567TC',
    'Acme Corp',
  ],
  // channel noise + store number + city/state tail
  ["POS DEBIT CARD 1234 TRADER JOE'S #552 SEATTLE WA", "Trader Joe's"],
  ['COSTCO WHSE #0110 SEATTLE WA', 'Costco Whse'],
  // 'SEA' is recognized as an abbreviation of the dropped city 'SEATTLE'
  ['WHOLEFDS SEA 10221 SEATTLE WA', 'Wholefds'],
  ['SHELL OIL 57444212345 BELLEVUE WA', 'Shell Oil'],
  ['WHOLE FOODS MARKET SEATTLE WA', 'Whole Foods Market'],
  // phone numbers and reference-number noise
  ['NETFLIX.COM 866-579-7172 CA', 'Netflix.com'],
  ['UNITED 0162345678901 800-864-8331 TX', 'United'],
  ['ZELLE PAYMENT TO JOHN DOE 21987654321', 'Zelle Payment To John Doe'],
  ['CHASE CREDIT CRD AUTOPAY                    PPD ID: 4760039224', 'Chase Credit Crd Autopay'],
  ['AMEX EPAYMENT    ACH PMT    M1234 WEB ID: 9493560001', 'Amex Epayment Ach Pmt M1234'],
  ['CHECK # 1204', 'Check'],
  ['ATM WITHDRAWAL 007352 07/02332 PIKE ST SEATTLE WA', 'Atm Withdrawal Pike St'],
  // plain descriptors just get Title Cased
  ['MEMBERSHIP REWARDS REDEMPTION', 'Membership Rewards Redemption'],
  ['PLAN IT MONTHLY PLAN FEE', 'Plan It Monthly Plan Fee'],
  ['TST* THAI KITCHEN SEATTLE WA', 'Thai Kitchen'],
  ['AUTOPAY PAYMENT RECEIVED - THANK YOU', 'Autopay Payment Received Thank You'],
]

describe('normalizePayee — pipeline cases', () => {
  for (const [raw, expected] of CASES) {
    it(`${JSON.stringify(raw)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizePayee(raw)).toBe(expected)
    })
  }
})

describe('normalizePayee — behavior', () => {
  it('is idempotent: normalize(normalize(x)) === normalize(x)', () => {
    for (const [raw] of CASES) {
      const once = normalizePayee(raw)
      expect(normalizePayee(once), `idempotency for ${JSON.stringify(raw)}`).toBe(once)
    }
  })

  it('is deterministic and pure (same input → same output, input untouched)', () => {
    const raw = 'TST* COFFEE HOUSE 0042 SEATTLE WA'
    expect(normalizePayee(raw)).toBe(normalizePayee(raw))
    expect(raw).toBe('TST* COFFEE HOUSE 0042 SEATTLE WA')
  })

  it('collapses whitespace and trims', () => {
    expect(normalizePayee('  FOO    BAR  ')).toBe('Foo Bar')
  })

  it('lowercase input normalizes the same as uppercase', () => {
    expect(normalizePayee('tst* coffee house 0042 seattle wa')).toBe('Coffee House')
  })

  it('returns empty string for empty/whitespace-only input', () => {
    expect(normalizePayee('')).toBe('')
    expect(normalizePayee('   ')).toBe('')
  })

  it('falls back to the title-cased raw text when stripping would leave nothing', () => {
    // everything is channel noise → keep the (title-cased) original rather than ''
    expect(normalizePayee('POS DEBIT CARD 1234')).toBe('Pos Debit Card 1234')
    // fallback is idempotent too
    expect(normalizePayee('Pos Debit Card 1234')).toBe('Pos Debit Card 1234')
  })

  it('does not drop a 2-letter tail that is not a US state code', () => {
    expect(normalizePayee('POKEMON GO')).toBe('Pokemon Go')
  })

  it('keeps the merchant when only STATE follows it (no city token eaten)', () => {
    // documented heuristic tradeoff: trailing 'CO' (Colorado) is dropped even
    // when it means "Company" — acceptable for a display-name normalizer.
    expect(normalizePayee('FANCY SOAP CO')).toBe('Fancy Soap')
    expect(normalizePayee('BURGERPL CA')).toBe('Burgerpl')
  })

  it('never returns leading/trailing whitespace', () => {
    for (const [raw] of CASES) {
      const out = normalizePayee(raw)
      expect(out).toBe(out.trim())
    }
  })

  it("title-cases apostrophes sanely (JOE'S → Joe's)", () => {
    expect(normalizePayee("TRADER JOE'S")).toBe("Trader Joe's")
  })
})
