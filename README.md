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

### A model on this machine

**Providers & keys** ends with *On this machine*: one row, one button, and a model that runs
here with no key and no account. Pressing it downloads llama.cpp's `llama-server` for this
platform and one curated GGUF, verifies both, declares the provider, fills in the model and
starts the server — which is how you find out it worked without pressing anything else. Nothing
else is installed: no Ollama, no launch agent, no second app to keep running, because the
server is this app's own child process and goes when it does.

|  | Where it goes |
| --- | --- |
| Runtime | `~/.opendesktop/llama/<build>/` (an 11 MB download, ~27 MB once unpacked) |
| Weights | `~/.opendesktop/models/<file>.gguf` (2.5 GB for the default model) |

Both downloads are pinned: the build, the asset names, the byte counts and the SHA-256s are
written into the app, so a download that does not match the thing this version was built
against is deleted rather than executed — and moving to a newer llama.cpp is an app update
rather than a silent change under someone's feet. An interrupted download resumes, and what is
already on disk is re-hashed rather than assumed. An archive containing an absolute path or a
`..` is refused before anything is extracted.

The provider is declared for you as `local/<model>`, pointed at `local://llama` rather than at
a port: the server takes a free one each time it starts, and the address is substituted when a
model is resolved — which is also what starts it. So the first turn routed here waits a few
seconds for the weights to load and every turn after it does not. It is given a fresh API key
per start, because localhost is shared with everything else on the machine. Fifteen minutes
with nothing asking and it shuts down again, giving the memory back.

It is declared as **flat rate** at a price of zero, both of which are true, so at the margin it
is the cheapest thing the router knows about — and at `iq` 2 it only wins work a small model can
actually do. With a stronger flat-rate model configured, that means it mostly sits there, which
is the intended outcome: it is the thing that still works when nothing else is paid for.

Two models are curated, best first. **Qwen3 4B** is the default on measurement, not on size:
asked the same question three times through the agent loop it read the file it was pointed at
and answered in one sentence, identically, three times. **Qwen2.5 3B** is half again as fast
(43 tokens a second against 31) with twice the window, and got the same job right about once in
three — the other two it grepped for the wording of the question, or read a five-line file
sixteen times. Qwen3 is a hybrid thinking model and is served with `--reasoning off`: left on,
it spent an entire 256-token budget inside its reasoning channel and returned an empty answer.

`pnpm local:check [model-id]` does the whole thing for real — install, start, a completion, a
whole turn through the agent loop with tools, and, when two local models are installed, a
**delegated read** where one drives and the other reads. It prints the tokens per second and
the calls it took, and leaves the config as it found it.

That last stage is what a local model is worth having for, and it took three fixes to make it
work. `bulk_read` was missing from the slim harness, so a 4B model with a 16k window was asked
about a 1,600-line file, had no way to read it, grepped instead and invented an answer.
`readRefusal` exempted any read that named a range, on the reasoning that an agent asking for
lines 900-950 knows what it needs — true of a frontier model, and false of a small one that
fills in every optional parameter, so `offset: 0, limit: 2000` walked straight through the
refusal it was meant to trip. And the delegation payload was capped at a constant 400,000
characters, a number written when every cheap model was a hosted one with a 200k window: it is
now sized from the **worker's** declared window, and the refusal says so in tokens. With all
three in place: read refused, 600 lines delegated to the 3B, an accurate two-sentence answer
back in the 4B's own words, and the file itself never in the conversation.

### Less harness for a smaller model

A model declared as **modest** (`iq` 2 or below on the capability slider) is handed a different
harness, because the usual one is written for a frontier model: a page of policy about
delegation, narration and spending, and a dozen tool schemas to choose between. Measured on the
3B, that made it grep for the text of the question instead of reading the file it had just been
pointed at; the same model with three lines of instruction and five tools read the file.

| | Full harness | Slim |
| --- | --- | --- |
| System prompt | ~4,000 tokens of policy | ~400: look first, read what is named, keep it short |
| Tools | everything configured | no `task`, `fetch`, `bulk_read` or `code_write` |
| Steps | `maxSteps` (60) | 12 |
| Temperature | the provider's default | 0.2 |
| Savings guidance | included | omitted |

`plan` deliberately stays: asking a stronger model how to do something hard is not a luxury for
a weak one, it is the arrangement the savings switch exists for, and it is the one thing on that
list that gets more useful as the model gets smaller. The step cap is there because a small
model that has not finished in twelve steps is looping rather than working, and the temperature
is pinned because llama.cpp serves at 0.8 by default, which on a 3B is the difference between
reading a file and inventing a regex for the question.

