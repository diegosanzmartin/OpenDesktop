import { useEffect, useState, type ReactNode } from 'react'
import { Download, FolderOpen, Trash2 } from 'lucide-react'
import type { Skill } from '@shared/types'
import { useStore } from '../state/store'
import { Button, Label, Panel } from './ui'

function extraFiles(count: number): string {
  return count === 1 ? '1 extra file' : `${count} extra files`
}

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
            <div className="divide-ink-800 divide-y">
              {skills.map((skill) => (
                <div key={skill.id} className="group flex items-start gap-3 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-brand font-mono text-[12.5px]">/{skill.id}</span>
                      {skill.files.length > 0 ? (
                        <span className="border-ink-800 text-ink-600 rounded-full border px-1.5 text-[10.5px]">
                          {extraFiles(skill.files.length)}
                        </span>
                      ) : null}
                    </div>
                    {skill.description ? (
                      // Two lines is enough to recognise a skill; the full text
                      // is in its own file and would swamp the list.
                      <p className="text-ink-500 mt-0.5 line-clamp-2 max-w-[70ch] text-[12px] leading-[1.5]">
                        {skill.description}
                      </p>
                    ) : (
                      <p className="text-ink-700 mt-0.5 text-[12px] italic">No description.</p>
                    )}
                  </div>
                  <button
                    type="button"
                    title="Remove"
                    onClick={async () => {
                      await window.opendesktop.skills.remove(skill.id)
                      await reload()
                    }}
                    className="text-ink-700 hover:text-bad mt-0.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
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
            <div className="divide-ink-800 divide-y">
              {importable.map((skill) => (
                <label
                  key={skill.id}
                  className="flex cursor-pointer items-start gap-3 py-2 first:pt-0 last:pb-0"
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
                    className="accent-brand mt-1 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-ink-200 font-mono text-[12.5px]">/{skill.id}</span>
                      {skill.alreadyHere ? (
                        <span className="border-ink-800 text-ink-600 rounded-full border px-1.5 text-[10.5px]">
                          installed
                        </span>
                      ) : null}
                    </span>
                    <span className="text-ink-600 mt-0.5 line-clamp-2 max-w-[70ch] text-[12px] leading-[1.5]">
                      {skill.description}
                    </span>
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
