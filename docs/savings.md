# Savings

Two things a session can do to keep its context and its bill down, and one rule
for deciding which model does what.

They were three modes — `direct`, `rtk`, `shunt` — and that was wrong. One
filters the output of shell commands; the other moves file reading onto a
different model. Nothing about either makes the other less useful, so a picker
that forced a choice between them was inventing a conflict. They are switches,
and they compose.

Everything off is the app as it has always worked. There is no name for that
state beyond "nothing on": the composer's chip reads `Direct`, which is a
label, not a fourth thing to select.

The defaults are in Settings → Models → Savings; a session may turn either one
on or off for itself from the chip beside the environment. A key a session has
not set follows the app, which is not the same as `false` — that is the session
saying no. A subagent inherits whatever its parent had.

What changes, in each case, is the size of what comes back from a tool, and
therefore what the next turn has to resend — which is what
`docs/context-management.md` is about from the other end. That document is
about a transcript that has already grown; this one is about not growing it.

## rtk

[rtk-ai/rtk](https://github.com/rtk-ai/rtk) is a single Rust binary that
filters the output of about a hundred development commands before an agent
reads it: a tree with counts instead of one line per file, the failures instead
of a whole test run, `ok abc1234` instead of git's progress report. Its README
puts the reduction at up to 90% of bash output.

It is used as itself, not reimplemented. The rewrite rules live in rtk's own
registry and it exposes them as `rtk rewrite <command>`, which is what its
editor plugins call; we call the same thing, so there is no table of commands
to copy here and nothing to keep in step as rtk grows. Its documented exit
codes are the protocol:

| exit | meaning | what happens |
|------|---------|--------------|
| 0 | a rewrite, and rtk's own rules are happy with it | the rewrite runs |
| 1 | rtk has no equivalent | the original runs |
| 2 | rtk's own deny rules matched | the original runs; our denylist has already had its say |
| 3 | a rewrite, but rtk wants a person asked | the rewrite runs, and the prompt is never skipped |

**Permission is not taken from rtk.** The allowlist is a statement about the
command the model asked for, and that command is what the approval card shows,
so that is what the decision is made about. The rewrite happens afterwards and
has to fit through one gate (`acceptRewrite`, `src/main/rtk.ts`): each segment
either comes back untouched or comes back as the same environment prefix
followed by an `rtk` invocation. `LANG=C ls -la` may become
`LANG=C rtk ls -la`; nothing may add a second command, a redirect, a
substitution or a different environment. A rewrite that does not fit is dropped
and the original runs.

The one thing either switch may do to the permission path is *add* a prompt.
rtk's exit 3 does exactly that, and it cannot remove one.

### What is routed, and what is not

Upstream, the hook only sees Bash calls, so an agent with first-class
read/grep/glob tools bypasses rtk entirely — rtk's own README says so. Here the
tools are ours, so `grep`, `glob` and `list` are routed too, through
`rtk grep`, `rtk find` and `rtk ls`.

`read` is never routed, at any level. `edit` matches an exact string against
what `read` returned, and a summary of a file is not the file. A search is a
listing and can be summarised; a file's contents cannot. (`grep` with a glob
filter is also left alone: `rtk grep` takes no include filter, and quietly
searching more than was asked for is worse than not saving the tokens.)

The agent is told, in its system prompt, that shell output is filtered and that
file contents are not — otherwise the first thing it does about a suspiciously
short answer is run the command again with more flags, which costs exactly what
the mode exists to save. That note is added only when rtk is actually in force — and when both switches
are on the agent gets both notes, in separate sections, because both are true.

### When it is not there

rtk is an external binary and it may not be installed, may be too old
(`rtk rewrite` arrived in 0.23.0), or may be missing on a remote target while
present locally. The probe is one `rtk --version` per environment, cached.

A session with the switch on, on a target without rtk, says so once in the
chat and then behaves exactly as if it were off. The composer says it too, beside the
picker. The alternative — a chip saying `rtk` over a session running unfiltered —
would have the user reading one setting's label and another's token counts.

Install it with `brew install rtk`. OpenDesktop needs no `rtk init`: the hook
that command installs is for editors that have no other way in, and this app
calls `rtk rewrite` itself.

## shunt

[spotify/portal-ai-plugins/plugins/shunt](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt)
is not about compression but displacement. A file the agent reads costs its
whole length in the conversation now, and again on every turn afterwards. So
the reading is given to a second, cheaper model: it gets the files and the
question, and what comes back is the answer. The corpus never enters the
conversation at all. Upstream measures 82–94% on large reads.

Three tools appear with this switch on, and only with it on:

- **`bulk_read(question, paths)`** — the files go to the worker, its answer
  comes back. Every call stands alone, so asking again with the same paths
  costs the conversation nothing; the agent is told to ask one thing at a time
  rather than one question about everything.
