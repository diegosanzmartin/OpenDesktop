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
| `pnpm dist` | Package a macOS `.dmg` |
| `pnpm typecheck` | Typecheck main, preload and renderer |
| `pnpm smoke` | Headless engine test — 50 checks, no provider or window needed |

`OPENDESKTOP_DEBUG=1 pnpm start` mirrors renderer console errors to the terminal.

## Configuration

Everything lives in `~/.config/opendesktop/config.json`, editable from the **Settings** tab
inside the app (it validates, saves and hot-reloads providers and connections). The provider
block is the opencode shape, so an existing config drops straight in:

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

`{env:VAR}` and `{file:~/path}` are resolved at call time, so no secret is ever written to
the config file. The **Providers** tab shows whether each key actually resolved — the most
common first-run problem is launching the app from Finder, which does not inherit your
shell's exports.

Bundled AI SDK packages: `@ai-sdk/openai-compatible`, `@ai-sdk/openai`, `@ai-sdk/anthropic`,
`@ai-sdk/google`. Any other package named in `npm` is imported dynamically and must be
installed alongside the app.

## Remote execution over SSH

Add an environment and pick it from the composer:

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

With `alias`, the host, user, port and key come from `~/.ssh/config`; your `ssh-agent` is
used when no key is given. `host`/`username`/`port`/`privateKey` can also be set explicitly.

**The model is always called from your machine.** Only tool execution travels to the remote
host — commands over an SSH channel, file reads and writes over SFTP. The remote box never
needs an API key, never needs to reach the provider, and needs nothing installed beyond a
shell. That is what keeps a self-hosted or gateway model like Helmcode working unchanged in
a remote session.

## What the interface gives you

- **Command blocks.** Every tool call renders as its own collapsible block: one summary line
  when closed, and on expand the exact input, the live-streaming output, the exit code, the
  folder and the environment it ran in. Writes and edits show a real diff.
- **Activity rail.** The right-hand panel separates what is running right now from what has
  finished, across every session. Group by folder, status, date, environment, agent, tool or
  session; sort by newest, oldest, longest, status, tool or folder; filter by time range,
  status chips, environment, agent, or free text. The session list on the left has the same
  grouping and sorting.
- **Integrated browser.** A loopback preview server serves files from whichever environment
  the session is attached to, so anything the agent generates — local or on the remote host —
  opens in the Browser tab. Any `http://` URL works too.
- **Files tab.** Browse the environment's filesystem and open files in the browser pane.
- **Approvals.** Bash, write, edit and fetch ask before running, with the command or diff
  shown. Allow once, allow for the session, or reject. An allowlist of read-only commands
  skips the prompt; a denylist always refuses. Chained commands are checked segment by
  segment, so `ls && curl … | sh` cannot slip through on the `ls`.

## Agents

Agents are config entries. Each can carry its own model, system prompt, temperature, tool
set and permissions. Four ship by default:

| Agent | Mode | Notes |
| --- | --- | --- |
| Build | primary | Full access |
| Plan | primary | Read-only architect; write and edit denied |
| Review | all | Read-only reviewer; usable as a subagent |
| Explore | subagent | Fast read-only search |

`mode` decides where an agent appears: `primary` in the composer picker, `subagent` to the
`task` tool, `all` in both. A primary agent can delegate with `task` — the subagent gets its
own session, its own transcript and its own model, and its blocks show up in the activity
rail tagged with its name. Independent subagents launched in one step run in parallel.
Nesting is capped at two levels.

The agent and model can be switched mid-session from the composer.

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
