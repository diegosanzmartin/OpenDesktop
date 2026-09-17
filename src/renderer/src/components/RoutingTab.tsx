import { useMemo, type ReactNode } from 'react'
import type { ReactElement } from 'react'
import { SWITCHES, savingsOf, type Savings } from '@shared/savings'
import {
  allowanceFor,
  allowanceUsed,
  capability,
  costTier,
  marginalCost,
  pickModel
} from '@shared/routing'
import { Hint, Row, RowInput, RowSelect, Section, Toggle } from './settings-ui'
import { declaredModels, useConfigDraft, useSpend } from '../lib/settings'

/**
 * What the app does with the models it has, as opposed to which models it has.
 *
 * Split from the providers page because the two questions are not the same
 * question and were not the same shape: one is "here is my Anthropic key and
 * what it can reach", the other is "which of them takes a plan, how much may
 * one turn spend, when is the transcript summarised". Sharing a page meant
 * switching provider at the top and finding its key three sections below, with
 * every model from every provider in a fourth.
 *
 * Nothing here edits a model. What it shows about them is the consequence of
 * what the providers page says — the tier the router actually uses, which is
 * not the same as the price once a subscription or an allowance is in play.
 */
export function RoutingTab(): ReactNode {
  const { draft, setDraft, saved, error } = useConfigDraft()
  const { spentFor } = useSpend(draft)

  const models = useMemo(() => declaredModels(draft), [draft])
  const delegate = useMemo(
    () => (draft ? pickModel(draft, 'delegate', { spent: spentFor }) : null),
    [draft, spentFor]
  )
  const planner = useMemo(
    () => (draft ? pickModel(draft, 'plan', { spent: spentFor }) : null),
    [draft, spentFor]
  )

  if (!draft) return null
  const savings: Savings = savingsOf(draft)
  const options = models.map((model) => ({ value: model.ref, label: model.label }))

  return (
    <>
      <Section
        title="Routing"
        description="Which model gets which job, and what the app is allowed to spend getting it done."
        action={
          error ? <Hint tone="bad">{error}</Hint> : saved ? <Hint tone="ok">Saved</Hint> : null
        }
      >
        <Row
          label="Default model"
          description="Used by new sessions, and by agents with no model of their own."
        >
          <RowSelect
            value={draft.model}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            options={options.length ? options : [{ value: draft.model, label: draft.model }]}
          />
        </Row>

        <Row
          label="Tasks at once"
          description="How many board tasks the scheduler runs in parallel. A task waiting on your approval does not count against this."
        >
          <RowInput
            mono
            width="w-[72px]"
            value={String(draft.maxConcurrentTasks ?? 2)}
            onChange={(value) => {
              const parsed = Number(value.replace(/\D/g, ''))
              setDraft({ ...draft, maxConcurrentTasks: Math.min(12, Math.max(1, parsed || 1)) })
            }}
          />
        </Row>

        <Row
          label="Subagents at once"
          description="How many subagents one agent may have working at the same time. Extra task calls wait for a slot rather than opening a stream the provider will throttle."
        >
          <RowInput
            mono
            width="w-[72px]"
            value={String(draft.maxParallelSubagents ?? 4)}
            onChange={(value) => {
              const parsed = Number(value.replace(/\D/g, ''))
              setDraft({ ...draft, maxParallelSubagents: Math.min(12, Math.max(1, parsed || 1)) })
            }}
          />
        </Row>

        <Row
          label="A turn may spend"
          description="Tokens across all of a turn's steps, and minutes on the clock, before it is stopped and handed back. Generous on purpose: these end a runaway, they do not ration ordinary work."
        >
          <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5">
            <RowInput
              mono
              width="w-[96px]"
              value={String(draft.maxTurnTokens ?? 750_000)}
              onChange={(value) => {
                const parsed = Number(value.replace(/\D/g, ''))
                setDraft({ ...draft, maxTurnTokens: Math.max(10_000, parsed || 10_000) })
              }}
            />
            <Hint>tokens ·</Hint>
            <RowInput
              mono
              width="w-[64px]"
              value={String(Math.round((draft.maxTurnMs ?? 1_800_000) / 60_000))}
              onChange={(value) => {
                const parsed = Number(value.replace(/\D/g, ''))
                setDraft({ ...draft, maxTurnMs: Math.max(1, parsed || 1) * 60_000 })
              }}
            />
            <Hint>minutes</Hint>
          </div>
        </Row>
      </Section>

      <Section
        title="As it stands"
        description="What the judgements on the providers page add up to. The tier is what the router weighs — a subscription or an allowance with room left is the cheapest thing there is, whatever the price says."
      >
        {models.length === 0 ? (
          <Row label={<Hint>No models declared yet.</Hint>} />
        ) : (
          models.map((entry) => {
            const model = draft.provider[entry.providerId]?.models[entry.modelId]
            if (!model) return null
            const limit = allowanceFor(draft, entry.providerId, model)
            const spent = spentFor(entry.ref)
            const used = allowanceUsed(limit, spent)
            const tier = marginalCost(model, spent, limit)
            const billing = model.billing ?? 'pay-as-you-go'
            return (
              <Row
                key={entry.ref}
                label={entry.label}
                description={<span className="font-mono text-[11px]">{entry.ref}</span>}
              >
                <div className="text-ink-400 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[11.5px]">
                  <span>
                    {billing === 'flat'
                      ? 'flat rate'
                      : billing === 'allowance'
                        ? used === null
                          ? 'allowance, no limit set'
                          : `allowance, ${Math.round(used * 100)}% used`
                        : 'pay as you go'}
                  </span>
                  <span className="font-mono">
                    cost {tier}/5{tier !== costTier(model) ? ` (list ${costTier(model)}/5)` : ''} ·
                    iq {capability(model)}/5
                  </span>
                </div>
              </Row>
            )
          })
        )}
        {delegate && planner ? (
          <Row label={<Hint>What that decides</Hint>}>
            <span className="text-ink-500 text-right text-[11.5px]">
              reading and boilerplate → <span className="font-mono">{delegate.ref}</span>,{' '}
              {delegate.why}
              <br />
              plans → <span className="font-mono">{planner.ref}</span>, {planner.why}
            </span>
          </Row>
        ) : null}
      </Section>

      <Section
        title="Savings"
        description="What a session does to keep its context and its bill down. Independent of each other, and either can be turned on or off for one session from the composer. Neither is the app as it has always worked."
      >
        {SWITCHES.map((entry) => (
          <Row key={entry.id} label={entry.label} description={entry.blurb}>
            <Toggle
              checked={savings[entry.id]}
              onChange={(next) =>
                setDraft({ ...draft, savings: { ...(draft.savings ?? {}), [entry.id]: next } })
              }
            />
          </Row>
        ))}
        <Row
          label="Delegate reading to"
          description="Left automatic, the cheapest model that clears the capability bar — which changes by itself when an allowance runs out."
        >
          <RowSelect
            value={draft.shuntModel ?? ''}
            onChange={(event) =>
              setDraft({ ...draft, shuntModel: event.target.value || undefined })
            }
            options={[
              { value: '', label: delegate ? `Automatic — ${delegate.label}` : 'Automatic' },
              ...options
            ]}
          />
        </Row>
        <Row
          label="Ask for a plan"
          description="Who is asked how to do something hard. Left automatic, the most capable model declared — and the tool is not offered at all when that is the session's own model."
        >
          <RowSelect
            value={draft.plannerModel ?? ''}
            onChange={(event) =>
              setDraft({ ...draft, plannerModel: event.target.value || undefined })
            }
            options={[
              { value: '', label: planner ? `Automatic — ${planner.label}` : 'Automatic' },
              ...options
            ]}
          />
        </Row>
        <Row
          label="Refuse whole-file reads over"
          description="While delegation is on. A read with an offset or a limit is always allowed — that is the agent saying it knows what it needs."
        >
          <RowInput
            mono
            width="w-[72px]"
            value={String(draft.shuntMinLines ?? 350)}
            onChange={(value) => {
              const parsed = Number(value.replace(/\D/g, ''))
              setDraft({ ...draft, shuntMinLines: Math.min(5000, Math.max(20, parsed || 350)) })
            }}
          />
          <Hint>lines</Hint>
        </Row>
      </Section>

      <Section
        title="Context"
        description="How much of a model's window a session may fill before its older half is summarised, and when tool output stops being resent."
      >
        <Row
          label="Summarise at"
          description="Share of the usable window — the model's context minus room for its reply — at which the older messages are replaced by a summary."
        >
          <RowInput
            mono
            width="w-[72px]"
            value={String(Math.round((draft.compactAtFraction ?? 0.7) * 100))}
            onChange={(value) => {
              const parsed = Number(value.replace(/\D/g, ''))
              setDraft({
                ...draft,
                compactAtFraction: Math.min(0.95, Math.max(0.2, (parsed || 70) / 100))
              })
            }}
          />
          <Hint>%</Hint>
        </Row>
        <Row
          label="Keep verbatim"
          description="Messages at the end of the transcript that a summary never touches."
        >
          <RowInput
            mono
            width="w-[72px]"
            value={String(draft.keepRecentMessages ?? 8)}
            onChange={(value) => {
              const parsed = Number(value.replace(/\D/g, ''))
              setDraft({ ...draft, keepRecentMessages: Math.min(40, Math.max(2, parsed || 8)) })
            }}
          />
        </Row>
        <Row
          label="Start dropping it at"
          description="Share of the usable window at which old tool output starts being dropped. Below it the transcript is left byte-for-byte alone, because a rewritten transcript is a prefix the provider cannot serve from its cache — and a cached prefix costs a tenth. Lower this if your provider's cache is unreliable and the transcript is what hurts."
        >
          <RowInput
            mono
            width="w-[72px]"
            value={String(Math.round((draft.dehydrateAtFraction ?? 0.5) * 100))}
            onChange={(value) => {
              const parsed = Number(value.replace(/\D/g, ''))
              setDraft({
                ...draft,
                dehydrateAtFraction: Math.min(0.95, Math.max(0, (parsed || 50) / 100))
              })
            }}
          />
          <Hint>%</Hint>
        </Row>
        <Row
          label="Drop tool output after"
          description="Once it is dropping, the turns it keeps whole. What goes is replaced by a note naming the call, so the agent can run it again."
        >
          <RowInput
            mono
            width="w-[72px]"
            value={String(draft.dehydrateAfterTurns ?? 2)}
            onChange={(value) => {
              const parsed = Number(value.replace(/\D/g, ''))
              setDraft({ ...draft, dehydrateAfterTurns: Math.min(20, Math.max(1, parsed || 2)) })
            }}
          />
          <Hint>turns</Hint>
        </Row>
      </Section>
    </>
  )
}
