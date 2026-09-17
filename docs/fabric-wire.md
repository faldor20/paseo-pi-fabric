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
  topics, shared state). `server/mesh.ts` probes `actors/**/*.json` plus
  `session.jsonl` / `mailbox.jsonl` tails; anything unrecognized degrades to
  empty rather than throwing.
- Usage export (for tokscale/ccusage): `~/.pi/agent/sessions/.fabric/…`
  or `agents.sessionExportDir`.

## Still to capture live

Real `detail.output` envelopes for a completed `fabric_exec` containing
`agents.run` results (to promote `readResultArrays` beyond top-level
`agents`/`actors` arrays), streaming `tool_execution_update` partials, the
`pi-fabric-handoff-complete` custom message, and actor `session.jsonl`
record shapes. Capture with `pi -p --mode json` runs and paste redacted
samples here before tightening schemas.
