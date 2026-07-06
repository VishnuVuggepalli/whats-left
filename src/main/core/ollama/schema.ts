import { z } from 'zod'

import { CATEGORY_IDS } from '../categorize/taxonomy'

/**
 * Response schemas for the Ollama categorizer.
 *
 * RESPONSE_JSON_SCHEMA is sent as the Ollama `format` field so decoding is
 * grammar-constrained server-side (output physically cannot leave the enum).
 * The zod schemas re-validate client-side anyway — never trust external data.
 */

const CATEGORY_ENUM = CATEGORY_IDS as [string, ...string[]]

export const categorizationItemSchema = z.object({
  merchant: z.string(),
  category: z.enum(CATEGORY_ENUM),
  confidence: z.number().min(0).max(1),
})

export type CategorizationItem = z.infer<typeof categorizationItemSchema>

export const categorizationArraySchema = z.array(categorizationItemSchema)

/** minimal envelope of an Ollama /api/chat non-streaming response */
export const chatEnvelopeSchema = z.object({
  message: z.object({ content: z.string() }),
})

/** JSON schema for Ollama structured output (`format` field) */
export const RESPONSE_JSON_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      merchant: { type: 'string' },
      category: { type: 'string', enum: [...CATEGORY_IDS] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['merchant', 'category', 'confidence'],
    additionalProperties: false,
  },
} as const
