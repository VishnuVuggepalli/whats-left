/**
 * Button variants per the design's component inventory:
 * primary (solid blue), secondary (hairline outline), danger (red tint),
 * ghost (text only). Two sizes: md (10×18) and sm (8×14).
 */
import type { ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
export type ButtonSize = 'md' | 'sm'

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'border-0 bg-accent text-white hover:bg-accent-deep',
  secondary: 'border border-white/15 bg-transparent text-ink hover:bg-white/5',
  danger: 'border border-neg-deep/40 bg-neg-deep/10 text-neg hover:bg-neg-deep/20',
  ghost: 'border-0 bg-transparent text-muted hover:text-ink',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: 'px-[18px] py-2.5 text-[13px]',
  sm: 'px-3.5 py-2 text-xs',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    />
  )
}
