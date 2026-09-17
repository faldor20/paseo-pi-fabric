import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Tool name pi-fabric registers with Pi. Paseo's Pi provider surfaces it as
// an `unknown` tool_call today; the client transformer in
// `client/transform-fabric.ts` claims it.
export const FABRIC_TOOL_NAME = "fabric_exec";

// Reads the fabric program source from a Paseo `unknown` tool-call input.
// Shared by the client transformer and the server mirror sync so both sides
// agree on what counts as a fabric program. Observed live (pi-fabric
// 0.92.10): `{ code, resultFormat?, display? }` — `kernel` is absent here
// and lives in the output `details` instead.
export function readFabricExecInput(input: unknown): { code: string; kernel?: string } | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (typeof record.code !== "string") return null;
  return {
    code: record.code,
    ...(typeof record.kernel === "string" ? { kernel: record.kernel } : {}),
  };
}

// A nested host call referenced inside a fabric program, e.g. `pi.read` or
// `agents.run`. Derived from program source, not from the result envelope,
// so the card stays useful when the result shape is unfamiliar.
export const fabricNestedCallSchema = z.object({
  ref: z.string(),
  count: z.number().int().nonnegative(),
});

export type FabricNestedCall = z.output<typeof fabricNestedCallSchema>;

// One fabric-spawned child surfaced in the card and mirrored as a managed
// Paseo subagent by `server/fabric-sync.ts`.
export const fabricAgentStatusSchema = z.enum([
  "completed",
  "failed",
  "stopped",
  "timed_out",
  "running",
  "unknown",
]);

export type FabricAgentStatus = z.output<typeof fabricAgentStatusSchema>;

export const fabricAgentSchema = z.object({
  name: z.string().optional(),
  status: fabricAgentStatusSchema,
  model: z.string().optional(),
  /** Fabric runner that executed the child (`pi`, `claude`, `veda`). */
  runner: z.string().optional(),
  taskPreview: z.string().optional(),
  resultPreview: z.string().optional(),
  id: z.string().optional(),
  cwd: z.string().optional(),
});

export type FabricAgent = z.output<typeof fabricAgentSchema>;

export const fabricActorSchema = z.object({
  name: z.string(),
  status: z.string().optional(),
});

export type FabricActor = z.output<typeof fabricActorSchema>;

