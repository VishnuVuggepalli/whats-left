import type { AccountType, TxnDraft } from '../../../shared/types'
import type { CategoryId } from './taxonomy'

/**
 * Shipped default rules — HARD-CODED ordered table (plan §5d, §6 tier 1).
 * v1 has no rules engine; these are the both-sides payment/transfer excluders
 * that keep the monthly card autopay from doubling total spend. First matching
 * rule wins. Pure: never mutates the draft.
 */

export interface DefaultRule {
  name: string
  categoryId: CategoryId
  test(draft: TxnDraft, accountType: AccountType): boolean
}

export interface DefaultRuleHit {
  categoryId: CategoryId
  ruleName: string
}

/** checking-side card-payment descriptors (plan §5d) */
const CHECKING_CARD_PAYMENT_RES: readonly RegExp[] = [
  /CHASE CREDIT CRD (AUTOPAY|EPAY)/i,
  /AMEX EPAYMENT/i,
  /AMERICAN EXPRESS ACH PMT/i,
]

/** card-side payment descriptors for sources without a Type column (Amex CSV) */
const CARD_PAYMENT_DESCRIPTOR_RE = /PAYMENT\s+(RECEIVED|THANK\s*YOU)/i
const PLAN_IT_FEE_RE = /PLAN IT MONTHLY PLAN FEE/i
const MEMBERSHIP_REWARDS_RE = /MEMBERSHIP REWARDS/i
const PAYROLL_RE = /PAYROLL|ORIG CO NAME/i

/** Chase credit CSV Type='Payment' | Teller type='payment' (NOT 'card_payment') */
function isPaymentTypeCode(typeCode: string | null): boolean {
  return typeCode !== null && typeCode.toLowerCase() === 'payment'
}

function isQuickpay(typeCode: string | null): boolean {
  return typeCode === 'QUICKPAY_DEBIT' || typeCode === 'QUICKPAY_CREDIT'
}

export const DEFAULT_RULES: readonly DefaultRule[] = [
  {
    // card side: payment received on the card is a loan payment, never spend
    name: 'card_payment_received',
    categoryId: 'loan_payments',
    test: (d, accountType) =>
      accountType === 'credit' &&
      (isPaymentTypeCode(d.typeCode) ||
        (d.amountCents > 0 && CARD_PAYMENT_DESCRIPTOR_RE.test(d.rawDescription))),
  },
  {
    // checking side: the same payment leaving the checking account
    name: 'checking_card_autopay',
    categoryId: 'loan_payments',
    test: (d, accountType) =>
      accountType === 'depository' && CHECKING_CARD_PAYMENT_RES.some((re) => re.test(d.rawDescription)),
  },
  {
    name: 'account_transfer_out',
    categoryId: 'transfer_out',
    test: (d) => d.typeCode === 'ACCT_XFER' && d.amountCents < 0,
  },
  {
    name: 'account_transfer_in',
    categoryId: 'transfer_in',
    test: (d) => d.typeCode === 'ACCT_XFER' && d.amountCents >= 0,
  },
  {
    // Zelle — direction by sign, not by which QUICKPAY code (reversals flip sign)
    name: 'zelle_transfer_out',
    categoryId: 'transfer_out',
    test: (d) => isQuickpay(d.typeCode) && d.amountCents < 0,
  },
  {
    name: 'zelle_transfer_in',
    categoryId: 'transfer_in',
    test: (d) => isQuickpay(d.typeCode) && d.amountCents >= 0,
  },
  {
    name: 'amex_plan_it_fee',
    categoryId: 'bank_fees',
    test: (d) => PLAN_IT_FEE_RE.test(d.rawDescription),
  },
  {
    // Membership Rewards redemption credits are not income and not spend
    name: 'membership_rewards_credit',
    categoryId: 'transfer_in',
    test: (d) => d.amountCents > 0 && MEMBERSHIP_REWARDS_RE.test(d.rawDescription),
  },
  {
    name: 'payroll_income',
    categoryId: 'income',
    test: (d) => d.typeCode === 'ACH_CREDIT' && d.amountCents > 0 && PAYROLL_RE.test(d.rawDescription),
  },
  {
    // cash + checks: unknowable merchant, but still real spend (NOT excluded)
    name: 'atm_withdrawal',
    categoryId: 'uncategorized',
    test: (d) => d.typeCode === 'ATM',
  },
  {
    name: 'check_paid',
    categoryId: 'uncategorized',
    test: (d) => d.typeCode === 'CHECK_PAID',
  },
]

/** First matching rule wins; null = no rule applies (later tiers take over). */
export function applyDefaultRules(draft: TxnDraft, accountType: AccountType): DefaultRuleHit | null {
  for (const rule of DEFAULT_RULES) {
    if (rule.test(draft, accountType)) {
      return { categoryId: rule.categoryId, ruleName: rule.name }
    }
  }
  return null
}
