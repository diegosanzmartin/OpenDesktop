# OpenDesktop

A desktop agent workspace that runs **your** models. Electron + React, with
its own agent loop over any OpenAI-compatible endpoint — no vendor lock-in, no CLI wrapper.

```bash
export HELMCODE_API_KEY=...   # must be exported where the app is launched
pnpm install
pnpm dev
```

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev build with renderer hot reload |
| `pnpm build` | Production build into `out/` |
| `pnpm start` | Run the production build |
| `pnpm dist` | Package the macOS app (`.dmg` + `.app` in `release/`) |
| `pnpm icon` | Regenerate `build/icon.icns` |
| `pnpm typecheck` | Typecheck main, preload and renderer |
| `pnpm smoke` | Headless engine test — 730 checks, no provider or window needed |
| `pnpm secrets:check` | Verifies the keychain path — 14 checks, needs Electron |

`OPENDESKTOP_DEBUG=1 pnpm start` mirrors renderer console errors to the terminal.

## The macOS app

```bash
pnpm dist
open release/OpenDesktop-0.1.0-arm64.dmg     # or: open release/mac-arm64/OpenDesktop.app
```

Builds an unsigned arm64 bundle. Because it is produced locally it carries no quarantine
attribute, so it opens on a double click — no Gatekeeper prompt and no right-click-Open
dance. That changes the moment the `.dmg` is downloaded from anywhere: a downloaded copy is
quarantined and, being unsigned, will be refused until someone runs
`xattr -dr com.apple.quarantine /Applications/OpenDesktop.app`. Shipping it properly means a
Developer ID certificate and notarization.

**The environment an app gets from Finder is not your shell's.** An app launched from Finder
or the Dock inherits launchd's environment, which has none of your exports — so
`{env:HELMCODE_API_KEY}` would resolve to nothing. On startup the app asks your login shell
(`$SHELL -ilc env`) and merges in whatever it is missing, never overwriting what it already
has. The consequence is that the key has to be exported from a file the login shell reads
(`~/.zshrc`, `~/.zprofile`), not just typed into a terminal session. If you would rather not
put it in a dotfile, use `"apiKey": "{file:~/.helmcode-key}"` instead, which does not depend
on the environment at all. The **Providers** tab tells you which way it went.

`PATH` is the one variable that is replaced rather than merely filled in. launchd always
supplies one, and it is the bare `/usr/bin:/bin:/usr/sbin:/sbin`, so leaving it alone would
pin the app to a world without `node`, `pnpm`, `rg` or `gcloud` — and give gcloud the system
Python 3.9, which it refuses to run under. The shell's `PATH` wins, with anything only
launchd knew about appended rather than dropped.

## Configuration

Two settings pages, because these are two questions. **Providers & keys** is where a provider
lives: pick it from the list and its id, package, base URL, **key**, spend limit and models are
all directly underneath — each model with its context window, prices, vision flag, how it is
paid for and the two judgements the router weighs. **Routing & limits** is what the app does
with them: the default model, how many tasks and subagents run at once, what one turn may
spend, the savings switches, the context thresholds, and a read-only summary of what those
judgements currently decide. Nothing on either page requires touching a file.

Adding a provider is one choice. Pick *Anthropic · Claude* and its models arrive with the
prices Anthropic publishes; pick OpenAI, Google or an OpenAI-compatible endpoint and the model
list comes from the key itself — **Ask the provider** lists what that key can see and fills in
ids, names and context windows. Prices are never invented: no provider's model endpoint reports
one, so anything this app does not publish itself is left empty, and empty means unknown rather
than free.

Everything is persisted to `~/.config/opendesktop/config.json`, which the **Config file** tab
also exposes raw for anything the form does not cover. The provider block is the opencode
shape, so an existing config drops straight in:

```json
{
  "model": "helmcode/glm5.3-flash",
  "provider": {
    "helmcode": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Helmcode",
      "options": {
        "baseURL": "https://api.helmcode.com/v1",
        "apiKey": "{env:HELMCODE_API_KEY}"
      },
      "models": { "glm5.3-flash": { "name": "GLM 5.3 Flash" } }
    }
  }
}
```