// Renderer payload for `kind: "fabric-exec"`, version 1.
export const fabricExecDataSchema = z.object({
  codePreview: z.string(),
  lineCount: z.number().int().nonnegative(),
  kernel: z.string().optional(),
  nestedCalls: z.array(fabricNestedCallSchema),
  agents: z.array(fabricAgentSchema),
  actors: z.array(fabricActorSchema),
  resultPreview: z.string().optional(),
  resultTruncated: z.boolean(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
});

export type FabricExecData = z.output<typeof fabricExecDataSchema>;

const MAX_CODE_PREVIEW_CHARS = 1200;
const MAX_RESULT_PREVIEW_CHARS = 2000;
const MAX_TASK_PREVIEW_CHARS = 280;

// Matches dotted host-call refs in TypeScript and Python fabric programs:
// `pi.read(`, `agents.run(`, `await tools.call(...)` is counted separately.
const HOST_CALL_PATTERN = /\b(pi|agents|workflow|memory|state|schema|mcp|extensions|tools|components|compact|council|rlm)\.([A-Za-z_$][\w$]*)\s*\(/g;

export function summarizeFabricCode(code: string): {
  codePreview: string;
  lineCount: number;
  nestedCalls: FabricNestedCall[];
} {
  const lineCount = code === "" ? 0 : code.split("\n").length;
  const codePreview =
    code.length > MAX_CODE_PREVIEW_CHARS
      ? `${code.slice(0, MAX_CODE_PREVIEW_CHARS)}…`
      : code;
  const counts = new Map<string, number>();
  for (const match of code.matchAll(HOST_CALL_PATTERN)) {
    const ref = `${match[1]}.${match[2]}`;
    counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  const nestedCalls = [...counts.entries()]
    .map(([ref, count]) => ({ ref, count }))
    .sort((a, b) => b.count - a.count || (a.ref < b.ref ? -1 : 1))
    .slice(0, 24);
  return { codePreview, lineCount, nestedCalls };
}

function truncate(text: string, max: number): { preview: string; truncated: boolean } {
  if (text.length <= max) return { preview: text, truncated: false };
  return { preview: `${text.slice(0, max)}…`, truncated: true };
}

function previewValue(value: unknown, max: number): { preview: string; truncated: boolean } {
  if (typeof value === "string") return truncate(value, max);
  try {
    return truncate(JSON.stringify(value, null, 2) ?? "null", max);
  } catch {
    return { preview: "[unserializable result]", truncated: true };
  }
}

// pi-fabric execution envelope, captured live against pi-fabric 0.92.10
// (see `docs/fabric-wire.md`). Tolerant by design: every layer is parsed
// separately so one unfamiliar field never discards the rest, and only the
// discriminators matched on (`operations[].ref`, audit `provider`/`ref`)
// are required. Unknown keys pass through.
const fabricTraceOperationSchema = z.object({ ref: z.string() }).passthrough();

const fabricTraceSchema = z
  .object({ operations: z.array(z.unknown()).optional() })
  .passthrough();

const fabricAuditSchema = z
  .object({
    ref: z.string().optional(),
    provider: z.string().optional(),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

const fabricDetailsSchema = z.object({ kernel: z.string().optional() }).passthrough();

const fabricOutputSchema = z.object({ details: z.unknown().optional() }).passthrough();

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const MAX_ENVELOPE_ENTRIES = 20;
const MAX_AGENT_TEXT_PREVIEW_CHARS = 2000;

function countRefs(refs: string[]): FabricNestedCall[] {
  const counts = new Map<string, number>();
  for (const ref of refs) counts.set(ref, (counts.get(ref) ?? 0) + 1);
  return [...counts.entries()]
    .map(([ref, count]) => ({ ref, count }))
    .sort((a, b) => b.count - a.count || (a.ref < b.ref ? -1 : 1))
    .slice(0, 24);
}

// Audits-first extraction from the trace/audit envelope. Gotcha: real call
// args live in `audits[].args` — `trace.operations[].args` is empty (`{}`).
function readEnvelopeAudits(details: unknown): {
  agents: FabricAgent[];
  actors: FabricActor[];
  textPreview?: { preview: string; truncated: boolean };
} {
  const agents: FabricAgent[] = [];
  const actors: FabricActor[] = [];
  let textPreview: { preview: string; truncated: boolean } | undefined;
  const record = asRecord(details);
  const rawAudits = record !== null && Array.isArray(record.audits) ? record.audits : [];
  for (const raw of rawAudits.slice(0, MAX_ENVELOPE_ENTRIES)) {
    const audit = fabricAuditSchema.safeParse(raw);
    if (!audit.success) continue;
    const result = asRecord(audit.data.result);
    if (audit.data.provider === "agents" && result !== null && typeof result.status === "string") {
      const status = fabricAgentStatusSchema.safeParse(result.status);
      const args = asRecord(audit.data.args);
      const text = typeof result.text === "string" ? truncate(result.text, MAX_AGENT_TEXT_PREVIEW_CHARS) : undefined;
      if (textPreview === undefined && text !== undefined) textPreview = text;
      agents.push({
        ...(typeof result.name === "string" ? { name: result.name } : {}),
        status: status.success ? status.data : "unknown",
        ...(typeof result.model === "string" ? { model: result.model } : {}),
        ...(typeof result.runner === "string" ? { runner: result.runner } : {}),
        ...(args !== null && typeof args.task === "string"
          ? { taskPreview: truncate(args.task, MAX_TASK_PREVIEW_CHARS).preview }
          : {}),
        ...(text !== undefined ? { resultPreview: text.preview } : {}),
        ...(typeof result.id === "string" ? { id: result.id } : {}),
        ...(typeof result.cwd === "string" ? { cwd: result.cwd } : {}),
      });
    } else if (audit.data.ref === "agents.create" && result !== null && typeof result.name === "string") {
      actors.push({
        name: result.name,
        status: typeof result.status === "string" ? result.status : "unknown",
      });
    }
  }
  return { agents, actors, ...(textPreview ? { textPreview } : {}) };
}

function readEnvelopeOperations(details: unknown): FabricNestedCall[] {
  const record = asRecord(details);
  if (record === null) return [];
  const trace = fabricTraceSchema.safeParse(record.trace);
  if (!trace.success || trace.data.operations === undefined) return [];
  const refs: string[] = [];
  for (const raw of trace.data.operations) {
    const op = fabricTraceOperationSchema.safeParse(raw);
    if (op.success) refs.push(op.data.ref);
  }
  return countRefs(refs);
}

export function extractFabricContent(output: unknown): {
  agents: FabricAgent[];
  actors: FabricActor[];
  operations: FabricNestedCall[];
  kernel?: string;
  resultPreview?: string;
  resultTruncated: boolean;
} {
  const parsed = fabricOutputSchema.safeParse(output);
  const details = parsed.success ? parsed.data.details : undefined;
  const detailsParsed = fabricDetailsSchema.safeParse(details);
  const kernel = detailsParsed.success ? detailsParsed.data.kernel : undefined;
  const { agents, actors, textPreview } = readEnvelopeAudits(details);
  const operations = readEnvelopeOperations(details);
  if (textPreview !== undefined) {
    // Agent text beats a JSON dump of the whole envelope as the
    // card/mirror preview.
    return {
      agents,
      actors,
      operations,
      ...(kernel ? { kernel } : {}),
      resultPreview: textPreview.preview,
      resultTruncated: textPreview.truncated,
    };
  }
  return { agents, actors, operations, ...(kernel ? { kernel } : {}), resultTruncated: false };
}

// Defensive extraction of child-agent entries from legacy top-level `agents`
// / `actors` arrays. Kept as a fallback behind the audits-first envelope
// parse; anything else yields no entries rather than a misparsed card.
function readResultArrays(result: unknown): { agents: FabricAgent[]; actors: FabricActor[] } {
  const agents: FabricAgent[] = [];
  const actors: FabricActor[] = [];
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return { agents, actors };
  }
  const record = result as Record<string, unknown>;
  const rawAgents = record.agents;
  if (Array.isArray(rawAgents)) {
    for (const entry of rawAgents.slice(0, 20)) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      const status = fabricAgentStatusSchema.safeParse(item.status);
      agents.push({
        ...(typeof item.name === "string" ? { name: item.name } : {}),
        status: status.success ? status.data : "unknown",
        ...(typeof item.model === "string" ? { model: item.model } : {}),
        ...(typeof item.task === "string"
          ? { taskPreview: truncate(item.task, MAX_TASK_PREVIEW_CHARS).preview }
          : {}),
      });
    }
  }
  const rawActors = record.actors;
  if (Array.isArray(rawActors)) {
    for (const entry of rawActors.slice(0, 20)) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      if (typeof item.name !== "string") continue;
      actors.push({
        name: item.name,
        ...(typeof item.status === "string" ? { status: item.status } : {}),
      });
    }
  }
  return { agents, actors };
}

function mergeByName<T extends { name?: string }>(primary: T[], fallback: T[]): T[] {
  const seen = new Set<string>();
  for (const entry of primary) {
    if (entry.name !== undefined) seen.add(entry.name);
  }
  const merged = [...primary];
  for (const entry of fallback) {
    if (entry.name === undefined || !seen.has(entry.name)) {
      merged.push(entry);
      if (entry.name !== undefined) seen.add(entry.name);
    }
  }
  return merged.slice(0, MAX_ENVELOPE_ENTRIES);
}

export function summarizeFabricResult(result: unknown): {
  agents: FabricAgent[];
  actors: FabricActor[];
  operations: FabricNestedCall[];
  kernel?: string;
  resultPreview?: string;
  resultTruncated: boolean;
} {
  if (result === null || result === undefined) {
    return { agents: [], actors: [], operations: [], resultTruncated: false };
  }
  const envelope = extractFabricContent(result);
  const fallback = readResultArrays(result);
  const agents = mergeByName(envelope.agents, fallback.agents);
  const actors = mergeByName(envelope.actors, fallback.actors);
  if (envelope.resultPreview !== undefined) {
    return {
      agents,
      actors,
      operations: envelope.operations,
      ...(envelope.kernel ? { kernel: envelope.kernel } : {}),
      resultPreview: envelope.resultPreview,
      resultTruncated: envelope.resultTruncated,
    };
  }
  const { preview, truncated } = previewValue(result, MAX_RESULT_PREVIEW_CHARS);
  return {
    agents,
    actors,
    operations: envelope.operations,
    ...(envelope.kernel ? { kernel: envelope.kernel } : {}),
    resultPreview: preview,
    resultTruncated: truncated,
  };
}

// Actor RPCs. Handlers live in `server/actor-rpc.ts`; the agent panel in
// `client/actors-panel.tsx` consumes them.

export const fabricActorsListInput = z.object({ agentId: z.string().min(1) });

export const fabricActorInfoSchema = z.object({
  name: z.string(),
  status: z.string(),
  detail: z.string().optional(),
  source: z.enum(["timeline", "mesh"]),
});

export const fabricActorsListRpc = defineRpc({
  name: "fabric.actors.list",
  input: fabricActorsListInput,
  output: z.object({ actors: z.array(fabricActorInfoSchema) }),
});

export const fabricActorLogRpc = defineRpc({
  name: "fabric.actor.log",
  input: z.object({
    agentId: z.string().min(1),
    actorName: z.string().min(1),
    limit: z.number().int().positive().max(200).optional(),
  }),
  output: z.object({
    actorName: z.string(),
    entries: z.array(z.string()),
    note: z.string().optional(),
  }),
});

export const fabricActorTellRpc = defineRpc({
  name: "fabric.actor.tell",
  input: z.object({
    parentAgentId: z.string().min(1),
    actorName: z.string().min(1),
    message: z.string().min(1).max(4000),
  }),
  output: z.object({ relayed: z.boolean(), note: z.string() }),
});
