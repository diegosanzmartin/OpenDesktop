import clsx from 'clsx'
import type { ReactNode, SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'

/**
 * The shape of a settings page: headed sections of labelled rows, each row a
 * question on the left and its answer on the right.
 *
 * The old pages were panels of boxed fields with a text button beside each one,
 * which made every screen read as a form to fill in rather than as a list of
 * things that are already set. A row says what it is and shows its value;
 * actions are icons, because a row that needs a sentence on a button is a row
 * whose label is not doing its job.
 */
export function Section({
  title,
  description,
  action,
  children
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <section className="mb-9">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-ink-100 text-[15px] font-semibold">{title}</h2>
        {action ? <div className="ml-auto flex items-center gap-1">{action}</div> : null}
      </div>
      {description ? (
        <p className="text-ink-500 mb-3 max-w-[70ch] text-[12.5px] leading-[1.6]">{description}</p>
      ) : (
        <div className="mb-2" />
      )}
      <div className="border-ink-800/70 border-t">{children}</div>
    </section>
  )
}

export function Row({
  label,
  description,
  children,
  align = 'center'
}: {
  label?: ReactNode
  description?: ReactNode
  children?: ReactNode
  /** `start` for rows whose control is tall, like a textarea. */
  align?: 'center' | 'start'
}): ReactNode {
  return (
    <div
      className={clsx(
        'border-ink-800/70 flex gap-4 border-b py-3.5',
        align === 'center' ? 'items-center' : 'items-start'
      )}
    >
      {label !== undefined ? (
        <div className="min-w-0 flex-1">
          <div className="text-ink-200 text-[13.5px]">{label}</div>
          {description ? (
            <div className="text-ink-500 mt-0.5 max-w-[60ch] text-[12px] leading-[1.55]">
              {description}
            </div>
          ) : null}
        </div>
      ) : null}
      {children !== undefined ? (
        <div className={clsx('flex shrink-0 items-center gap-1.5', label === undefined && 'w-full')}>
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** A value you can type. Right-aligned like the rest of a row's answers. */
export function RowInput({
  value,
  onChange,
  placeholder,
  mono,
  width = 'w-[280px]',
  type,
  disabled
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  mono?: boolean
  width?: string
  type?: string
  disabled?: boolean
}): ReactNode {
  return (
    <input
      value={value}
      type={type}
      disabled={disabled}
      spellCheck={false}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={clsx(
        'border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 rounded-lg border px-2.5 py-1.5 text-[12.5px] outline-none disabled:opacity-50',
        mono && 'font-mono',
        width
      )}
    />
  )
}

interface RowSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: { value: string; label: string }[]
}

/** A choice, drawn as its current value and a chevron rather than as a box. */
export function RowSelect({ options, className, ...rest }: RowSelectProps): ReactNode {
  return (
    <span className="relative inline-flex items-center">
      <select
        {...rest}
        className={clsx(
          'text-ink-200 hover:text-ink-100 cursor-pointer appearance-none bg-transparent py-1 pr-5 text-right text-[13px] outline-none',
          className
        )}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-ink-850">
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="text-ink-500 pointer-events-none absolute right-0 h-3.5 w-3.5" />
    </span>
  )
}

/**
 * An action with no words. Every one carries a title, which is the tooltip and
 * the accessible name — an icon nobody can name is a worse button than a wordy
 * one.
 */
export function IconButton({
  title,
  onClick,
  children,
  tone = 'plain',
  disabled
}: {
  title: string
  onClick: () => void
  children: ReactNode
  tone?: 'plain' | 'danger' | 'accent'
  disabled?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'rounded-md p-1.5 transition-colors disabled:opacity-40',
        tone === 'danger'
          ? 'text-ink-500 hover:bg-bad/10 hover:text-bad'
          : tone === 'accent'
            ? 'text-brand hover:bg-brand/10'
            : 'text-ink-500 hover:bg-ink-800 hover:text-ink-100'
      )}
    >
      {children}
    </button>
  )
}

/** A switch for a setting that is simply on or off. */
export function Toggle({
  checked,
  onChange,
  title
}: {
  checked: boolean
  onChange: (next: boolean) => void
  title?: string
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-[20px] w-[34px] rounded-full transition-colors',
        checked ? 'bg-brand' : 'bg-ink-700'
      )}
    >
      <span
        className={clsx(
          'absolute top-[2px] h-4 w-4 rounded-full bg-white transition-all',
          checked ? 'left-[16px]' : 'left-[2px]'
        )}
      />
    </button>
  )
}

/**
 * A coarse slider for a judgement.
 *
 * Five steps and both ends labelled, because that is the resolution the thing
 * being set actually has: nobody can say one model is 0.72 as capable as
 * another, and a 0–100 slider would invite them to try.
 */
export function RowSlider({
  value,
  onChange,
  low,
  high,
  steps = 5,
  title
}: {
  value: number
  onChange: (next: number) => void
  low: string
  high: string
  steps?: number
  title?: string
}): ReactNode {
  return (
    <div className="flex min-w-0 items-center gap-2" title={title}>
      <span className="text-ink-600 shrink-0 text-[11px]">{low}</span>
      <div className="flex shrink-0 items-center gap-1">
        {Array.from({ length: steps }, (_, index) => index + 1).map((step) => (
          <button
            key={step}
            type="button"
            aria-label={`${step} of ${steps}`}
            aria-pressed={step === value}
            onClick={() => onChange(step)}
            className={clsx(
              'h-[18px] w-[18px] rounded-full border transition-colors',
              step === value
                ? 'border-brand bg-brand'
                : step < value
                  ? 'border-brand/40 bg-brand/30'
                  : 'border-ink-700 hover:border-ink-500'
            )}
          />
        ))}
      </div>
      <span className="text-ink-600 shrink-0 text-[11px]">{high}</span>
    </div>
  )
}

/** A small status word beside a row, for saved / failed / not resolved. */
export function Hint({
  tone = 'muted',
  children
}: {
  tone?: 'muted' | 'ok' | 'warn' | 'bad'
  children: ReactNode
}): ReactNode {
  return (
    <span
      className={clsx(
        'text-[11.5px]',
        tone === 'ok'
          ? 'text-ok'
          : tone === 'warn'
            ? 'text-warn'
            : tone === 'bad'
              ? 'text-bad'
              : 'text-ink-600'
      )}
    >
      {children}
    </span>
  )
}