Capability is the trigger, so the slider is the switch: moving a model to "modest" asks for this
and moving it up refuses it. A model nobody has judged keeps the full harness, and the turn log
says `harness=slim` when the short one was used. None of it changes permissions — the approval
prompts are exactly the same.

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

### Under the composer

One line, quieter than the box above it, because none of it is about the message
being written. What you set rarely is on the left — folder, agent, environment, the two
switches — and what you watch is on the right: which model is answering, how hard it is
trying, and a ring that fills as the conversation approaches a summary.

The **ring** counts toward the summary rather than up to the window: full means now. A
percentage is enough to know one is coming and not enough to do anything about it, so
clicking it opens what the last request was actually made of — messages, tools and framing,
the system prompt, skills — and how much room is left before the older half is replaced. The
total is the provider's own count for the first step of the turn; the parts are this app's
estimate of it, which is said on the panel rather than implied. A conversation that is nine
tenths tool schemas needs fewer tools, not a summary, and that is the distinction the
percentage could not make.

The same panel carries **usage**, separately: every model this app has paid anything for this
month, not only the one in the picker. A delegated read, a plan or a subagent is charged to
whichever model did it, so this is where a shunt worker and the model on your own machine show
up — the local one as `free`, which is the truth rather than `$0.00`.

**Effort** is the dial beside it, from *Faster* to *Smarter*. It deliberately is not a second
model picker: a slider that quietly moved the work to a better model would make the label next
to it a lie. It moves the two things that belong to this turn of this model — how much it may
think, for the models that take a reasoning setting, and how many steps it may spend — and the
panel says which of the two is in force, because for most models it is only the second. Mark a
model as *reasoning* under Providers & keys to have the dial reach it; Anthropic gets a
thinking budget, OpenAI and Google their own spelling of the same thing, and an
OpenAI-compatible endpoint gets `reasoning_effort`. A model that declares nothing is sent
nothing rather than a guess that might fail the request.

### Files it made for you

A document the agent produces gets a card in the conversation — its kind, its name, its
weight, a click to preview it in the pane on the right and an arrow to keep a copy. That used
to cover only files written with the `write` tool, which is not how a report gets made: a PDF
or a CSV comes out of a script the agent ran, and those sat on disk with nothing in the
conversation to say they existed. The turn said "Ran 4 commands".

So there is a `deliver` tool, and the rules tell the agent to use it for the thing that was
asked for. A handed-over file always gets a card, whatever its extension, and the call itself
is not drawn — the card already says it. A path that is not there is refused with the name of
the one that is missing, because a file made by a command is wherever that command put it.

### Looking at a file

A card opens its file in the pane on the right, which is a loopback HTTP server
handing the bytes to a webview: a PDF goes across as `application/pdf`, which the webview
renders, and a markdown file comes back as a rendered page rather than its source.

A file is not a website, so it gets no address bar, and the page itself does not repeat its
path either — the pane's title is the file's name, so a header above the document was the same
string twice. A directory listing keeps its path, because there it is the place you are in
rather than a label for one file. Back, forward, reload and home are of no use to
it, and the button beside the widen and close ones brings the bar back when you want to type a
path. The choice belongs
to the kind of thing being looked at: going from a file to a website brings the bar back on its
own, and going the other way takes it away again.

### A folder of its own

Plenty of what this app is asked is not "change this code": it is a question, an
investigation, a report. Those still write files, and the local environment's working
directory is `~` — so a question that produced a file put it in the home directory, and the
next one put another beside it with nothing to say which conversation either came from.

A session with no folder chosen now gets `~/.opendesktop/workspaces/<id>`, made when the first
turn needs it rather than when the session is created, so a conversation that only ever asked
something leaves nothing behind. It is a **git repository**, and each turn that changed
anything is one commit whose subject is what was asked — so the fifth draft of a report can be
compared with the first, and `git log` reads as the conversation. Deleting the conversation
deletes the folder; `session:workspace` says how many files that would be, for the prompt.

One repository per conversation, deliberately, not one shared by all of them: two sessions
committing at once is `index.lock` contention and a history nobody can read, and it would make
"delete the conversation and its files" a surgical operation instead of removing a directory.