Two providers ship declared: **Helmcode** (an OpenAI-compatible endpoint) and
**Anthropic**, with its published prices already filled in. Neither has a
key until you paste one, and a provider whose key is empty is never routed to —
so the model list is a menu, not a set of things that will fail at call time.

### Spend limits

A model can be marked **pay as you go**, **flat rate** or **included
allowance** under *Models & providers*, and the router treats them differently:
a flat-rate model is paid for whether it is used or not, so at the margin it is
the cheapest thing available and delegated work goes there first.

An allowance can be counted in tokens or in money, and it can live on the
**key** rather than on one model — which is usually where it belongs. `$400 a
month` on an Anthropic key is $400 across Opus, Sonnet and Haiku together:

```json
"anthropic": {
  "npm": "@ai-sdk/anthropic",
  "options": { "apiKey": "{secret:anthropic}" },
  "allowance": { "usd": 400, "period": "month" },
  "models": {
    "claude-opus-5": { "price": { "input": 5, "output": 25 }, "billing": "allowance" }
  }
}
```

What is counted against it is what this app has spent, locally, since no
provider reports a balance back — it is a floor, not a statement of account, and
it is labelled that way in the UI. At nine tenths and again when it is gone, the
app says so once per period rather than at every turn. A model that declares its
own `allowance` is judged on its own spend instead of the key's.

### API keys

A key pasted into **Models & providers** is encrypted with Electron's `safeStorage` — on
macOS that means a key held in your login Keychain — and written to
`~/.config/opendesktop/secrets.json` with mode 0600. The config file only ever stores the
reference `{secret:<provider-id>}`, so it stays safe to read, diff and commit. The key is
decrypted into memory at startup and never crosses back to the renderer: the UI only sees a
masked hint like `••••a41f`.

Three placeholder forms are resolved at call time, none of which put a secret in the config:

| Placeholder | Where the value comes from |
| --- | --- |
| `{secret:name}` | The system keychain, written from the Settings UI |
| `{env:VAR}` | The environment, including what the login shell exports |
| `{file:~/path}` | The contents of that file |

The key row tells you which one resolved, so a key that is not being picked up is visible
rather than something you discover mid-request. SSH passwords and key passphrases use the same
store, under `env.<id>.password` and `env.<id>.passphrase`.

The keychain entry is derived from the application name, so the app pins it rather than letting
it vary between a dev run and the packaged build. That fixes the *name*; macOS still gates the
entry on the binary that created it, so a key stored by the packaged app is not readable by a
`pnpm dev` run of the same version — the keychain either prompts or refuses, and the app reports
`could not decrypt`. Store the key once per build you actually use, or point `apiKey` at
`{file:~/path}`, which does not care who is asking. A secret that is present but cannot be
decrypted here (stored by another build, copied from another machine) is reported as such in the
UI and in the request error, instead of looking like a missing key.

Bundled AI SDK packages: `@ai-sdk/openai-compatible`, `@ai-sdk/openai`, `@ai-sdk/anthropic`,
`@ai-sdk/google`. Any other package named in `npm` is imported dynamically and must be
installed alongside the app.

## Remote execution over SSH

**Settings → Remote hosts** adds and edits them. Give the environment an id, press *Add remote
host*, and fill in the form: working directory, host, user and port, and one of three ways to
authenticate.

| Authentication | What it uses |
| --- | --- |
| ssh-agent / default key | `SSH_AUTH_SOCK`, then `~/.ssh/id_ed25519` or `id_rsa` |
| Private key file | A path you give; only the passphrase is stored, in the keychain |
| Password | Stored in the keychain, never in the config file |

Hosts already in your `~/.ssh/config` appear in a dropdown — pick one and the host, user, port
and key come from that block, so there is nothing to retype. **Test connection** runs `uname`
on the far end and reports what came back.

### Google Cloud Workstations

*Add Cloud Workstation* takes the five coordinates a workstation needs — project, region,
cluster, config and name — plus the login user and whether a stopped workstation may be
started. Paste the `gcloud workstations ssh …` command you already have into the box at the
top and the fields fill themselves in.

