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
| `pnpm smoke` | Headless engine test — 50 checks, no provider or window needed |
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

**Settings → Models & providers** is the place to do this from the UI: add or remove
providers, edit the base URL and the AI SDK package, manage each provider's model list, set
the default model, and paste the API key. Nothing there requires touching a file.

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
it vary between a dev run and the packaged build — otherwise a key stored by one would be
unreadable to the other. A secret that is present but cannot be decrypted here (copied from
another machine, say) is reported as such in the UI instead of looking like a missing key.

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
the prompt; a denylist always refuses. Chained commands are checked segment by segment, so
`ls && curl … | sh` cannot slip through on the `ls`.

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

A session starts with no agent pinned. The lead sizes the request: one coherent job it does
itself, because delegating a small change costs a round trip and the subagent cannot see the
conversation; genuinely separable pieces it splits, calling `task` once per piece in the same
step so they run in parallel; work with a dependency it runs in order.

Each delegation renders in the transcript as its own subchat — the brief it was given, the
tools it ran and what it reported — so a subagent's work is inspectable rather than a summary
you have to take on faith. Its blocks also appear in the Activity dock tagged with its name.
Nesting is capped at two levels. Picking a specific agent from the composer turns all of this
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
