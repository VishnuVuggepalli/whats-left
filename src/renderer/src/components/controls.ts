/**
 * Shared form-control classes per the design: inset #0B1428 wells with a
 * 10%-white hairline, 8px radius. (Plain constants — native inputs/selects
 * keep their own semantics and keyboard behavior.)
 */

export const INPUT_CLASS =
  'rounded-lg border border-white/10 bg-deep px-3 py-2 text-[13px] text-ink placeholder:text-faint'

export const SELECT_CLASS =
  'cursor-pointer rounded-lg border border-white/10 bg-deep px-3 py-2 text-xs font-medium text-ink-dim [color-scheme:dark]'

/** monospace variant for URLs / model names / masks */
export const INPUT_MONO_CLASS = `${INPUT_CLASS} font-mono text-[12.5px]`
