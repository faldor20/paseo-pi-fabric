# paseo-pi-fabric

Paseo plugin for the [pi-fabric](https://github.com/monotykamary/pi-fabric)
extension (Pi coding agent). It renders `fabric_exec` calls as compact
timeline cards, mirrors terminal fabric-spawned children as managed Paseo
subagents, and exposes fabric actor log/message actions.

> **Trust this plugin before installing.** Plugins are unsandboxed: server
> code runs with the daemon user's access on the daemon host, and client
> contributions run inside the Paseo app.

## What it contributes

- Timeline transformer + renderer (`kind: "fabric-exec"`, v1): program
  preview, nested `pi.*` / `agents.*` ref counts, child agent/actor rows,
  truncated result preview. Unrecognized payloads keep the original tool row.
- Server `agent.turn_ended` sync: terminal fabric children become labeled
  (`pi-fabric.mirror=true`) managed subagents of the Pi parent — visible in
  the subagents track, archived with the parent, detachable. Only top-level
  Pi parents sync, so mirrors never sprout their own mirrors. Mirrors are idle
  records carrying the reported outcome; they never re-run child work.
  Dedupe is label-based (`pi-fabric.call-id` + `pi-fabric.child-index`)
  since the 0.8.0 create call has no idempotency key; a failed agent list
  defers the sync instead of duplicating. At most 10 mirrors per sync
  (overflow defers to a later sync). Card status maps `stopped`→canceled and
  `timed_out`→failed; the verbatim fabric status is kept in the row's
  `originalStatus`.
- Actor RPCs + agent panel + `/fabric-actors` slash command: list actors
  (timeline, up to 10 pages back, plus mesh sources), read actor logs, relay
  a message via the parent agent. Direct mesh-mailbox writes are deliberately
  out of scope: the fabric runtime owns that lock.

## Install

```bash
paseo plugin add <owner>/paseo-pi-fabric
# or local:
paseo plugin install /absolute/path/to/paseo-pi-fabric
```

Requires Paseo `>=0.8.0`, Pi with pi-fabric loaded for the agent cwd.

## Develop

```bash
npm install
npm run typecheck
npm run test
```

Wire findings live in `docs/fabric-wire.md`. Tighten `shared/fabric.ts`
schemas as real `fabric_exec` envelopes are captured.
