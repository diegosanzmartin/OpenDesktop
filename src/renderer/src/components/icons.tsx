import type { ReactNode, SVGProps } from 'react'

/**
 * A diff: a plus above a minus, boxed.
 *
 * Hand-drawn rather than taken from the icon set, which has a `diff` glyph but
 * without the surrounding square — and the square is what makes it read as a
 * pane in a row of pane buttons. Shaped to lucide's conventions (24 viewBox,
 * 2px round strokes, currentColor) so it sits in a toolbar beside them without
 * looking like a different family.
 */
export function DiffSquare(props: SVGProps<SVGSVGElement>): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <rect x="3" y="3" width="18" height="18" rx="3.5" />
      <path d="M12 7.5v5" />
      <path d="M9.5 10h5" />
      <path d="M9.5 15.5h5" />
    </svg>
  )
}
