# Modes

A mode is how much of what a tool produces reaches the model.

Everything else stays the same: the same agent, the same tools, the same
environment, the same permission prompts. What changes is the size of what
comes back from a command, and therefore what the next turn has to resend —
which is the thing `docs/context-management.md` is about from the other end.
That document is about a transcript that has already grown; this one is about
not growing it in the first place.

It is a property of the session, picked in the composer next to the
environment, and the default for new sessions is in Settings → Models → Mode.
A subagent inherits the mode of the session that spawned it.

## direct

The app as it has always worked. Tool output reaches the model as it is,
truncated only at 30,000 characters, and nothing is filtered or delegated.

Everything else in this document is a trade against this one, so it stays the
default: a mode that loses something should be chosen, not inherited.

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

The one thing a mode may do to the permission path is *add* a prompt. rtk's
exit 3 does exactly that, and it cannot remove one.

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
the mode exists to save. That note is added only when rtk is actually in force.

### When it is not there

rtk is an external binary and it may not be installed, may be too old
(`rtk rewrite` arrived in 0.23.0), or may be missing on a remote target while
present locally. The probe is one `rtk --version` per environment, cached.

A session in rtk mode on a target without it says so once, in the chat, and
then behaves exactly like `direct`. The composer says it too, beside the
picker. The alternative — a session labelled `rtk` quietly running unfiltered —
would have the user reading one mode's label and another mode's token counts.

Install it with `brew install rtk`. OpenDesktop needs no `rtk init`: the hook
that command installs is for editors that have no other way in, and this app
calls `rtk rewrite` itself.

## shunt

[spotify/portal-ai-plugins/plugins/shunt](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt)
— not yet implemented. Notes on what it is, so the shape is on record:

it blocks the main model from reading large files and hands the reading to a
cheaper model instead, which answers a question about the files rather than
returning them. The corpus goes to the worker and never enters the main
conversation, which is where the 82–94% in its benchmarks comes from. A second
half does the same for boilerplate generation: a spec plus a reference file in,
a written file out.

The pieces it needs are already here — several providers, a `smallModel`, and
the delegation machinery that `task` uses — so it is portable. What has to be
decided is what the worker's answer costs, and where it shows up: the tokens
are real tokens, spent on a different model, and a session gauge that ignores
them would be lying by omission.