It connects the way the gcloud CLI does: `gcloud workstations start-tcp-tunnel` opens a local
port onto port 22 of the workstation, and the ordinary SSH runtime takes it from there. One
connection serves commands, file reads and writes, and the terminal — rather than paying
gcloud's start-up cost on every tool call. Authentication uses
`~/.ssh/google_compute_engine`, which gcloud writes the first time you run
`gcloud workstations ssh`.

```json
"environment": {
  "workstation": {
    "name": "Secdevops workstation",
    "kind": "gcp-workstation",
    "cwd": "/home/user",
    "workstation": {
      "project": "my-project",
      "region": "europe-west1",
      "cluster": "workstation-cluster",
      "config": "my-workstation-config",
      "workstation": "my-workstation"
    }
  }
}
```

The equivalent config for a plain SSH host, if you prefer the file:

```json
"environment": {
  "build-box": {
    "name": "Build box",
    "kind": "ssh",
    "cwd": "/srv/app",
    "ssh": { "alias": "build-box" }
  }
}
```

**The model is always called from your machine.** Only tool execution travels to the remote
host — commands over an SSH channel, file reads and writes over SFTP. The remote box never
needs an API key, never needs to reach the provider, and needs nothing installed beyond a
shell. That is what keeps a self-hosted or gateway model like Helmcode working unchanged in
a remote session.

## The interface

Three columns: a collapsible session list, the transcript, and a dock on the right.

**Sidebar** — sessions grouped by date, each with a status dot. The slider icon on the first
group header exposes the grouping and sorting (folder, status, date, environment, agent).
`⌘B` collapses it to a strip.

