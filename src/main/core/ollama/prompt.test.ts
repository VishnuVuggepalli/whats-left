import { describe, expect, it } from 'vitest'

import { CATEGORY_IDS } from '../categorize/taxonomy'
import { buildSystemPrompt, buildUserPrompt } from './prompt'

describe('buildSystemPrompt', () => {
  it('includes a one-liner for every taxonomy category id', () => {
    const prompt = buildSystemPrompt([])
    for (const id of CATEGORY_IDS) {
      expect(prompt).toContain(`- ${id}:`)
    }
  })

  it('omits the examples block when there are no few-shot examples', () => {
    const prompt = buildSystemPrompt([])
    expect(prompt).not.toContain('past user corrections')
  })

  it('embeds few-shot examples verbatim', () => {
    const prompt = buildSystemPrompt([
      { merchant: 'Blue Bottle Coffee', category: 'food_and_drink' },
      { merchant: 'Trader Joes', category: 'groceries' },
    ])
    expect(prompt).toContain('past user corrections')
    expect(prompt).toContain('Blue Bottle Coffee')
    expect(prompt).toContain('"food_and_drink"')
    expect(prompt).toContain('Trader Joes')
    expect(prompt).toContain('"groceries"')
  })

  it('does not mutate the few-shot input array', () => {
    const fewShot = [{ merchant: 'A', category: 'travel' }]
    const snapshot = JSON.parse(JSON.stringify(fewShot))
    buildSystemPrompt(fewShot)
    expect(fewShot).toEqual(snapshot)
  })
})

describe('buildUserPrompt', () => {
  it('is a strict JSON array of the merchant strings', () => {
    const merchants = ['STARBUCKS #123', 'AMZN Mktp US']
    const prompt = buildUserPrompt(merchants)
    expect(JSON.parse(prompt)).toEqual(merchants)
  })

  it('handles merchants with quotes and unicode safely', () => {
    const merchants = ['Joe\'s "Best" Café', '寿司 & Sushi']
    expect(JSON.parse(buildUserPrompt(merchants))).toEqual(merchants)
  })
})
