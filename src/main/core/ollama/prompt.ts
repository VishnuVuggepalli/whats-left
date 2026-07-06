import { TAXONOMY } from '../categorize/taxonomy'

/**
 * Prompt construction for the Ollama categorizer (plan §6 tier 4).
 * System prompt = taxonomy one-liners + few-shot from past user corrections.
 * User prompt = strict JSON array of the batch's merchant strings.
 */

export interface FewShotExample {
  merchant: string
  category: string
}

/** one-line definition per category id; falls back to the display name */
const DEFINITIONS: Readonly<Record<string, string>> = {
  income: 'paychecks, salary, interest, dividends — earned money coming in',
  transfer_in: 'incoming transfers between your own accounts',
  transfer_out: 'outgoing transfers between your own accounts',
  loan_payments: 'credit card payments, mortgage, auto and student loan payments',
  bank_fees: 'overdraft, ATM, service and interest fees charged by banks',
  entertainment: 'streaming, movies, concerts, games, events',
  food_and_drink: 'restaurants, bars, coffee shops, fast food, food delivery',
  groceries: 'supermarkets and grocery stores',
  general_merchandise: 'retail shopping, online marketplaces, clothing, electronics',
  home_improvement: 'hardware stores, furniture, repairs, home services',
  medical: 'doctors, dentists, pharmacies, health insurance',
  personal_care: 'gyms, salons, spas, barbers, cosmetics',
  general_services: 'professional services, subscriptions, insurance, education',
  government_and_non_profit: 'taxes, government fees, charitable donations',
  transportation: 'gas stations, parking, rideshare, public transit, tolls',
  travel: 'flights, hotels, rental cars, vacation bookings',
  rent_and_utilities: 'rent, electricity, water, internet, phone bills',
  uncategorized: 'use only when no other category plausibly fits',
}

function taxonomyLines(): string {
  return TAXONOMY.map((entry) => {
    const definition = DEFINITIONS[entry.id] ?? entry.name
    return `- ${entry.id}: ${entry.name} — ${definition}`
  }).join('\n')
}

function fewShotBlock(fewShot: readonly FewShotExample[]): string {
  if (fewShot.length === 0) return ''
  const examples = fewShot.map((example) => ({
    merchant: example.merchant,
    category: example.category,
  }))
  return [
    '',
    'Examples from past user corrections (follow these exactly for the same merchants):',
    JSON.stringify(examples, null, 2),
  ].join('\n')
}

export function buildSystemPrompt(fewShot: readonly FewShotExample[]): string {
  return [
    'You are a transaction categorizer for a personal expense tracker.',
    'You will receive a JSON array of merchant names. Assign exactly one category id to each.',
    '',
    'Category ids (use the id on the left, exactly as written):',
    taxonomyLines(),
    '',
    'Rules:',
    '- Respond ONLY with a JSON array; one entry per input merchant.',
    '- Each entry: {"merchant": <the input string, copied exactly>, "category": <a category id>, "confidence": <number 0..1>}.',
    '- Never invent category ids. If unsure, use "uncategorized" with low confidence.',
    fewShotBlock(fewShot),
  ].join('\n')
}

export function buildUserPrompt(merchants: readonly string[]): string {
  return JSON.stringify(merchants)
}