A folder you choose is left alone unless it is in **no repository at all** — then the first
turn starts one, so the Changes pane always has something to read and yesterday's version of a
file still exists. Never when a repository is already above it: a `.git` inside a checkout is a
second repository nobody asked for. Never in the home directory, a parent of it or a
filesystem root either, because a `git init` there tracks everything you own. Only a
conversation's own folder is committed to automatically; a repository you chose is yours to
commit.

The line under the composer shows the path of a folder you chose and **just the icon** for a
conversation's own, since `…/workspaces/94adVYh3JLDa` is an id nobody typed and nobody can
use — it says "somewhere" in twenty-six characters.

Inside that folder **every file gets a card** — something to open and save — whatever its
extension, because there is no project to diff against and the file exists because this
conversation made it. In somebody's repository the old rule still holds: a document opens, a
source file diffs. Choosing a folder in the composer points the session at a real repository
instead, and then nothing is ever deleted with the chat. A remote session keeps its
environment's directory, since a workspace is a folder on this machine.

### Hooks

A command this app runs when the agent does something: format what it edited, stage it,
refuse a path, say when a turn ended. Declared under **Settings → Hooks**, and unlike
everything else that shapes a turn it **costs no tokens** — a rule in a prompt is in the prefix
of every step for ever, a hook runs on the machine and the model never sees it. It runs on the
session's own execution target, in its working directory.

| When | What it can do |
| --- | --- |
| `before` a tool | A non-zero exit refuses the call, and what it printed becomes the reason the agent is given — the only case where a hook reaches the conversation, because a refusal it cannot read is one it will retry for ever. |
| `after` a tool | The side effect. What it prints is kept on the block for you and never sent to the model. |
| `turn` ends | What is about the whole of it: a notification, a commit, a sweep. |

A matcher is a regular expression over the tool name (`write|edit`); absent means every tool.
The hook is told what happened through `$OPENDESKTOP_TOOL`, `$OPENDESKTOP_PATH`,
`$OPENDESKTOP_COMMAND`, `$OPENDESKTOP_SESSION` and `$OPENDESKTOP_OK`, exported rather than
prefixed so a hook that starts with `if` or `case` still parses.

```
case "$OPENDESKTOP_PATH" in */vendor/*) echo "vendor/ is generated"; exit 1;; esac
```

### Tool servers (MCP)

A server is a program that offers the agent tools this app did not write, over MCP. They are
declared under **Settings → Tool servers** and switched on **per session**, from the line under
the composer. Nothing is on by default, and a session that has switched nothing on starts no
processes and sends no schemas.

That is the whole design, and the reason is a number. A tool is a schema resent in the prefix
of *every step of every turn*: one desktop client's list comes to 130 tools and **57,800
tokens** — four times this app's entire prompt, and more than the whole context window of the
model that runs on this machine. Worse, a schema that changes invalidates the provider's cache
of everything in front of it, which is what turns a 63k conversation into 4k of charged input.
So the settings page measures each server — *"2 tools · 1.9k tokens on every step"* — and the
session picker adds up what the conversation is carrying.

The client is this app's own: MCP over stdio is newline-delimited JSON-RPC with three methods,
so it is two hundred lines rather than a dependency, and a server's JSON Schema goes to the
model as it is. What the wrapper adds is this app's rules — a block in the transcript like any
other tool, its output scrubbed of this app's own secrets, and an approval **per call** rather
than per server, because connecting a ticket tracker is not the same decision as closing a
ticket. Tools are named `<server>__<tool>`, so nothing from a server can shadow `bash`. A
server that will not start contributes no tools and says why, instead of offering one that
fails when it is called.

```json
"mcp": {
  "tickets": { "name": "Tickets", "command": "npx", "args": ["-y", "some-mcp-server"] }
}
```

The command runs on this machine with the same environment an agent's commands get — this
app's own API keys stripped out of it — plus whatever the server was declared with. Only stdio
servers for now: the HTTP-and-OAuth ones are a different problem and are not here yet.

`pnpm mcp:check` talks to a real server the way the app does, and is the thing to run before
switching one on:

```bash
pnpm mcp:check -- npx -y @modelcontextprotocol/server-filesystem /tmp/room
pnpm mcp:check -- --call list_directory --args '{"path":"/tmp/room"}' -- npx -y @modelcontextprotocol/server-filesystem /tmp/room
pnpm mcp:check -- --turn 'what is in that folder?' -- npx -y @modelcontextprotocol/server-filesystem /tmp/room
```

