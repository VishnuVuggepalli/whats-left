/**
 * Category → swatch color, per the design's "Chart categorical" tokens:
 * a muted, colorblind-safe palette that never reuses the semantic hues
 * (green = money in, amber = attention, red = danger, blue = interactive).
 *
 * Income-ish categories intentionally use the semantic green — "money in"
 * IS their meaning. Everything else gets a stable palette assignment:
 * known taxonomy ids are pinned to match the design; unknown ids hash
 * deterministically into the palette so colors never shuffle between loads.
 */
import type { CategoryDto } from '../../../shared/types'

export const CHART_PALETTE = [
  '#7C83C4', // periwinkle
  '#4E9C99', // teal
  '#C57B96', // rose
  '#B39B57', // ochre
  '#9E7FB0', // lilac
  '#C08A63', // clay
  '#8FA07E', // sage
  '#8C8FA8', // slate
  '#B0788F', // mauve
  '#6FA0A8', // surf
] as const

const INCOME_GREEN = '#059669'
const UNCATEGORIZED_GRAY = '#64748B'

/** Taxonomy ids pinned to the swatches the design canvas uses. */
const PINNED: Readonly<Record<string, string>> = {
  groceries: '#7C83C4',
  food_and_drink: '#4E9C99',
  transportation: '#C57B96',
  general_merchandise: '#B39B57',
  personal_care: '#9E7FB0',
  medical: '#C08A63',
  entertainment: '#8FA07E',
  rent_and_utilities: '#8C8FA8',
  travel: '#B0788F',
  home_improvement: '#6FA0A8',
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/** Stable swatch for a category id (null/uncategorized → neutral gray). */
export function categoryColor(categoryId: string | null, category?: CategoryDto): string {
  if (categoryId === null || categoryId === 'uncategorized') return UNCATEGORIZED_GRAY
  if (category?.isIncome === true || categoryId === 'income') return INCOME_GREEN
  const pinned = PINNED[categoryId]
  if (pinned !== undefined) return pinned
  const swatch = CHART_PALETTE[hashString(categoryId) % CHART_PALETTE.length]
  // CHART_PALETTE is non-empty; index is always in range.
  return swatch ?? UNCATEGORIZED_GRAY
}
