# pi-fabric wire notes (Phase 0 probe)

Captured against `pi-fabric@0.92.10` (installed at
`~/.pi/agent/npm/node_modules/pi-fabric`) with Pi `0.85.1`. Shapes below are
what the plugin's defensive schemas assume; tighten them as real
`fabric_exec` payloads are captured.

## Tool identity

- Pi tool name: `fabric_exec` (`FABRIC_TOOL_NAME` in `dist/index.js`).
- Full code mode hides Pi core tools from the model; programs reach them via
  `pi.*`. Paseo's Pi provider surfaces `fabric_exec` as an `unknown`
  tool_call (`packages/server/src/server/agent/providers/pi/tool-call-mapper.ts`),
  with raw arguments as `detail.input` and the parsed result as
  `detail.output`.

## Program arguments (model-facing)

From `skillsets/typescript/fabric-exec/SKILL.md`:

- `code` (string, required): one TypeScript program (or Python with
  `executor.kernel: "python"`). Top-level `await`/`return` supported.
- `payloads` (map): large inputs referenced as `π.key` inside `code`.
  Legacy alias `strings`.
- `timeoutMs`: per-invocation whole-program deadline request; effective
  timeout is `max(executor.timeoutMs, requested)`, capped by
  `executor.maxTimeoutMs`.
- `resultFormat`: `auto` (default) / `yaml` / `json` / `text`.

The transformer only requires `code`; every other arg is ignored.

## Nested calls worth counting

`pi.read/bash/powershell/grep/find/ls/edit/write`,
`agents.run/spawn/wait/status/stop/create/ask/tell/steer/followUp/handoff/switchModel`,
`workflow.agent/parallel/pipeline/phase/item/event/log`,
`memory.recall/expand/walk/sessions`, `state.*`, `schema.*`,
`components.*`, `compact.*`, `council.run`, `rlm.query`, `tools.call`,
`mcp.<server>.<tool>`, `extensions.<tool>`. The `HOST_CALL_PATTERN` in
`shared/fabric.ts` covers the `namespace.method(` spellings.

## Child agents and actors

- `agents.run` resolves to `FabricAgentResult`
  (`{ id, runner, kernel?, status, text, value?, error?, usage, turns,
  toolCalls, runnerSessionId? }`); `agents.spawn` returns a handle.
- `agents.create` returns `FabricActorInfo`; mailbox via `ask`/`tell`,
  logs via `agents.log({ type: "session" | "run" | "all" })`.
- Durable mesh lives at `<project>/.pi/fabric/mesh` (`actors/`,
  topics, shared state). `server/mesh.ts` reads JSON files directly under
  `actors/` plus one session-scope level (single-actor `{ name, ... }`
  definitions only) and `session.jsonl` / `mailbox.jsonl` tails in those
  same directories; anything unrecognized degrades to empty rather than
  throwing. Mirror rows keep the verbatim fabric child status in
  `originalStatus` next to the mapped v1 card status.
- Usage export (for tokscale/ccusage): `~/.pi/agent/sessions/.fabric/…`
  or `agents.sessionExportDir`.

## Result envelope (captured live 2026-09-17, Pi 0.85.1 + pi-fabric 0.92.10)

`detail.output` is `{ content: [{ type: "text", text }], details }` with:

- `details.kernel`: `"typescript"` (the `kernel` arg is absent from inputs;
  read it here).
- `details.trace`: `{ kind: "pi-fabric.execution", version: 1, outcome,
  phases, operations: [{ type: "call", sequence, ref, provider, action,
  args, outcome }], counts }`. Gotcha: **`operations[].args` is empty
  (`{}`)** — real call arguments live in `audits[].args`.
- `details.audits[]`: `{ ref, tool, provider, success, args, result,
  resultTruncated, preview }`. Child-agent results are the `result` record
  of audits with `provider: "agents"` **and** `ref` `agents.run`/`agents.spawn`
  (actor ops share the provider: `create` → `FabricActorInfo`, `ask` →
  `FabricActorMessage`, `tell` → `{ queued: true }` — never mirrored):
  `{ id, name, task, status, runner,
  kernel, transport, cwd, model, requestedModel, thinking, startedAt,
  turns, toolCalls, text, usage, logFile, sessionId }`. There is **no
  top-level `agents` array** — `readResultArrays` is fallback only.
- Nested `fabric_exec` calls recurse inside
  `preview.tools[].result.details` with the same envelope shape.

## In-flight audits (live rows)

While a `fabric_exec` call is still running, its timeline row (`status:
"running"`) already carries a partial envelope: `details.audits[]` contains
one entry per spawned child with `ref`/`provider`/`args`/`startedAt` but **no
`success`, no `result`, no `endedAt`**. The plugin reads these as
`status: "running"` children (`auditAgentStatus` in `shared/fabric.ts`) and
shells them as cardless mirrors on the 2s `turn_started` poll loop; the final
card lands once at `turn_ended`. In-flight audits report no child `model`, so
live mirrors resolve `pi/<parent provider/model>` as fallback.

`nestedToolCallId` is planned by pi-fabric as the stable per-child audit id
but is **absent as of 0.92.10**. `fabricChildKey` prefers it when present and
falls back to `callId#index`; mirror labels always key on call-id +
child-index.

## Paseo-side gotchas (verified live)

- Mirror creation requires `config.provider` in `"provider/model"` format;
  bare `"pi"` is rejected. Mirrors resolve `pi/<audit child model>` with
  the parent snapshot's `provider/model` as fallback; model-less children
  are skipped, never guessed.
- `AgentSnapshotPayload` carries **no `parentAgentId`**, so mirror dedupe
  cannot filter by parent. It keys globally on call-id + child-index, which
  is safe because fabric tool-call IDs are unique per originating Pi
  session. Mirrors record their parent in the `pi-fabric.parent` label.
- Timeline append never dedupes by id: the final mirror card is appended only
  after a fresh `agents.ref(id).timeline.refetch` shows its card id absent.
  The live loop fetches one tail page (`refetch({ limit: 200 })`) per 2s poll;
  the active turn's fabric rows are at the tail, so no multi-page walk.
- There is no streaming hook (`agent.turn_started` / `agent.turn_ended` only),
  hence the poll loop. Loop lifetime is managed by `turn_ended` /
  next-`turn_started` / double-fault stop — not by the hook `AbortSignal`,
  whose scope around a fire-and-forget loop is not relied upon.

## Still to capture live

Streaming `tool_execution_update` partials, the
`pi-fabric-handoff-complete` custom message, and actor `session.jsonl`
record shapes. Capture with `pi -p --mode json` runs and paste redacted
samples here before tightening schemas.