- **`code_write(spec, reference, target?)`** — generates a file from a spec and
  a reference, without the generated code passing through the conversation. A
  reference is required: upstream's reasoning, that without a file to match
  against the worker writes context-free code that fits nothing in the project.
- **`plan(task, context)`** — not upstream's; the other half of the same idea.
  If the cheap model does the reading, the expensive one should do the thinking,
  and only the thinking: a page of question and a page of answer, which is
  affordable on a model nobody would run a whole session on. It is not offered
  at all when the session is already on the most capable model declared — asking
  itself for a plan is a round trip that returns its own judgement.

And two gates, both of them upstream's, with upstream's exemptions:

- `read` refuses a whole file over `shuntMinLines` (350 by default) and points
  at `bulk_read`. A read with an **offset or a limit is always allowed** — that
  is the agent saying it already knows what it needs, and it is the only thing
  to trust for exact text.
- `bash` refuses `cat`/`head`/`tail`/`less`/`more` on such a file too, since
  that is the same read by another route. A pipe or a redirect goes through: the
  output is not coming into the conversation.

### What is adapted

Upstream reaches its worker through Portal's `aika:invoke-chat`, one shell
invocation per delegation, and pays for that twice: the input travels through
argv, so it has a payload ceiling and refuses anything over it, and the action
is ephemeral, so following up means replaying the corpus — which is the cost it
exists to avoid, so it does not follow up. Here the worker is just another
entry in `provider`, called the way the summariser is, so neither limit
applies. There is still a cap (400,000 characters, upstream's number) but for a
different reason: it is a guess at what fits in a cheap model's window without
being truncated at the far end where nobody would see it.

Upstream enforces its gate with hooks that block the assistant's `read` tool. Here
`read` is our own tool, so the gate lives in the tool.

One bug is not carried over. Upstream's `check-bash-read` word-splits the
command, so `cat "my file.md"` gives it the path `my`, which is not a file,
which means no refusal and the whole file read after all — a hole in its own
gate. Quoted arguments are read as one word here.

### What it costs, and where that shows

The worker's tokens are real tokens. They are charged to the session as they
are spent, priced as the worker's own model, and named in the block: what the
delegation cost, and roughly how much file stayed out of the conversation. They
are deliberately **not** added to the context gauge — the gauge is about what
the next turn will resend, and the whole point is that the files will not be.

`shuntModel` picks the worker, then `smallModel`, then the router below. When
all of that lands on the session's own model it still works and still displaces
the corpus, which is most of the saving, but the reading is charged at full
price — so the composer says "no cheaper model" and the session says it once in
the chat.

### What is not delegated

Upstream's list, and it is a good one: debugging, editing, small files, and
architectural decisions. The first three follow from the gates (a targeted read
is always allowed, and a small file is never refused); the last is a matter of
the agent's judgement, and it is told so in the system prompt.


## Cost and capability

The router needs two numbers per model, and there is no way to obtain either
without being told: what the model costs relative to the others declared here,
and how capable it is. Both are five-step sliders in Settings → Models → Cost.

Five steps, because that is the resolution the judgement actually has. Nobody
can say one model is 0.72 as capable as another, and a 0–100 slider would
invite them to try.

Then one rule:

- **Reading, boilerplate and summarising** go to the cheapest model that clears
  a capability floor. The floor matters: a model too weak to read a file
  accurately saves nothing, it just moves the error somewhere harder to see.
- **Plans** go to the most capable model there is, and among equals the cheaper.

A choice made by hand always outranks one the router inferred, so `shuntModel`
and `plannerModel` win when they are set. What the router currently picks, and
why, is printed under the sliders — the settings are judgements about models,
and this is what they add up to.

### Billing

What a token costs is not always what it is priced at, so each model says how
it is paid for:

| Billing | What it means for routing |
|---------|---------------------------|
| **Pay as you go** | Charged per token. Its cost slider is its cost. |
| **Flat rate** | A subscription. The next token is free whatever the slider says, so work goes here first when the model is capable enough. |
| **Included allowance** | A quota that resets. Free until it runs out, its own price afterwards, and priced in between: past nine tenths of the allowance the next token is likely to be the one that is charged. |

That last row is the reason the cost slider is not simply derived from the
price. A subscription model looks expensive and is free at the margin, and no
amount of arithmetic over published prices can work that out.

### Counting an allowance

No provider reports a remaining balance back — the OpenAI-shaped endpoints have
nowhere to say it and the ones that do all say it differently. But every token
this app spends passes through one place, so an allowance is counted from what
*this app* has used, in `meter.json` beside the sessions, and the settings row
says "counted here" rather than implying it is a balance. It is a floor:
anything spent from another client or another machine is invisible to it.

The meter is also where the summariser started being charged. It had always
spent real tokens on a real model and been recorded as free.
