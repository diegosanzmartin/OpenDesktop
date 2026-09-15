import clsx from 'clsx'
import type { ReactNode, SelectHTMLAttributes } from 'react'

export function Panel({ className, children }: { className?: string; children: ReactNode }): ReactNode {
  return <div className={clsx('bg-ink-850 border-ink-700 rounded-lg border', className)}>{children}</div>
}

export function Label({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="text-ink-500 text-[10px] font-semibold uppercase tracking-[0.08em]">{children}</span>
  )
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
        className="bg-ink-800 border-ink-700 text-ink-200 hover:border-ink-600 focus:border-brand cursor-pointer rounded border px-1.5 py-0.5 text-[11px] outline-none"
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
        'inline-flex items-center gap-1.5 rounded font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
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