Measured on that server: **14 tools, ~2,000 tokens on every step**, ready in 0.7s — and a
session's prefix went from 2k to 4k with it switched on, which is the measurement and the
reality agreeing. `--turn` runs the whole path on a real model; run it under `electron` instead
of `node` when the model's key is in the keychain, and note that a key stored by the packaged
app cannot be read by a dev build.

### The editor

A pane for changing a file, in this app's own clothes rather than VS Code's: numbered lines,
the same syntax colours the transcript uses for code, the same monospace grid. It is a
transparent textarea over a highlighted copy of the same text — the oldest trick there is, and
the only one that cannot drift from the app's palette because it *is* the app's palette. `⌘S`
saves; the write does not go through the approval prompts, because those exist for what the
model asked for and not for somebody's own keystrokes. What it does not have is completion,
folding, multiple cursors or a language server. The day those are wanted is the day to take
Monaco's five megabytes, and not before.

**Which pane a file opens in** is decided by what the file is: a PDF, an image, a spreadsheet
or a rendered markdown is something to look at, so it opens the viewer; a `.ts`, a `.tf`, a
`.sh` or an extension nobody recognises is something to change, so it opens the editor. Both
actions are always on the card and on the row in the Files pane — a pencil or an eye beside the
save-a-copy arrow — so the rule never has to be right.

### Changes, and what happened before now

The pane has two halves. The **working tree** answers what is different from the last commit,
which is only useful while you are the one making the difference. The **history** answers what
happened before now — which is how you find out what the agent did three turns ago, and in a
conversation's own folder it *is* the conversation: one commit per turn, its subject the thing
that was asked.

Picking a commit says who, when, whether it was a merge, which files it touched with their
counts, and opens each file's own diff from that commit. Opening any file — in a commit or in
the working tree — also offers the two questions a diff cannot answer: **history**, every
commit that ever touched it, and **who wrote it**, blame line by line with the commit that
brought each one.

Two things about reading git that cost an hour each and are worth writing down: `--numstat`
and `--name-status` given together are not both honoured — git takes the last one and silently
drops the other, so asking for counts and letters in one call returns letters and a column of
zeroes. And `git blame --no-color` is ambiguous (`--no-color-lines`, `--no-color-by-age`), so
it fails the whole command with a usage message; porcelain output is not coloured anyway.

### Who else is in this file

Running four conversations on one repository is the point of the board, and the failure mode is
two of them editing the same file without either noticing. The agents were already told: every
write records the path it touched, and saving a file another task has changed appends a line to
the tool's result naming it. The person was the one left guessing.

So there is a line above the composer when — and only when — another conversation has changed a
file this one has changed. It names it, opens it on click, and lists the files they have in
common by name. A conversation with no overlap sees nothing at all.

It is fact rather than a guess: the paths both of them actually wrote, not a model's opinion.
The coordinator's opinion does appear, one rung down, for a task that is running and shares a
subject but no file yet, and it says so in as many words.

The registry is on disk, so a change somebody made before lunch is still there after a restart
— losing it to a restart was most of what made the warnings unreliable. And the working tree
gets the last word: once the other task has finished **and** its change is committed, there is
nothing left to tread on, so the line goes away by itself instead of naming the same three
conversations for the rest of the week.

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
Eight ship by default — Build, Plan, Review, Explore, Infrastructure, Docs, Triage and
Report — and each can be edited from **Settings → Agents**, which also imports from
`~/.claude/agents`. An install that still had agents inside `config.json` has them moved into
files on first run.

The **description** is the part that does the most work: it is what the lead reads on every
turn to decide who gets the job, so each one says when to reach for that agent and, where it
is not obvious, when not to. The **prompt** is deliberately short — 150 to 400 tokens, not the
five to eight thousand bytes of "Focus Areas" the template collections ship. A subagent opens
a new session, so its prompt is a fresh prefix with no cache behind it, paid in full on the
first step and resent on every step after; what earns a place in it is the four things a model
cannot infer — when to stop, what to hand back, what it may not touch, and the facts about
this repository that are not in the code it is about to read.

A built-in you have not edited is brought up to date when the app ships a better version of
it: the app records a hash of what it last wrote, so a file that still matches is its own to
replace and a file that does not is yours, untouched. Without that, every improvement to the
roster would reach new installs only — and nobody would ever notice.

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

Anything the app downloads for itself lives apart from that, under `~/.opendesktop/`: `bin/` for
rtk, `llama/` for the local model's runtime and `models/` for its weights. Large, replaceable
and safe to delete — none of it is state.
