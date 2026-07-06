/**
 * Inline stroke icons (lucide paths lifted from the design canvas) so the
 * app stays fully offline — no icon font, no dependency.
 */
import type { ReactNode } from 'react'

export interface IconProps {
  size?: number
  strokeWidth?: number
  className?: string
}

function makeIcon(children: ReactNode, defaultStroke = 2) {
  return function Icon({ size = 15, strokeWidth = defaultStroke, className = '' }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
        focusable="false"
      >
        {children}
      </svg>
    )
  }
}

export const IconLogo = makeIcon(
  <>
    <path d="M3 3v18h18" />
    <path d="m19 9-5 5-4-4-3 3" />
  </>,
  2.6,
)

export const IconWarning = makeIcon(
  <>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </>,
)

export const IconX = makeIcon(
  <>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>,
  2.2,
)

export const IconChevronLeft = makeIcon(<path d="m15 18-6-6 6-6" />)
export const IconChevronRight = makeIcon(<path d="m9 18 6-6-6-6" />)

export const IconSearch = makeIcon(
  <>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </>,
)

export const IconRefresh = makeIcon(
  <>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </>,
)

export const IconDownload = makeIcon(
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" x2="12" y1="15" y2="3" />
  </>,
)

export const IconCheck = makeIcon(<path d="M20 6 9 17l-5-5" />)

export const IconCheckCircle = makeIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="m9 12 2 2 4-4" />
  </>,
)

export const IconClock = makeIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </>,
)

export const IconPencil = makeIcon(
  <>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </>,
)

export const IconPlus = makeIcon(
  <>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </>,
)

export const IconLink = makeIcon(
  <>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </>,
)

export const IconFileText = makeIcon(
  <>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
  </>,
)

export const IconFileBroken = makeIcon(
  <>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="m9.5 12.5 5 5" />
    <path d="m14.5 12.5-5 5" />
  </>,
)

export const IconTrendUp = makeIcon(
  <>
    <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
    <polyline points="16 7 22 7 22 13" />
  </>,
)

export const IconTrendDown = makeIcon(
  <>
    <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
    <polyline points="16 17 22 17 22 11" />
  </>,
)

export const IconUndo = makeIcon(
  <>
    <polyline points="9 14 4 9 9 4" />
    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
  </>,
)

export const IconArrowLeftRight = makeIcon(
  <>
    <path d="M8 3 4 7l4 4" />
    <path d="M4 7h16" />
    <path d="m16 21 4-4-4-4" />
    <path d="M20 17H4" />
  </>,
)

export const IconArrowRight = makeIcon(
  <>
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </>,
)

export const IconBank = makeIcon(
  <>
    <line x1="3" x2="21" y1="22" y2="22" />
    <line x1="6" x2="6" y1="18" y2="11" />
    <line x1="10" x2="10" y1="18" y2="11" />
    <line x1="14" x2="14" y1="18" y2="11" />
    <line x1="18" x2="18" y1="18" y2="11" />
    <polygon points="12 2 20 7 4 7" />
  </>,
)

export const IconWifiOff = makeIcon(
  <>
    <path d="M18.36 6.64A9 9 0 0 1 20.77 15" />
    <path d="M6.16 6.16a9 9 0 1 0 12.68 12.68" />
    <path d="M12 2v4" />
    <path d="m2 2 20 20" />
  </>,
)
