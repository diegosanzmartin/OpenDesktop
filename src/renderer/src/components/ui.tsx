import clsx from 'clsx'
import type { ReactNode, SelectHTMLAttributes } from 'react'

/**
 * The frame the window's two big panes share: the chat and the dock beside it.
 *
 * One constant because they sit side by side and their edges are read
 * together. They were written separately — the chat `mb-2 ml-1 mr-1`, the dock
 * `m-2 ml-1` — so the dock's rounded corner started eight pixels below the
 * chat's and finished four further in from the window. Nothing was broken;
 * it just looked like nobody had put them next to each other.
 */
export const PANE_FRAME = 'border-ink-800 mb-2 ml-1 mr-1 overflow-hidden rounded-lg border'

export function Panel({ className, children }: { className?: string; children: ReactNode }): ReactNode {
  return <div className={clsx('bg-ink-850 border-ink-800 rounded-xl border', className)}>{children}</div>
}

export function Label({ children }: { children: ReactNode }): ReactNode {
  return <span className="text-ink-500 text-[11.5px]">{children}</span>
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  options: { value: string; label: string }[]
}

export function Select({ label, options, className, ...rest }: SelectProps): ReactNode {
  return (
    <label className={clsx('flex items-center gap-1.5', className)}>
      {label ? <Label>{label}</Label> : null}
      <select
        {...rest}
        className="bg-ink-800 border-ink-800 text-ink-300 hover:text-ink-100 focus:border-ink-600 cursor-pointer rounded-md border px-2 py-1 text-[12px] outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Button({
  children,
  onClick,
  variant = 'ghost',
  size = 'md',
  disabled,
  title,
  className
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'ghost' | 'primary' | 'danger' | 'outline'
  size?: 'sm' | 'md'
  disabled?: boolean
  title?: string
  className?: string
}): ReactNode {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'px-2 py-1 text-[11.5px]' : 'px-3 py-1.5 text-[12.5px]',
        variant === 'primary' && 'bg-brand hover:bg-brand-dim text-ink-950',
        variant === 'danger' && 'bg-bad/15 text-bad hover:bg-bad/25',
        variant === 'outline' && 'border-ink-700 text-ink-200 hover:border-ink-600 hover:bg-ink-800 border',
        variant === 'ghost' && 'text-ink-400 hover:bg-ink-800 hover:text-ink-100',
        className
      )}
    >
      {children}
    </button>
  )
}

export function Chip({
  children,
  active,
  onClick,
  color
}: {
  children: ReactNode
  active?: boolean
  onClick?: () => void
  color?: string
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      style={active && color ? { borderColor: color, color } : undefined}
      className={clsx(
        'rounded-full border px-2 py-[2px] text-[10px] font-medium transition-colors',
        active
          ? 'border-brand text-brand bg-brand/10'
          : 'border-ink-700 text-ink-500 hover:border-ink-600 hover:text-ink-300'
      )}
    >
      {children}
    </button>
  )
}

export function StatusDot({ status, className }: { status: string; className?: string }): ReactNode {
  const color =
    status === 'running'
      ? 'text-info'
      : status === 'awaiting-approval'
        ? 'text-warn'
        : status === 'error'
          ? 'text-bad'
          : status === 'success'
            ? 'text-ok'
            : 'text-ink-600'
  const live = status === 'running' || status === 'awaiting-approval'
  return (
    <span className={clsx('relative inline-flex h-1.5 w-1.5 shrink-0', color, className)}>
      <span className={clsx('h-1.5 w-1.5 rounded-full bg-current', live && 'running-dot')} />
    </span>
  )
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="text-ink-500 px-3 py-6 text-center text-[11px]">{children}</div>
}

export function GroupHeader({ label, count }: { label: string; count: number }): ReactNode {
  return (
    <div className="bg-ink-900/95 sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 backdrop-blur">
      <span className="text-ink-400 text-[10px] font-semibold uppercase tracking-[0.08em]">{label}</span>
      <span className="text-ink-600 text-[10px]">{count}</span>
      <span className="bg-ink-800 h-px flex-1" />
    </div>
  )
}
