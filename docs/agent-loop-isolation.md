# Getting the agent loop out of the main process

Status: planned, not started. The watchdog described at the end of this file is
in, so the failure this is about is no longer silent.

## The problem, as observed

A queued task whose relatedness verdict came back as "same files" put the main
process into a write loop. The symptoms are worth writing down exactly, because
they are the symptoms of *any* wedge in that process, not of that one bug:

- one core at 100%, and no turn stream read — the model's response arrives on
  the same event loop, so every running session stops too;
- the window stops repainting, which is indistinguishable from the app hanging;
- the Quit AppleEvent times out and `SIGTERM` is ignored; `SIGKILL` is the only
  way out;
- nothing is written to `opendesktop.log`, because nothing failed;
- sessions stop being flushed, so what is on disk is from before the wedge.

The scheduler's loop was fixed and is covered by a check. What remains is the
shape: the agent loop, the tools, the store, the runtime, the approvals, the
providers and the window all share one event loop, and any of them can take the
rest down.

## What the split would be

The renderer already talks to the main process through one IPC surface and
watches one event bus. The same seam can carry a worker.

```
main process              worker (utilityProcess)
  window + IPC              runTurn, tools, providers
  store (files)      <-->    runtime (local / ssh / gcp)
  bus fan-out               history, shunt, coordination
  approvals round-trip
```

The worker owns everything that can spin: the AI SDK stream, JSON and zod
parsing of whatever a provider returns, the shunt's file packing, the
relatedness judge, compaction. The main process keeps the things that must be
there when the worker dies: the window, the store on disk, and the ability to
say "the turn for session X was lost" and mark it so.

Four things have to cross the boundary, and they are the work:

1. **Store mutations.** `store.addMessage`, `pushPart`, `appendPartText`,
   `createBlock`, `updateBlock`, `appendBlockOutput`, `creditUsage`. High
   frequency — a streaming turn appends per token. Either the worker owns the
   session file for the duration of a turn and the main process reads it, or the
   deltas are batched over the port at a fixed cadence (the renderer already
   coalesces these, so a 50ms batch changes nothing a user can see).
2. **Approvals.** A request has to reach the renderer and an answer has to come
   back. The port carries both; `requestApproval` becomes a promise resolved by
   a message instead of by the bus.
3. **Runtime.** Commands, PTYs and ssh channels are the worker's, which is
   right: a hung `exec` should not be able to wedge the window. The Terminal
   pane's PTY stays in the main process — it is the user's shell, not the
   agent's.
4. **Config and secrets.** Read once and passed to the worker at spawn;
   `safeStorage` stays in the main process and the worker never sees a keychain.

## Staging it

Each stage is shippable on its own, which matters — this is not a change to make
in one commit.

1. **Model calls only.** The judge and the compaction summariser have no side
   effects and are exactly the parsing-heavy calls: prompt in, text out. Moving
   them proves the port, the error paths and the packaging with almost nothing
   at risk.
2. **The shunt workers.** `bulk_read`, `code_write`, `plan` — same shape, plus
   file reading, plus usage to credit back.
3. **The turn.** `runTurn` and the tools, with the store deltas and the approval
   round-trip over the port. The main process gains "a worker died mid-turn":
   mark the session `error`, say so in the transcript, keep the app alive.
4. **Per-session workers.** Optional, and only if the measurements ask for it:
   one worker per running turn isolates sessions from each other as well as from
   the window.

## What it costs

- A port protocol to keep in step with the store's shape, which is the part that
  will rot if it is not generated from one place.
- Startup latency per worker (tens of milliseconds, once per turn or once per
  app depending on the stage).
- Debugging across two processes; the log becomes the only shared narrative,
  which is an argument for stage 1 landing after the per-turn log line, as it
  has.

## What is already in

A watchdog (`src/main/watchdog.ts` plus the `wedge-watch` utility process) pings
once a second from the main process. Eight seconds of silence and it writes a
line to the log naming how long the main process has been unresponsive, and
another when it answers again. It kills nothing — a process busy for eight
seconds may be finishing something expensive — but a wedge now leaves the trace
it did not leave the first time.
