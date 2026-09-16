# Context management and compaction

Working reference for anyone — person or agent — touching how much of a session
goes back to the model. Read it before editing `src/main/history.ts`,
`compactIfNeeded` in `src/main/agent/runner.ts`, or the tool-output limits in
`src/main/agent/tools.ts`.

It is a living file. New sources get appended to **Sources** at the bottom with
their takeaway, and anything that changes the design gets folded into the
sections above.

---

## 1. The problem, stated once

A 200k or 400k window is not a budget you can spend freely, for three separate
reasons:

- **Money.** Every step of a turn resends the whole conversation. `runner.ts`
  sums `inputTokens` across steps precisely because that, not the last call, is
  what the turn costs (`src/main/agent/runner.ts:404-441`). A transcript that
  doubles doubles the price of every remaining step in the session.
- **Latency.** Time to first token grows with the prefix, and an agent client is
  judged on how fast the first word appears.
- **Context rot.** Accuracy degrades well before the window is full. Filling
  190k of 200k is not "using the model fully", it is handing it a haystack.

So the goal is not *fit inside the window*. It is **keep the smallest context
that still lets the next turn do the work** — and, because this is a client
people work in for hours, never lose something the session decided without
saying so.

## 2. Vocabulary: three families of compaction

From source [1]. Worth keeping the names straight, because they solve different
problems and we currently implement one of the three.

**Semantic compression.** An LLM rewrites a span of context into a shorter form
that preserves *intent*, not characters. Lossy on purpose: you do not need to
reconstruct the original, you need to keep working. Papers: [2], [3].

**Loss-aware pruning.** Given a token budget, drop the spans that contribute
least to the model's ability to do the task, keep the rest verbatim. Research
forms score tokens by perplexity (LLMLingua [5]) or train a small pruner to
remove irrelevant sentences (Provence [6]). The practical form for an agent
client is coarser and needs no model at all: *tool output that no longer matters
stops being resent.*

**Dynamic summarization.** Carry the last N turns in full plus a compact summary
of everything older, and rewrite that summary as the session evolves. "Dynamic"
means two specific things:

1. **State-triggered** — fires at a fraction of the token budget, not on a timer
   and not once per turn.
2. **Incremental** — `existing summary + new chunk → new summary`. You never
   re-summarise the whole session from scratch: it is expensive and it drifts,
   losing the oldest decisions first. Papers: [4], [7].

## 3. What the client does today

Facts, so nobody rediscovers them:

- The **model-facing transcript is separate from the UI transcript**
  (`src/main/history.ts:6-11`). The UI keeps blocks, collapsed output and
  everything a person may want to reopen; the history file is exactly what goes
  back to the model. Only the second one is compacted.
- Compaction runs **after the answer is delivered**, at the end of the turn
  (`runner.ts:461-463`), so the user waits for their reply, not for the summary.
- The **trigger is the model's own window**: the tokens the provider charged for
  the prefix on the last step, against `contextWindow` less a reserve for the
  reply and the system prompt, firing at `compactAtFraction` (default 0.7).
  Characters are only the fallback when a model declares no window, and that
  fallback counts text and ignores image bytes — see `shouldCompact` and
  `estimateTokens` in `history.ts`.
- The summariser is a separate, cheaper call that prefers `config.smallModel`
  (`runner.ts:215-245`) — this is a summary, not the work.
- The summary re-enters the transcript as a `user` message tagged
  `<earlier-in-this-session count="N">`, told to be treated as established
  fact, with an explicit instruction to re-read files rather than guess at a
  detail it does not contain.
- It is **incremental**: a note from an earlier round is pulled out of the chunk
  and handed to the summariser separately and whole, with a merge instruction.
  One note is carried, and `count` accumulates.
- The cut **never lands inside a tool call and its result**: `safeBoundary`
  snaps backwards past any outstanding call.
- It is **said out loud**: a `system` message is added to the chat and rendered
  as an expandable notice, so the summary can be read
  (`runner.ts:249-261`, `ChatView.tsx` `Notice`).
