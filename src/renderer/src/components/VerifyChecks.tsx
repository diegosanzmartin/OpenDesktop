import { useState, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { IconButton, Row } from './settings-ui'

const field =
  'border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 rounded-lg border px-2.5 py-1.5 font-mono text-[12px] outline-none'

/**
 * Which check runs after the agent edits files, per folder.
 *
 * The deepest folder holding a session wins, so a monorepo can have one check
 * at its root and another for a package. Saved as typed into `verify`.
 */
export function VerifyChecks({
  value,
  onSave
}: {
  value: Record<string, string> | undefined
  onSave: (next: Record<string, string>) => void
}): ReactNode {
  const current = value ?? {}
  const [folder, setFolder] = useState('')
  const [command, setCommand] = useState('')
  return (
    <Row
      align="start"
      label="Check after editing"
      description="Run after a step in which the agent wrote or edited a file, in the session's folder. If it fails, the agent reads its output before going on. The deepest folder that holds the session wins."
    >
      <div className="flex w-[420px] flex-col gap-1.5">
        {Object.entries(current).map(([path, check]) => (
          <div key={path} className="flex items-center gap-1.5">
            <span className="text-ink-400 min-w-0 flex-1 truncate font-mono text-[11.5px]" title={path}>
              {path}
            </span>
            <input value={check} readOnly className={`${field} w-[170px]`} />
            <IconButton
              title="Remove this check"
              tone="danger"
              onClick={() => {
                const next = { ...current }
                delete next[path]
                onSave(next)
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <input
            data-new
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
            placeholder="/Users/me/work/shop"
            className={`${field} min-w-0 flex-1`}
          />
          <input
            data-new
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="pnpm typecheck"
            className={`${field} w-[170px]`}
          />
          <button
            type="button"
            disabled={!folder.trim() || !command.trim()}
            onClick={() => {
              onSave({ ...current, [folder.trim().replace(/\/+$/, '')]: command.trim() })
              setFolder('')
              setCommand('')
            }}
            className="border-ink-700 text-ink-200 hover:bg-ink-800 rounded-lg border px-2.5 py-1.5 text-[12px] disabled:opacity-40"
          >
            Add
          </button>
        </div>
      </div>
    </Row>
  )
}
