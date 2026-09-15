import { useEffect, useState, type ReactNode } from 'react'
import { Download, FolderOpen, Trash2 } from 'lucide-react'
import type { Skill } from '@shared/types'
import { useStore } from '../state/store'
import { Button, Label, Panel } from './ui'

export function SkillsTab(): ReactNode {
  const skills = useStore((s) => s.skills)
  const refreshSkills = useStore((s) => s.refreshSkills)

  const [dir, setDir] = useState('')
  const [importable, setImportable] = useState<(Skill & { alreadyHere: boolean })[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    setImportable(await window.opendesktop.skills.importable())
    await refreshSkills()
  }

  useEffect(() => {
    void window.opendesktop.skills.dir().then(setDir)
    void reload()
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-ink-500 font-mono text-[11.5px]">{dir}</span>
        <Button size="sm" onClick={() => void window.opendesktop.skills.reveal()}>
          <FolderOpen className="h-3 w-3" />
          Reveal
        </Button>
        <span className="text-ink-600 text-[11.5px]">
          — type <span className="font-mono">/</span> in the composer to use one
        </span>
      </div>

      {status ? (
        <div className="border-ok/40 bg-ok/10 text-ok rounded-md border px-2.5 py-1.5 text-[12px]">
          {status}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        <Panel className="px-3 py-3">
          <div className="mb-2 flex items-center gap-2">
            <Label>Installed</Label>
            <span className="text-ink-600 text-[11.5px]">{skills.length}</span>
          </div>
          {skills.length === 0 ? (
            <span className="text-ink-600 text-[12px]">
              None yet. Import the ones you already have below.
            </span>
          ) : (
            <div className="space-y-1.5">
              {skills.map((skill) => (
                <div key={skill.id} className="flex items-start gap-2">
                  <span className="text-brand shrink-0 font-mono text-[12px]">/{skill.id}</span>
                  <span className="text-ink-500 min-w-0 flex-1 text-[11.5px]">
                    {skill.description}
                    {skill.files.length > 0 ? (
                      <span className="text-ink-700"> · {skill.files.length} extra files</span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    title="Remove"
                    onClick={async () => {
                      await window.opendesktop.skills.remove(skill.id)
                      await reload()
                    }}
                    className="text-ink-600 hover:text-bad shrink-0"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel className="px-3 py-3">
          <div className="mb-2 flex items-center gap-2">
            <Label>Import from ~/.claude/skills</Label>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={picked.size === 0}
              onClick={async () => {
                const count = await window.opendesktop.skills.importFrom([...picked])
                setPicked(new Set())
                await reload()
                setStatus(`Imported ${count} skill${count === 1 ? '' : 's'}.`)
              }}
            >
              <Download className="h-3 w-3" />
              Import {picked.size > 0 ? picked.size : ''}
            </Button>
          </div>

          {importable.length === 0 ? (
            <span className="text-ink-600 text-[12px]">
              Nothing found there. A skill is a folder with a SKILL.md inside — the same layout
              both tools use, so it can simply be copied.
            </span>
          ) : (
            <div className="space-y-1">
              {importable.map((skill) => (
                <label
                  key={skill.id}
                  className="flex cursor-pointer items-start gap-2 py-[2px]"
                  title={skill.alreadyHere ? 'Importing again overwrites the copy here' : undefined}
                >
                  <input
                    type="checkbox"
                    checked={picked.has(skill.id)}
                    onChange={(event) => {
                      const next = new Set(picked)
                      if (event.target.checked) next.add(skill.id)
                      else next.delete(skill.id)
                      setPicked(next)
                    }}
                    className="accent-brand mt-[3px]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-ink-200 font-mono text-[12px]">/{skill.id}</span>
                    {skill.alreadyHere ? (
                      <span className="text-ink-700 ml-2 text-[11px]">already installed</span>
                    ) : null}
                    <div className="text-ink-600 line-clamp-2 text-[11.5px]">{skill.description}</div>
                  </span>
                </label>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}