- **Failure is non-destructive**: a summariser that throws, or returns nothing,
  leaves the transcript untouched and lets the next turn try again
  (`history.ts:93-101`). Covered in `src/main/smoke.ts` ("compacting a long
  session").
- Tool output is truncated head-and-tail at 30k characters *at the moment it is
  produced* (`tools.ts:40-46`), and then **stops being resent** once it is more
  than `dehydrateAfterTurns` turns old: `dehydrate` in `history.ts` replaces the
  body with a note naming the call, so the agent can run it again. Image and
  file bytes from old turns go the same way. No model call.
- The two passes run **cheapest first**: `tighten` in `runner.ts` prunes, then
  subtracts what it freed from the measured token count, and only then asks
  whether a summary is needed.
- Subagents are the strongest form of context isolation we have: `task` spawns a
  child session with its own history and only the report comes back
  (`runner.ts:333-351`).

In the taxonomy of §2 that is all three families, in the shape each one takes
for an agent client: **semantic compression** is what the summariser does,
**dynamic summarization** is the trigger and the running merge, and
**loss-aware pruning** is the coarse structural form — old tool output and old
image bytes stop being resent, no scoring model required.

## 4. Invariants

These are decisions already paid for. Do not regress them while applying
anything below.

1. **Never forget silently.** Every compaction leaves a notice in the chat that
   a person can expand and read. A session that quietly drops what it decided an
   hour ago is worse than one that admits it.
2. **A failed summariser changes nothing.** No partial splice, no half-summary.
3. **The summary tells the model where to look**, not just what was concluded:
   paths and commands, so a missing detail is re-read rather than invented.
4. **Compact after the answer, never before it.** The cost is paid out of sight.
5. **The model transcript and the UI transcript stay separate.** Compaction
   shrinks what the model is sent; it never deletes what the user can scroll to.
6. **Never cut between a tool call and its result.** Use `safeBoundary`; do not
   slice the history by index directly (see 5.C).
7. **The carried summary is never truncated.** It is the only record of the
   oldest decisions in the session; everything else in the summariser's prompt
   is expendable before it is (see 5.B).
8. **Budget in tokens, not characters, and never count image bytes as
   context.** (see 5.A)
9. **Prune before summarising.** The free pass runs first and its saving is
   subtracted from the measured count, so a session never pays for a summary it
   no longer needs (see 5.D).
10. **Dropping is recoverable; forgetting is not.** Anything removed from the
    model's copy must say what it was and how to get it back. That is what
    makes it a drop rather than a loss, and why it needs no notice in the chat.

## 5. Where the ideas apply, in priority order

Each item: what is wrong, which idea from §2 it is, what to change, how to know
it works. `src/main/smoke.ts` is the headless harness — `compactHistory` takes
its summariser as a parameter specifically so the whole path can be driven from
there without a provider.

### A. Budget in tokens, against the model's own window — **done**

*Family 3, the "state-triggered" half.*

`600_000` characters is a proxy for a proxy. Two concrete failures:

- `ModelConfig.contextWindow` already exists (`src/shared/types.ts:72`) and is
  editable per model in the Models tab — and nothing in the compaction path
  reads it. A 32k local model and a 400k hosted one currently share one
  threshold, so one compacts far too late and the other far too early.
- `JSON.stringify` measures the wrong thing. Keys, escaping and structure
  inflate it, and an attached image is a `Buffer`
  (`attachments.ts:125`, inlined at `runner.ts:164-168`), which stringifies to
  `{"type":"Buffer","data":[137,80,...]}`. Measured: **2.1M characters per
  megabyte**, about two per byte rather than six. Either way one 1 MB
  screenshot read as three and a half times the whole 600k budget while costing
  the model about a thousand tokens — it tripped compaction on its own, and
  compaction could not help, because the bytes sit in the recent messages it
  keeps.

Change: drive the trigger off **measured tokens**. The real number is already
being collected — `usage.inputTokens` per step in `runner.ts:427-441` is what
the provider actually charged for the assembled prefix. Compare the last turn's
input against `contextWindow` minus a reserve for the system prompt, the tool
definitions and `maxOutputTokens`, and fire at a configurable fraction (0.7 is
the figure the sources converge on). Keep `chars / 4` only as the fallback when
`contextWindow` is not declared, and exclude image bytes from that count.

Done. `shouldCompact` takes `{ measuredTokens, budgetTokens, fraction,
maxChars }` and prefers the measured count; `budgetFor` in `runner.ts` derives
the budget from `contextWindow` less `maxOutputTokens` and a 4k allowance for
the system prompt and tool schemas. The measured number is the **last step's**
`inputTokens`, not the sum across steps — the sum is what the turn cost, which
is a different question from how full the window is. `estimateTokens` is the
fallback and counts image parts as nothing. Covered in smoke: "measuring how
full the window is".

### B. Make the summary incremental, not re-summarised — **done**

*Family 3, the "incremental" half.*

Today the second compaction feeds the first summary back through the summariser
as just another message — and `runner.ts:240` cuts every message at 4000
characters before sending it. So the carried summary, the one artefact holding
the oldest decisions in the session, is the item most likely to be truncated.
Repeat that over a long session and the beginning dissolves. That is exactly the
drift [4] and [7] are about.

Change: detect the `<earlier-in-this-session>` note, pass it to the summariser
**separately and never truncated**, and prompt for a merge — `old summary + new
messages → new summary` — with an explicit instruction that facts in the old
summary survive unless the new messages contradict them. Keep the tag so the
next round can find it again.

Done. The summariser now receives `{ previous, messages }`; the previous
summary goes into the prompt whole, inside `<existing-summary>`, and only the
new messages are truncated at 4000 characters. The system prompt gains a merge
instruction stating that a fact in the existing summary survives unless the new
messages contradict it, because it covers work the model can no longer see.
Covered in smoke: two rounds, asserting a fact from the first window survives
the second and that only one note is ever carried.

### C. Do not split a tool call from its result — **done**

*Correctness, not compaction. Was first.*

`history.slice(history.length - keepRecent)` cuts at an arbitrary index, and the
note that replaces the older half has `role: 'user'`. If the cut lands between
an assistant message carrying tool calls and the `tool` message carrying their
results, the transcript that goes back is a tool result with no matching call —
which Anthropic-style APIs reject outright, and which other providers interpret
as they please. A tool-heavy turn is several messages long, so the odds of an
unlucky boundary are not small.

Done. `safeBoundary(history, from)` walks backwards while the message at the
cut is a `tool` message or the one before it has outstanding tool calls.
Backwards and never forwards: keeping an extra message costs a little context,
dropping half a pair costs the whole turn.

Measured before fixing, on a six-message transcript with two tool pairs: of the
five possible `keepRecent` boundaries, **two started with an orphaned `tool`
message**. Smoke asserts both that the naive cut orphans a result and that
every snapped boundary does not.

### D. Stop resending tool output that stopped mattering — **done**

*Family 2, in the form a client can actually implement.*

This is where the transcript's weight comes from. A 30k-character `grep`, a full
file read, a build log — each is truncated once when produced and then resent
verbatim on every step of every subsequent turn, long after the agent has moved
on. Compaction only reaches it once the whole session is over budget.

Change: **dehydrate old tool results** in the model transcript. Once a tool
result is more than N turns old — or the file it read has since been read again
— replace its body with the call, a one-line outcome, and how to get it back
(the path, the command, the line range). No model call, no summariser cost, and
the information is recoverable by the agent on demand, which is exactly the
bargain the `<earlier-in-this-session>` note already strikes.

Done, and it is the largest single saving in the file. Measured on a synthetic
twelve-turn session of 30k-character searches: **90,786 estimated tokens →
16,121, 82% smaller**, and a session that was over a 100k budget is inside it
afterwards with no model call made. Smoke asserts exactly that pair, which is
the interaction with A — the saving is only visible because the budget is
counted in tokens.

`dehydrate(history, { afterTurns, overChars, images })` is pure and idempotent:
the replacement carries a `[dropped to save context]` sentinel so a second pass
skips it. Recent turns are kept whole, outputs under `overChars` are left alone
because the saving would not pay for the loss, and a session with fewer than
`afterTurns` turns is untouched.

Images were folded in here rather than left as separate work, since it is the
same idea and the same pass: an attached screenshot is the largest single item
in a transcript and was being resent on every step for the rest of the session.

**No notice in the chat for this one**, unlike compaction. Invariant 1 is about
forgetting, and this does not forget: the UI keeps the full output, the model is
told which call produced what is missing, and it can run it again. A line in the
chat every time a grep from three turns ago is dropped would be noise. What it
*is* lossy about — a build log that will not reproduce — is why recent turns are
kept verbatim.

Per invariant 5, the UI keeps the full output. It is the model's copy that
shrinks.

### E. Show the budget, and say what compaction costs — **done**

`StatusLine` (`ChatView.tsx`) already renders tokens, cost and rate per turn.
Once A exists there is a real percentage to show — context used against the
model's window — and it belongs somewhere always visible for the session, not
only per message. People who can see 70% approaching understand why a summary
happened; people who cannot experience it as the app losing their work.

Done. `ContextGauge` sits in the window bar beside the folder and the session
cost, because it is a property of the conversation rather than of a turn: a
10-wide bar and a percentage, neutral below the threshold, brand-coloured as it
approaches, amber past it. `budgetFor` and `contextShare` moved to
`@shared/context` so the runner's decision and the gauge's denominator cannot
drift apart — a gauge that disagrees with the behaviour it describes is worse
than none.

Nothing is shown when the model declares no `contextWindow`, and nothing before
a turn has been measured. An invented percentage would be worse than an absent
one, and both cases are asserted in `ui-check`.

`Session.contextTokens` carries the number: the provider's measured count for
the prefix while nothing has been removed, and `estimateTokens` over the new
shape when the transcript has just been tightened — otherwise the gauge would
sit at the pre-compaction figure until the turn after next.

Worth stating in the same breath: **compaction is not free and not only a
saving.** Rewriting the front of the transcript invalidates the provider's
prompt-cache prefix, so the turn after a compaction is billed at full input
price. Placing the summary first and keeping it stable afterwards is what lets
the cache re-form, which is a reason not to rewrite it more often than needed.

That is already the shape of the code, and it should stay that way: the note is
the first message, it is only rewritten when there is something new to fold in
(`chunk.length === 0` returns `null`), and the free pass in §5.D runs first
precisely so a session does not buy a rewrite it did not need. **Do not** add a
periodic or per-turn compaction; the trigger is a threshold for a reason.

### F. Make it configurable and manual — **done**

Thresholds (`fraction`, `keepRecent`, dehydration age) belong in `AppConfig`
next to `maxSteps` and `smallModel`, not as literals in `history.ts`. And a
manual "compact now" — the user knows when a thread of work is finished and the
last hour is dead weight, and they know it before any threshold does.

Done. `compactAtFraction`, `keepRecentMessages`, `dehydrateAfterTurns` and
`dehydrateOverChars` are in `AppConfig`, and the first three are rows in a
**Context** section on the Models page — beside the windows and prices they are
measured against. The fraction is edited as a percentage, since that is how it
is read on the gauge.

"Compact context now" is in the conversation's ⋮ menu and goes through
`compactHistory` with `force: true`, which skips the budget check and nothing
else: the same safe boundary, the same merge, the same notice in the chat. Smoke
asserts a session small enough to be left alone is summarised anyway when
asked.

### G. Keep using subagents as compaction

`task` already gives a piece of work its own window and returns only a report
(`runner.ts:333-351`). That is the cheapest context management in the app, and
the manager prompt's bias toward doing small work itself is the right trade —
delegation costs a round trip. Do not "optimise" the child's history back into
the parent's.

### H. Housekeeping — **done**

The comment above `historySize` described the old dropping behaviour. It now
says what the function does: measures, changes nothing.

Image `Buffer`s persisted into the history file and resent every turn — done as
part of D, which drops them from turns older than `dehydrateAfterTurns`. A
screenshot still costs ~2 MB of JSON on disk for the two turns it survives;
shrinking that further would mean keeping attachments out of the history file
and re-reading them from disk when a turn needs them, which is a larger change
and not yet worth it.

## 6. What not to build

Deliberate exclusions, so they do not get proposed again:

- **Token-level prompt compression (LLMLingua-style).** Needs per-token
  logprobs from a model we control. This client talks to arbitrary
  OpenAI-compatible endpoints that do not expose them, and token-level dropping
  mangles the one thing an agent must keep exact: paths, identifiers, commands.
- **Embedding/RAG retrieval over the transcript.** A vector index of the
  conversation to fetch "relevant" turns adds an index, a model dependency and a
  new failure mode, to solve a problem a summary plus the filesystem already
  solves. The files *are* the retrieval layer: the agent can re-read them.
- **A trained pruner (Provence-style).** Right idea, wrong shape for a desktop
  client with no training pipeline.

The honest summary: for an agent client, **semantic compression of the old half,
plus cheap structural pruning of tool output, plus a token budget that knows the
model** covers nearly all of the available win.

## Sources

1. **Isaac Kargar — "The Fundamentals of Context Management and Compaction in
   LLMs"** (Feb 2026) — <https://nazmi.tech/blog/context-compaction-llm-agents-fundamentals>.
   The taxonomy in §2 comes from here: semantic compression, loss-aware pruning,
   dynamic summarization. Two points worth keeping: context rot and cost make
   compaction worth doing *even when the context still fits*; and "dynamic"
   means state-triggered (≈70% of budget) **and** incremental, which is the part
   we are missing.
2. Semantic compression — <https://arxiv.org/pdf/2304.12512>. An LLM can
   compress and later "decompress" text well enough to keep answering: preserve
   meaning, not characters.
3. Semantic compression for code — <https://aclanthology.org/2024.findings-acl.306.pdf>.
4. **Recursively Summarizing Enables Long-Term Dialogue Memory** —
   <https://arxiv.org/pdf/2308.15022>. The running-summary loop: `old summary +
   new chunk → new summary`. Direct basis for 5.B.
5. LLMLingua — <https://llmlingua.com/llmlingua.html>. Perplexity-guided token
   pruning with a budget controller. Noted and excluded in §6, but the budget
   controller idea — never over-compress past the point meaning breaks — is
   worth keeping in mind for the `keepRecent` floor.
6. Provence — <https://arxiv.org/pdf/2501.16214>. A trained sentence-level
   pruner for retrieved passages.
7. Loss-aware context pruning under a budget — <https://arxiv.org/pdf/2310.06201>.
   Large context reduction for small quality loss on summarization, QA and long
   conversations.
8. DTCRS — <https://aclanthology.org/2025.acl-long.536.pdf>. Build the summary
   tree only when the question needs it. The transferable lesson: decide whether
   to summarise at all before deciding how.