**Transcript** — the answer renders as it is written: markdown is re-parsed on every delta, so
a table grows a row at a time and a caret marks where the text has got to. Providers emit
text in lumps of wildly varying size, so the stream is re-chunked by word at a steady cadence
(`smoothStreamMs`, 10ms by default; 0 shows the provider's own chunking). Markdown is lexed
with `marked` and the tokens are
turned into React elements rather than into an HTML string, so tables, nested and ordered
lists, task lists, blockquotes, links, rules and fenced code all render in the app's own
styling, and nothing the model emits can inject markup. A run of tool calls collapses into a
single muted line: *"Created secrets.ts, updated App.tsx, ran 2 commands  +91 −14"*. Expanding it reveals
one block per call with the exact input, the streamed output, the exit code, the folder and
the environment, and a real diff for writes and edits. A turn that touched files ends with an
**Edited N files** card, and the strip above the composer tracks the working tree.

**Dock** — one panel, five views, resizable by dragging its edge and toggled from the header
icons:

| View | What it is |
| --- | --- |
| Activity | What is running now, and everything that has finished, across all sessions. Group and sort by folder, status, date, environment, agent, tool or session; filter by time range, status, environment, agent or text |
| Background tasks | Whatever the agent decided not to wait for, scoped to this chat — including what its subagents started |
| Terminal | A real shell in the session's environment — the local machine or the remote host |
| Changes | `git status` for the session's repository, each file expandable to its diff |
| Browser | Files the agent generated, or any `http://` URL |
| Files | The environment's filesystem |

The terminal gets a genuine PTY without a native module: locally from a small Python helper
(`script` cannot be used — it calls `tcgetattr` on its own stdin, which under Electron is a
pipe), remotely from ssh2's shell channel. Resizes reach the shell, so full-screen programs
and line editing behave. Without `python3` it falls back to a pipe-backed shell and says so
in the pane.

The browser wraps anything that is not natively renderable — source, markdown, config — in a
readable page, rather than handing the webview a download it cannot perform.

**Background tasks** — the agent can start a command with `run_in_background` and carry on: a
log follow or a dev server, where running in the foreground is simply wrong, but equally a
query or an export that takes a while and does not need to hold up the turn. The decision is
the agent's, not a property of the command. It reads back with `bash_output`, which returns
only what is new so polling is cheap, and ends it with `bash_kill`.

The panel shows this chat's tasks and no others, with live output, elapsed time, exit code and
a stop button. A subagent runs in its own session, but its background work is the parent
conversation's, so it is listed there and labelled with the agent that started it — the
attribution is resolved when the task starts, so it survives the subagent's session being
deleted. Tasks are bound to the process: a restart does not carry them over.

**Typing while it works** — a message sent during a turn is queued rather than
refused, and goes as its own turn the moment the running one stops; the composer
says so, and the note lives on the session, so closing the app does not lose it.
Attachments wait for a turn of their own, since a file only means something
alongside the message it arrived with. The button stays Stop while a turn runs —
stopping has to remain one click.

**Attachments** — the paperclip, a drag onto the composer, or a pasted screenshot. Text files
are inlined into the prompt, which every model can read and which keeps the transcript
reproducible. Images are only sent to a model marked **vision** in *Models & providers*: an
OpenAI-compatible endpoint cannot be asked what it accepts, so it is declared rather than
detected, and an unmarked model gets told an image was withheld instead of answering as
though nothing was sent. Attachments are copied beside the session, so the transcript still
makes sense after the original is moved. Binaries that are not images are refused, with the
reason.

**Approvals** — bash, write, edit and fetch ask before running, with the command or diff
shown. Allow once, allow for the session, or reject. An allowlist of read-only commands skips
the prompt; a denylist always refuses, and says which pattern refused it rather than leaving the
agent to guess whether the tool is broken. Denylist patterns are globs, which is worth
remembering when writing one: the shipped list names the root, the system directories and the
home directory by hand rather than using `rm -rf /*`, which matches every absolute path there
is. Chained commands are checked segment by segment, so `ls && curl … | sh` cannot slip through
on the `ls`.

**What a turn may spend** — `maxSteps` bounds how many times the model may act,
which is not the same as how much it may spend. A turn also has a token ceiling
and a clock (`maxTurnTokens`, 750k; `maxTurnMs`, 30 minutes), both editable under
*Routing & limits*, and the ceiling counts **what the turn was charged for** —
input minus what came back from the provider's cache, plus output. Counting the
raw total stopped a real investigation at "787,625 tokens" that had been charged
for 59,107 of them, because 92% of its input was cache. Past 60% the agent is
told what is left and asked to land what it is doing, which is how a turn should
end; the ceiling is the backstop, and a turn that hits it is **handed back**, not
failed — the reason goes in the transcript, the card lands in Blocked, and
replying carries the work on.

**What a repetition costs** — every step of a turn resends the conversation, so a turn's bill
is roughly the prefix times the number of steps: a 33k transcript and 24 steps is 800k input
tokens, and that is the real number, not a display quirk. Two things make it cheaper. The
provider's cache, when it serves the prefix rather than charging for it — measured on helmcode,
an unchanged prefix has come back anywhere from 0% to 99% served from cache, so it is real but
opportunistic. And not rewriting the transcript: dropping old tool output is free in tokens but
changes the prefix, which is exactly what a cache cannot serve, so it now waits until the
transcript reaches a share of the window (*Routing → Start dropping it at*, 50% by default)
instead of happening on every turn. Cache reads are also priced as cache reads — a tenth of an
input token, a quarter more to write one, or whatever the provider publishes — so a turn's cost
stops being overstated by whatever the cache served.

Every turn's log line carries the evidence: `tokens=66600/879 cache=3072r/0w(5%) first=0%
prefix=32k→35k after=kept steps=2 calls=2 25754ms(model=24s tools=2s)`. The last pair is where
the *time* went, counted as wall time rather than as a sum of durations, since calls in one step
run at the same time: an eleven-minute investigation turned out to be eight minutes of the model
writing and three of everything else, which is a different problem from the one it looked like. `first=` is the share of the *opening* step served from
cache, which is the only honest test of whether the prefix survived between turns; `prefix=`
is how far it grew across the turn, which says whether a big turn went on steps or on carrying
tool output it had already read.

**When nothing is happening** — a turn that has had nothing from the provider for
90 seconds says so, in the log and as a toast, without cancelling anything: a
slow provider is not a broken one. Every turn writes two lines to
`~/.local/share/opendesktop/opendesktop.log` — model, steps, tokens, cost, tool
calls, duration — so an ordinary turn leaves a trace instead of only failures
doing so. And a second process pings the main one every second: eight seconds of
silence and it writes the line a frozen app cannot write for itself. It kills
nothing. `docs/agent-loop-isolation.md` is the plan for the rest of that story.

**What a command can see** — the app merges your login shell's environment into its own so a
Finder launch can find `node`, and passes it on to everything the agent runs. Its own
credentials are taken back out first: whatever it resolved for a provider key or an SSH
passphrase is removed from that environment, and any of those values appearing in command
output is redacted before the output is stored or sent to the model. Everything else is left
alone, because a session doing real work needs the same `git`, `gcloud` and `kube` environment
you have.

## Agents

Agents live one per file in `~/.config/opendesktop/agents`, as markdown with a YAML header —
the same shape other agent tools use, so a file written for either works in
both and importing is a copy rather than a conversion:

```markdown
---
name: Infrastructure
description: Terraform and cloud infrastructure — the orchestrator picks by this line.
mode: all
tools: bash, read, grep, glob, list
model: helmcode/glm5.3-flash
color: "#d3a84c"
---

You are an infrastructure engineer working with Terraform…
```

`mode` decides where an agent appears: `primary` in the composer picker, `subagent` to the
`task` tool, `all` in both. `tools` is an allow-list; anything omitted is switched off.
Six ship by default — Build, Plan, Review, Explore, Infrastructure and Docs — and each can be
edited from **Settings → Agents**, which also imports from `~/.claude/agents`. An install that
still had agents inside `config.json` has them moved into files on first run.

### Auto

A session starts with no agent pinned. The lead sizes the request: one thread of work it does
itself, however many files that touches, because a subagent cannot see the conversation and
re-derives everything from its brief; a piece that is a body of work in its own right — a part
of the system it would have to survey first, a different skill — it splits off, calling `task`
once per piece in the same step so they run in parallel; work with a dependency it runs in
order. The prompt says what that costs, measured here: three one-file fixes split across three
subagents came to about 2.4x the tokens and 2.5x the wall time of the same three fixes done in
one session. Naming an agent with `@` overrides the sizing — that is an instruction, not a
suggestion.

A brief can carry what the lead already knows: `context_paths` are read for the
subagent and put in front of it, `context_notes` are what the lead worked out
that is not in those files. Rediscovering the repository is most of what
delegating costs, and this is what stops it being paid for twice; the files go to
the model, not into the visible message, so the transcript still reads as the
brief that was given.

Each delegation renders in the transcript as its own subchat — the brief it was given, the
tools it ran and what it reported — so a subagent's work is inspectable rather than a summary
you have to take on faith. Its blocks also appear in the Activity dock tagged with its name,
and what it spent is added to the task that delegated it as well as kept on its own subchat, so
a card's total is what the work cost rather than what the manager alone cost. Nesting is capped
at two levels, and one agent runs at most `maxParallelSubagents` (4 by default) at a time —
extra calls wait for a slot rather than opening a stream the provider will throttle. Deleting a
task deletes its subagents with it. Picking a specific agent from the composer turns all of this
off and talks to that agent directly.

## Skills

Skills are folders holding a `SKILL.md`, the layout these folders share. Type `/` in the
composer to search them; the instructions are put in front of the model for that request
while the transcript keeps what you typed. **Settings → Skills** imports from
`~/.claude/skills` — the whole folder travels, so a skill's references and scripts come with
it.

## Layout

```
src/main/        Electron main: agent loop, tools, runtimes, config, store, IPC
  agent/         runner.ts (the loop), tools.ts (bash/read/write/edit/grep/glob/list/fetch/task)
  runtime/       local.ts and ssh.ts behind one Runtime interface
src/preload/     The contextBridge API
src/renderer/    React UI
src/shared/      Types shared across all three
```

State is written to `~/.local/share/opendesktop/`: `sessions/` holds the UI transcript,
`history/` the model-facing transcript. They are deliberately separate — the UI one is shaped
for reading, the model one is what goes back on the next turn.
