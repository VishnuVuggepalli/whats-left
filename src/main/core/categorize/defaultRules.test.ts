import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AccountType, TxnDraft } from '../../../shared/types'
import { parseAmountToCents } from '../money'
import { CATEGORY_IDS, categoryById } from './taxonomy'
import { DEFAULT_RULES, applyDefaultRules } from './defaultRules'

const fixture = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../fixtures/${rel}`, import.meta.url)), 'utf8')

function draft(overrides: Partial<TxnDraft>): TxnDraft {
  return {
    source: 'chase_csv',
    externalId: null,
    importHash: 'hash',
    txnDate: '2026-06-30',
    postDate: '2026-06-30',
    amountCents: -1000,
    status: 'posted',
    rawDescription: 'SOME MERCHANT',
    importedPayee: 'Some Merchant',
    sourceCategory: null,
    counterparty: null,
    typeCode: null,
    ...overrides,
  }
}

function ruleCategory(d: TxnDraft, accountType: AccountType): string | null {
  return applyDefaultRules(d, accountType)?.categoryId ?? null
}

describe('rule table sanity', () => {
  it('every rule maps to a valid taxonomy id', () => {
    for (const rule of DEFAULT_RULES) {
      expect(CATEGORY_IDS, `rule ${rule.name} → ${rule.categoryId}`).toContain(rule.categoryId)
    }
  })

  it('rule names are unique', () => {
    const names = DEFAULT_RULES.map((r) => r.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('applyDefaultRules does not mutate the draft', () => {
    const d = draft({ typeCode: 'ATM' })
    const frozen = Object.freeze({ ...d })
    applyDefaultRules(frozen, 'depository')
    expect(frozen).toEqual(d)
  })
})

describe('§5d both sides: the same card payment lands loan_payments on BOTH accounts', () => {
  it('the -843.55 CHASE CREDIT CRD AUTOPAY checking row → loan_payments', () => {
    const d = draft({
      rawDescription: 'CHASE CREDIT CRD AUTOPAY                    PPD ID: 4760039224',
      amountCents: -84355,
      typeCode: 'ACH_DEBIT',
    })
    expect(ruleCategory(d, 'depository')).toBe('loan_payments')
  })

  it('the +843.55 Chase credit CSV Type=Payment card row → loan_payments', () => {
    const d = draft({
      rawDescription: 'Payment Thank You-Mobile',
      amountCents: 84355,
      typeCode: 'Payment',
    })
    expect(ruleCategory(d, 'credit')).toBe('loan_payments')
  })

  it('the +843.55 Teller type=payment card row → loan_payments', () => {
    const d = draft({
      source: 'teller',
      rawDescription: 'Payment Thank You-Mobile',
      amountCents: 84355,
      typeCode: 'payment',
    })
    expect(ruleCategory(d, 'credit')).toBe('loan_payments')
  })

  it('CHASE CREDIT CRD EPAY variant → loan_payments', () => {
    const d = draft({ rawDescription: 'CHASE CREDIT CRD EPAY 123', amountCents: -50000, typeCode: 'ACH_DEBIT' })
    expect(ruleCategory(d, 'depository')).toBe('loan_payments')
  })

  it('AMEX EPAYMENT checking row → loan_payments', () => {
    const d = draft({
      rawDescription: 'AMEX EPAYMENT    ACH PMT    M1234 WEB ID: 9493560001',
      amountCents: -41209,
      typeCode: 'ACH_DEBIT',
    })
    expect(ruleCategory(d, 'depository')).toBe('loan_payments')
  })

  it('AMERICAN EXPRESS ACH PMT checking row → loan_payments', () => {
    const d = draft({ rawDescription: 'AMERICAN EXPRESS ACH PMT W1234', amountCents: -41209, typeCode: 'ACH_DEBIT' })
    expect(ruleCategory(d, 'depository')).toBe('loan_payments')
  })

  it('Amex card side AUTOPAY PAYMENT RECEIVED (no Type column) → loan_payments', () => {
    // amex_extended fixture row: raw -412.09 charged-positive convention → canonical +41209
    const d = draft({
      source: 'amex_csv',
      rawDescription: 'AUTOPAY PAYMENT RECEIVED - THANK YOU',
      amountCents: 41209,
      typeCode: null,
    })
    expect(ruleCategory(d, 'credit')).toBe('loan_payments')
  })

  it('checking-side descriptors do NOT fire on credit accounts', () => {
    const d = draft({ rawDescription: 'CHASE CREDIT CRD AUTOPAY', amountCents: -84355, typeCode: null })
    expect(ruleCategory(d, 'credit')).toBeNull()
  })

  it('payment descriptor alone on a depository account does not fire the card-side rule', () => {
    const d = draft({ rawDescription: 'PAYMENT THANK YOU', amountCents: 84355, typeCode: null })
    expect(ruleCategory(d, 'depository')).toBeNull()
  })
})

describe('transfers (ACCT_XFER + Zelle/QUICKPAY) by sign', () => {
  it('ACCT_XFER negative → transfer_out', () => {
    expect(ruleCategory(draft({ typeCode: 'ACCT_XFER', amountCents: -5000 }), 'depository')).toBe('transfer_out')
  })

  it('ACCT_XFER positive → transfer_in', () => {
    expect(ruleCategory(draft({ typeCode: 'ACCT_XFER', amountCents: 5000 }), 'depository')).toBe('transfer_in')
  })

  it('Zelle QUICKPAY_DEBIT negative → transfer_out', () => {
    const d = draft({
      rawDescription: 'ZELLE PAYMENT TO JOHN DOE 21987654321',
      typeCode: 'QUICKPAY_DEBIT',
      amountCents: -12000,
    })
    expect(ruleCategory(d, 'depository')).toBe('transfer_out')
  })

  it('Zelle QUICKPAY_CREDIT positive → transfer_in', () => {
    const d = draft({
      rawDescription: 'ZELLE PAYMENT FROM JANE DOE 31987654321',
      typeCode: 'QUICKPAY_CREDIT',
      amountCents: 12000,
    })
    expect(ruleCategory(d, 'depository')).toBe('transfer_in')
  })

  it('sign decides, not the typeCode suffix: a positive QUICKPAY_DEBIT reversal → transfer_in', () => {
    expect(ruleCategory(draft({ typeCode: 'QUICKPAY_DEBIT', amountCents: 12000 }), 'depository')).toBe('transfer_in')
  })
})

describe('Amex noise rules', () => {
  it('PLAN IT MONTHLY PLAN FEE → bank_fees', () => {
    const d = draft({ source: 'amex_csv', rawDescription: 'PLAN IT MONTHLY PLAN FEE', amountCents: -742 })
    expect(ruleCategory(d, 'credit')).toBe('bank_fees')
  })

  it('MEMBERSHIP REWARDS credit (positive) → transfer_in', () => {
    const d = draft({ source: 'amex_csv', rawDescription: 'MEMBERSHIP REWARDS REDEMPTION', amountCents: 4500 })
    expect(ruleCategory(d, 'credit')).toBe('transfer_in')
  })

  it('a negative MEMBERSHIP REWARDS row (redemption reversal) does not match', () => {
    const d = draft({ source: 'amex_csv', rawDescription: 'MEMBERSHIP REWARDS REDEMPTION', amountCents: -4500 })
    expect(ruleCategory(d, 'credit')).toBeNull()
  })
})

describe('payroll / ATM / checks', () => {
  it('ACH_CREDIT with ORIG CO NAME + PAYROLL and positive amount → income', () => {
    const d = draft({
      rawDescription:
        'ORIG CO NAME:ACME CORP           ORIG ID:1234567890 DESC DATE:260627 CO ENTRY DESCR:PAYROLL    SEC:PPD    TRACE#:021000021234567 EED:260627   IND ID:00012345            IND NAME:VISHNU VUGGEPALLI TRN: 1234567TC',
      amountCents: 250000,
      typeCode: 'ACH_CREDIT',
    })
    expect(ruleCategory(d, 'depository')).toBe('income')
  })

  it('ACH_CREDIT without PAYROLL/ORIG CO NAME boilerplate does not match', () => {
    expect(ruleCategory(draft({ rawDescription: 'SOME REFUND', amountCents: 5000, typeCode: 'ACH_CREDIT' }), 'depository')).toBeNull()
  })

  it('negative ACH (typeCode ACH_DEBIT) with ORIG CO NAME does not become income', () => {
    const d = draft({ rawDescription: 'ORIG CO NAME:CITY UTILITY', amountCents: -9000, typeCode: 'ACH_DEBIT' })
    expect(ruleCategory(d, 'depository')).toBeNull()
  })

  it('ATM withdrawal → uncategorized', () => {
    const d = draft({ rawDescription: 'ATM WITHDRAWAL 007352 07/02332 PIKE ST SEATTLE WA', amountCents: -10000, typeCode: 'ATM' })
    expect(ruleCategory(d, 'depository')).toBe('uncategorized')
  })

  it('CHECK_PAID → uncategorized', () => {
    const d = draft({ rawDescription: 'CHECK # 1204', amountCents: -25000, typeCode: 'CHECK_PAID' })
    expect(ruleCategory(d, 'depository')).toBe('uncategorized')
  })

  it('uncategorized is NOT spend-excluded (ATM cash still counts as spend)', () => {
    const entry = categoryById('uncategorized')
    expect(entry).toBeDefined()
    expect(entry?.excludedFromSpend).toBe(false)
    expect(entry?.isIncome).toBe(false)
  })
})

describe('ordering and fall-through', () => {
  it('first matching rule wins: checking autopay descriptor beats ACCT_XFER typeCode', () => {
    const d = draft({ rawDescription: 'CHASE CREDIT CRD EPAY', typeCode: 'ACCT_XFER', amountCents: -84355 })
    const hit = applyDefaultRules(d, 'depository')
    expect(hit?.categoryId).toBe('loan_payments')
    expect(hit?.ruleName).toBe('checking_card_autopay')
  })

  it('ordinary purchases match no rule', () => {
    const d = draft({ rawDescription: "TST* COFFEE HOUSE 0042 SEATTLE WA", amountCents: -675, typeCode: 'Sale' })
    expect(applyDefaultRules(d, 'credit')).toBeNull()
  })

  it('teller card_payment typeCode (a purchase) is NOT treated as a payment', () => {
    const d = draft({ source: 'teller', rawDescription: 'WHOLEFDS SEA 10221 SEATTLE WA', amountCents: -9241, typeCode: 'card_payment' })
    expect(applyDefaultRules(d, 'credit')).toBeNull()
  })
})

describe('fixture sweep: chase_checking.csv rows land where §5d says', () => {
  interface Row {
    description: string
    amountCents: number
    typeCode: string
  }

  function checkingRows(): Row[] {
    // Fixture descriptions are quoted but contain no embedded commas — naive split is safe here.
    return fixture('csv/chase_checking.csv')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => {
        const parts = line.split(',')
        return {
          description: (parts[2] ?? '').replace(/^"|"$/g, ''),
          amountCents: parseAmountToCents(parts[3] ?? ''),
          typeCode: parts[4] ?? '',
        }
      })
  }

  function toDraft(row: Row): TxnDraft {
    return draft({ rawDescription: row.description, amountCents: row.amountCents, typeCode: row.typeCode })
  }

  it('categorizes every checking fixture row correctly', () => {
    const rows = checkingRows()
    expect(rows).toHaveLength(7)
    const byDesc = (needle: string): Row => {
      const row = rows.find((r) => r.description.includes(needle))
      if (!row) throw new Error(`fixture row not found: ${needle}`)
      return row
    }

    const autopay = byDesc('CHASE CREDIT CRD AUTOPAY')
    expect(autopay.amountCents).toBe(-84355)
    expect(ruleCategory(toDraft(autopay), 'depository')).toBe('loan_payments')

    expect(ruleCategory(toDraft(byDesc('AMEX EPAYMENT')), 'depository')).toBe('loan_payments')
    expect(ruleCategory(toDraft(byDesc('ZELLE PAYMENT TO')), 'depository')).toBe('transfer_out')
    expect(ruleCategory(toDraft(byDesc('ACME CORP')), 'depository')).toBe('income')
    expect(ruleCategory(toDraft(byDesc('ATM WITHDRAWAL')), 'depository')).toBe('uncategorized')
    expect(ruleCategory(toDraft(byDesc('CHECK #')), 'depository')).toBe('uncategorized')
    // ordinary debit-card grocery run reaches no rule (handled by later tiers)
    expect(ruleCategory(toDraft(byDesc("TRADER JOE'S")), 'depository')).toBeNull()
  })

  it('the card-side +843.55 teller payment fixture row → loan_payments (mirror of the checking -843.55)', () => {
    const txns = JSON.parse(fixture('teller/transactions_chase_cc.json')) as Array<{
      id: string
      description: string
      amount: string
      type: string
    }>
    const payment = txns.find((t) => t.id === 'txn_cc_payment')
    if (!payment) throw new Error('txn_cc_payment fixture row missing')
    const cents = parseAmountToCents(payment.amount)
    expect(cents).toBe(84355)
    const d = draft({
      source: 'teller',
      rawDescription: payment.description,
      amountCents: cents,
      typeCode: payment.type,
    })
    expect(ruleCategory(d, 'credit')).toBe('loan_payments')
  })
})
