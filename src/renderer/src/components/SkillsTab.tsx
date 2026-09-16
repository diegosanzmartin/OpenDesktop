import { useEffect, useState, type ReactNode } from 'react'
import { Download, FolderOpen, Trash2 } from 'lucide-react'
import type { Skill } from '@shared/types'
import { useStore } from '../state/store'
import { Hint, IconButton, Row, Section } from './settings-ui'

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
    <>
      <Section
        title="Skills"
        description={
          <>
            Type <span className="font-mono">/</span> in the composer to use one. They live in{' '}
            <span className="font-mono">{dir}</span>.
          </>
        }
        action={
          <>
            {status ? <Hint tone="ok">{status}</Hint> : null}
            <IconButton title="Reveal in Finder" onClick={() => void window.opendesktop.skills.reveal()}>
              <FolderOpen className="h-4 w-4" />
            </IconButton>
          </>
        }
      >
        {skills.length === 0 ? (
          <Row label={<Hint>None yet. Import the ones you already have below.</Hint>} />
        ) : (
          skills.map((skill) => (
            <Row
              key={skill.id}
              label={
                <span className="flex items-center gap-2">
                  <span className="text-brand font-mono text-[12.5px]">/{skill.id}</span>
                  {skill.files.length > 0 ? (
                    <span className="border-ink-800 text-ink-600 rounded-full border px-1.5 text-[10.5px]">
                      {extraFiles(skill.files.length)}
                    </span>
                  ) : null}
                </span>
              }
              description={
                // Two lines is enough to recognise a skill; the whole text is
                // in its own file and would swamp the list.
                skill.description ? (
                  <span className="line-clamp-2">{skill.description}</span>
                ) : (
                  <span className="italic">No description.</span>
                )
              }
            >
              <IconButton
                title={`Remove /${skill.id}`}
                tone="danger"
                onClick={async () => {
                  await window.opendesktop.skills.remove(skill.id)
                  await reload()
                }}
              >
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </Row>
          ))
        )}
      </Section>

      <Section
        title="Import"
        description="From ~/.claude/skills — a skill is a folder with a SKILL.md inside, the same layout both tools use."
        action={
          <IconButton
            title={picked.size > 0 ? `Import ${picked.size}` : 'Select some to import'}
            tone="accent"
            disabled={picked.size === 0}
            onClick={async () => {
              const count = await window.opendesktop.skills.importFrom([...picked])
              setPicked(new Set())
              await reload()
              setStatus(`Imported ${count} skill${count === 1 ? '' : 's'}.`)
            }}
          >
            <Download className="h-4 w-4" />
          </IconButton>
        }
      >
        {importable.length === 0 ? (
          <Row label={<Hint>Nothing found there.</Hint>} />
        ) : (
          importable.map((skill) => (
            <Row
              key={skill.id}
              label={
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={picked.has(skill.id)}
                    onChange={(event) => {
                      const next = new Set(picked)
                      if (event.target.checked) next.add(skill.id)
                      else next.delete(skill.id)
                      setPicked(next)
                    }}
                    className="accent-brand shrink-0"
                  />
                  <span className="text-ink-200 font-mono text-[12.5px]">/{skill.id}</span>
                  {skill.alreadyHere ? (
                    <span className="border-ink-800 text-ink-600 rounded-full border px-1.5 text-[10.5px]">
                      installed
                    </span>
                  ) : null}
                </span>
              }
              description={<span className="line-clamp-2">{skill.description}</span>}
            />
          ))
        )}
      </Section>
    </>
  )
}
