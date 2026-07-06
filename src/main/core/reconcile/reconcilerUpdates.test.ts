/**
 * Update semantics on match decisions (dates, postDate fill, externalId,
 * linkedSourceId), payee preference (passes 2–3), and draft validation.
 */
import { describe, expect, it } from 'vitest'
import { reconcile } from './reconciler'
import { decisionAt, expectMatch, makeDraft, makeExisting } from './testSupport'

describe('reconcile — payee preference (pass 2 over pass 3)', () => {
  it('prefers the same-normalized-payee candidate over a closer-dated one', () => {
    const closerWrongPayee = makeExisting({ txnDate: '2026-02-02', amountCents: -450, normalizedPayee: 'starbucks' })
    const fartherSamePayee = makeExisting({ txnDate: '2026-02-06', amountCents: -450, normalizedPayee: 'blue bottle' })
    const draft = makeDraft({ externalId: 'tel_1', txnDate: '2026-02-02', amountCents: -450, importedPayee: 'Blue Bottle' })
    const m = expectMatch(decisionAt(reconcile([draft], [closerWrongPayee, fartherSamePayee]), 0))
    expect(m.existingId).toBe(fartherSamePayee.id)
  })

  it('falls back to the closest-dated candidate when no payee matches (pass 3)', () => {
    const farther = makeExisting({ txnDate: '2026-02-07', amountCents: -450, normalizedPayee: 'alpha' })
    const closest = makeExisting({ txnDate: '2026-02-03', amountCents: -450, normalizedPayee: 'beta' })
    const draft = makeDraft({ externalId: 'tel_2', txnDate: '2026-02-02', amountCents: -450, importedPayee: 'Gamma' })
    const m = expectMatch(decisionAt(reconcile([draft], [farther, closest]), 0))
    expect(m.existingId).toBe(closest.id)
  })

  it('default normalizer ignores case and whitespace differences', () => {
    const closerWrongPayee = makeExisting({ txnDate: '2026-02-02', amountCents: -450, normalizedPayee: 'other place' })
    const fartherSamePayee = makeExisting({ txnDate: '2026-02-05', amountCents: -450, normalizedPayee: 'Blue  Bottle ' })
    const draft = makeDraft({ externalId: 'tel_3', txnDate: '2026-02-02', amountCents: -450, importedPayee: 'BLUE BOTTLE' })
    const m = expectMatch(decisionAt(reconcile([draft], [closerWrongPayee, fartherSamePayee]), 0))
    expect(m.existingId).toBe(fartherSamePayee.id)
  })

  it('uses the caller-provided normalize function when given', () => {
    const closer = makeExisting({ txnDate: '2026-02-02', amountCents: -450, normalizedPayee: 'other place' })
    const farther = makeExisting({ txnDate: '2026-02-05', amountCents: -450, normalizedPayee: 'sq starbucks #123' })
    const draft = makeDraft({ externalId: 'tel_4', txnDate: '2026-02-02', amountCents: -450, importedPayee: 'SQ STARBUCKS #999' })

    const stripStoreNumber = (p: string): string => p.toLowerCase().replace(/#\d+/g, '').replace(/\s+/g, ' ').trim()
    const withCustom = expectMatch(decisionAt(reconcile([draft], [closer, farther], { normalize: stripStoreNumber }), 0))
    expect(withCustom.existingId).toBe(farther.id)

    // default normalizer keeps store numbers → no payee match → closest wins
    const withDefault = expectMatch(decisionAt(reconcile([draft], [closer, farther]), 0))
    expect(withDefault.existingId).toBe(closer.id)
  })
})

describe('reconcile — match update fields', () => {
  it('always records linkedSourceId = draft.externalId when present', () => {
    const row = makeExisting({ txnDate: '2026-02-02', amountCents: -450 })
    const draft = makeDraft({ externalId: 'tel_link', txnDate: '2026-02-02', amountCents: -450 })
    const m = expectMatch(decisionAt(reconcile([draft], [row]), 0))
    expect(m.updates.linkedSourceId).toBe('tel_link')
  })

  it('falls back to linkedSourceId = draft.importHash for hash-only drafts', () => {
    const row = makeExisting({ source: 'teller', externalId: 'tel_x', txnDate: '2026-02-02', amountCents: -450 })
    const draft = makeDraft({ source: 'chase_csv', externalId: null, importHash: 'csv_hash_7', txnDate: '2026-02-02', amountCents: -450 })
    const m = expectMatch(decisionAt(reconcile([draft], [row]), 0))
    expect(m.updates.linkedSourceId).toBe('csv_hash_7')
    expect(m.updates.externalId).toBeUndefined() // existing already has one
  })

  it('fills postDate only when existing lacks it', () => {
    const noPost = makeExisting({ txnDate: '2026-02-02', postDate: null, amountCents: -450 })
    const draft = makeDraft({ externalId: 'tel_5', txnDate: '2026-02-02', postDate: '2026-02-04', amountCents: -450 })
    const m = expectMatch(decisionAt(reconcile([draft], [noPost]), 0))
    expect(m.updates.postDate).toBe('2026-02-04')
  })

  it('never overwrites an existing postDate', () => {
    const hasPost = makeExisting({ txnDate: '2026-02-02', postDate: '2026-02-03', amountCents: -450 })
    const draft = makeDraft({ externalId: 'tel_6', txnDate: '2026-02-02', postDate: '2026-02-05', amountCents: -450 })
    const m = expectMatch(decisionAt(reconcile([draft], [hasPost]), 0))
    expect(m.updates.postDate).toBeUndefined()
  })

  it('leaves postDate unset when the draft has none', () => {
    const noPost = makeExisting({ txnDate: '2026-02-02', postDate: null, amountCents: -450 })
    const draft = makeDraft({ externalId: 'tel_7', txnDate: '2026-02-02', postDate: null, amountCents: -450 })
    const m = expectMatch(decisionAt(reconcile([draft], [noPost]), 0))
    expect(m.updates.postDate).toBeUndefined()
  })

  it('keeps the earliest txnDate (minIso) and omits the update when unchanged', () => {
    const row = makeExisting({ txnDate: '2026-02-01', amountCents: -450 })
    const earlier = makeDraft({ externalId: 'tel_8', txnDate: '2026-01-28', postDate: '2026-02-01', amountCents: -450 })
    const later = makeDraft({ externalId: 'tel_9', txnDate: '2026-02-03', postDate: '2026-02-03', amountCents: -450 })

    const earlierMatch = expectMatch(decisionAt(reconcile([earlier], [row]), 0))
    expect(earlierMatch.updates.txnDate).toBe('2026-01-28')

    const laterMatch = expectMatch(decisionAt(reconcile([later], [row]), 0))
    expect(laterMatch.updates.txnDate).toBeUndefined()
  })

  it('same-source upgrade: sets externalId when existing has none and draft has one', () => {
    const row = makeExisting({ source: 'amex_csv', externalId: null, importHash: 'amex_h1', txnDate: '2026-02-02', amountCents: -450 })
    const draft = makeDraft({ source: 'amex_csv', externalId: 'REF_42', importHash: 'amex_h2', txnDate: '2026-02-02', amountCents: -450 })
    const m = expectMatch(decisionAt(reconcile([draft], [row]), 0))
    expect(m.updates.externalId).toBe('REF_42')
  })
})

describe('reconcile — draft validation (fail loud at the boundary)', () => {
  it('rejects a non-ISO txnDate', () => {
    const draft = makeDraft({ txnDate: '02/02/2026' })
    expect(() => reconcile([draft], [])).toThrow(/txnDate/)
  })

  it('rejects a non-ISO postDate', () => {
    const draft = makeDraft({ postDate: '2026-2-2' })
    expect(() => reconcile([draft], [])).toThrow(/postDate/)
  })

  it('rejects a non-integer amountCents', () => {
    const draft = makeDraft({ amountCents: -4.5 })
    expect(() => reconcile([draft], [])).toThrow(/amountCents/)
  })

  it('rejects an empty importHash', () => {
    const draft = makeDraft({ importHash: '' })
    expect(() => reconcile([draft], [])).toThrow(/importHash/)
  })
})
