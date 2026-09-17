import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Tool name pi-fabric registers with Pi. Paseo's Pi provider surfaces it as
// an `unknown` tool_call today; the client transformer in
// `client/transform-fabric.ts` claims it.
export const FABRIC_TOOL_NAME = "fabric_exec";

// Reads the fabric program source from a Paseo `unknown` tool-call input.
// Shared by the client transformer and the server mirror sync so both sides
// agree on what counts as a fabric program.
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
  taskPreview: z.string().optional(),
  resultPreview: z.string().optional(),
});

export type FabricAgent = z.output<typeof fabricAgentSchema>;

export const fabricActorSchema = z.object({
  name: z.string(),
  status: z.string().optional(),
  detail: z.string().optional(),
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

// Defensive extraction of child-agent entries from a fabric result envelope.
// The envelope shape is version-dependent, so only top-level `agents` /
// `actors` arrays with object entries are honored; anything else yields no
// entries rather than a misparsed card. See `docs/fabric-wire.md`.
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

export function summarizeFabricResult(result: unknown): {
  agents: FabricAgent[];
  actors: FabricActor[];
  resultPreview?: string;
  resultTruncated: boolean;
} {
  if (result === null || result === undefined) {
    return { agents: [], actors: [], resultTruncated: false };
  }
  const { agents, actors } = readResultArrays(result);
  const { preview, truncated } = previewValue(result, MAX_RESULT_PREVIEW_CHARS);
  return { agents, actors, resultPreview: preview, resultTruncated: truncated };
}

// Actor RPCs. Handlers live in `server/actor-rpc.ts`; the actors surface in
// `client/actors-surface.tsx` consumes them.

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

export const fabricSyncRpc = defineRpc({
  name: "fabric.sync",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ mirrored: z.number().int().nonnegative(), note: z.string().optional() }),
});
