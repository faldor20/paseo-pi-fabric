import { defineRpc } from "@getpaseo/plugin";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { z } from "zod";

// Indexed from the plugin server entry: @getpaseo/protocol only exposes a
// wildcard subpath export, which the plugin install-time resolver cannot
// see, so nothing may import @getpaseo/protocol/* directly.

// Tool name pi-fabric registers with Pi. Paseo's Pi provider surfaces it as
// an `unknown` tool_call today; the client transformer in
// `client/transform-fabric.ts` claims it.
export const FABRIC_TOOL_NAME = "fabric_exec";

export type AgentTimelineItem =
  PluginLifecycleEvents["agent.turn_ended"]["timeline"][number];

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

// Pi-style `display` argument: the model may declare `{ name, description }`
// or a bare string (repaired to `{ name }`). Mirrors Pi's
// normalizeRunDisplay; unknown shapes yield no display.
export function readFabricDisplay(input: unknown): { name?: string; description?: string } {
  if (typeof input === "string") {
    const name = input.trim();
    if (!name) return {};
    if (name.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(name);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return readFabricDisplay(parsed);
        }
      } catch {
        // Not a JSON object; fall through to the bare-string form.
      }
    }
    return { name: input };
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  return {
    ...(typeof record.name === "string" && record.name.trim() ? { name: record.name } : {}),
    ...(typeof record.description === "string" && record.description.trim()
      ? { description: record.description }
      : {}),
  };
}

// One nested host call row, mirroring Pi's collapsed `› tool detail` lines.
// The card shows the first 8 and hides the rest behind an expander; up to 30
// are stored.
export const fabricCallSchema = z.object({
  ref: z.string(),
  tool: z.string(),
  detail: z.string().optional(),
  success: z.boolean().optional(),
});

export type FabricCall = z.output<typeof fabricCallSchema>;

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

// Delegated cost, straight from the audit child `result.usage`. Mirrors are
// idle sessions (their own `lastUsage` stays empty), so audit reads the
// child's cost here instead.
// No passthrough: the row must stay assignable to JsonValue for timeline append.
export const fabricAgentUsageSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  cost: z.number().optional(),
});

export type FabricAgentUsage = z.output<typeof fabricAgentUsageSchema>;

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
  turns: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  usage: fabricAgentUsageSchema.optional(),
  // Stable per-child audit id, emitted by pi-fabric >= 0.94.0. Stripped from
  // stored card rows; carried on the mirror candidate and mirror labels.
  nestedToolCallId: z.string().optional(),
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
  // Pi-compact card fields, all additive so rows stored before them still
  // parse: the model's declared `display` name/description, a code-derived
  // title fallback, and one row per nested audit call.
  displayName: z.string().optional(),
  displayDescription: z.string().optional(),
  titleHint: z.string().optional(),
  calls: z.array(fabricCallSchema).default([]),
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

// One-line collapse: Pi's truncateOneLine.
function oneLine(value: string, max: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

// Verb labels for the code-derived title hint. Pi derives these from a real
// tokenizer (`fabricExecTitleHint`); this is a regex approximation over the
// same dominant refs, so the collapsed card still reads as intent ("Run +
// Read") instead of raw code.
const TITLE_VERB_LABELS: Record<string, string> = {
  run: "Run",
  spawn: "Run",
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Shell",
  powershell: "Shell",
  grep: "Search",
  find: "Search",
  ls: "List",
  ask: "Ask",
  tell: "Tell",
  wait: "Wait",
  handoff: "Handoff",
};

const MAX_TITLE_HINT_CHARS = 64;

function humanizeVerb(leaf: string): string {
  return leaf.charAt(0).toUpperCase() + leaf.slice(1);
}

export function titleHintForCode(code: string): string | undefined {
  const counts = new Map<string, number>();
  for (const match of code.matchAll(HOST_CALL_PATTERN)) {
    const leaf = match[2] ?? "";
    const label = TITLE_VERB_LABELS[leaf] ?? humanizeVerb(leaf);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  const segments = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 2)
    .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
  const hint = segments.join(" + ");
  return hint.length <= MAX_TITLE_HINT_CHARS ? hint : `${hint.slice(0, MAX_TITLE_HINT_CHARS - 1)}…`;
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
    success: z.boolean().optional(),
    preview: z.unknown().optional(),
    // Planned by pi-fabric, not emitted yet: prefer it as the child key when
    // present (see fabricChildKey).
    nestedToolCallId: z.string().optional(),
  })
  .passthrough();

const fabricDetailsSchema = z.object({ kernel: z.string().optional() }).passthrough();

const fabricOutputSchema = z.object({ details: z.unknown().optional() }).passthrough();

function readDetails(result: unknown): unknown {
  const parsed = fabricOutputSchema.safeParse(result);
  return parsed.success ? parsed.data.details : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Per-kind cap, applied AFTER filtering for agent/actor audits: a program
// with dozens of pi.* calls must not push trailing children off the list.
const MAX_ENVELOPE_ENTRIES = 20;
const nonnegativeInt = z.number().int().nonnegative();
const MAX_AGENT_TEXT_PREVIEW_CHARS = 2000;

function countRefs(refs: string[]): FabricNestedCall[] {
  const counts = new Map<string, number>();
  for (const ref of refs) counts.set(ref, (counts.get(ref) ?? 0) + 1);
  return [...counts.entries()]
    .map(([ref, count]) => ({ ref, count }))
    .sort((a, b) => b.count - a.count || (a.ref < b.ref ? -1 : 1))
    .slice(0, 24);
}

// Stable per-child key for mirror dedupe. pi-fabric >= 0.94.0 emits
// `nestedToolCallId` on audits; the call-id + child-index fallback stays for
// older envelopes and pre-upgrade mirrors. Indices are stable because agent
// audits only append within one fabric_exec call.
export function fabricChildKey(
  callId: string,
  childIndex: number,
  nestedToolCallId?: string,
): string {
  if (typeof nestedToolCallId === "string" && nestedToolCallId.length > 0) {
    return `${callId}~${nestedToolCallId}`;
  }
  return `${callId}#${childIndex}`;
}

// Status for one `provider: "agents"` audit. Terminal audits keep the parsed
// `result.status`; audits with no usable result status are in-flight when
// `success` is still absent (running) and malformed otherwise (unknown).
function auditAgentStatus(
  success: boolean | undefined,
  result: Record<string, unknown> | null,
): FabricAgentStatus | null {
  if (result !== null && typeof result.status === "string") {
    const parsed = fabricAgentStatusSchema.safeParse(result.status);
    if (parsed.success) return parsed.data;
    if (success !== undefined) return "unknown";
  }
  return success === undefined ? "running" : "unknown";
}

// Audits-first extraction from the trace/audit envelope. Gotcha: real call
// args live in `audits[].args` — `trace.operations[].args` is empty (`{}`).
// In-flight children (live `fabric_exec` rows) appear here as audits with
// args/startedAt but no `success`/`result` yet; they read as running.
// Grandchild envelopes: a nested fabric_exec surfaces under the child's
// `result.preview.tools[].result.details`, with the same envelope shape.
function nestedAuditDetails(result: Record<string, unknown> | null): unknown[] {
  const preview = result !== null ? asRecord(result.preview) : null;
  const tools = preview !== null && Array.isArray(preview.tools) ? preview.tools : [];
  const nested: unknown[] = [];
  for (const tool of tools) {
    const details = asRecord(asRecord(tool)?.result)?.details;
    if (details !== undefined) nested.push(details);
  }
  return nested;
}

// One flat audit list: direct audits first, then grandchildren depth-first.
function flattenAudits(details: unknown, depth = 0): unknown[] {
  if (depth > 4) return [];
  const record = asRecord(details);
  if (record === null || !Array.isArray(record.audits)) return [];
  const flat: unknown[] = [];
  for (const raw of record.audits) {
    flat.push(raw);
    const audit = asRecord(raw);
    const result = audit !== null ? asRecord(audit.result) : null;
    for (const nested of nestedAuditDetails(result)) {
      flat.push(...flattenAudits(nested, depth + 1));
    }
  }
  return flat;
}

function readEnvelopeAudits(details: unknown): {
  agents: FabricAgent[];
  actors: FabricActor[];
  textPreview?: { preview: string; truncated: boolean };
} {
  const agents: FabricAgent[] = [];
  const actors: FabricActor[] = [];
  let textPreview: { preview: string; truncated: boolean } | undefined;
  for (const raw of flattenAudits(details)) {
    const audit = fabricAuditSchema.safeParse(raw);
    if (!audit.success) continue;
    const result = asRecord(audit.data.result);
    // Only ephemeral spawns become subagent mirrors. Persistent-actor ops
    // share provider "agents" (create -> FabricActorInfo, ask ->
    // FabricActorMessage, tell -> { queued: true }) but message an existing
    // actor by id; mirroring them shells a new orphan subagent per message.
    if (audit.data.provider === "agents" && (audit.data.ref === "agents.run" || audit.data.ref === "agents.spawn")) {
      if (agents.length >= MAX_ENVELOPE_ENTRIES) continue;
      const status = auditAgentStatus(audit.data.success, result);
      if (status === null) continue;
      const args = asRecord(audit.data.args);
      const text =
        result !== null && typeof result.text === "string"
          ? truncate(result.text, MAX_AGENT_TEXT_PREVIEW_CHARS)
          : undefined;
      if (textPreview === undefined && text !== undefined) textPreview = text;
      const turns = result !== null ? nonnegativeInt.safeParse(result.turns) : null;
      const toolCalls = result !== null ? nonnegativeInt.safeParse(result.toolCalls) : null;
      const usage = result !== null ? fabricAgentUsageSchema.safeParse(result.usage) : null;
      agents.push({
        ...(result !== null && typeof result.name === "string"
          ? { name: result.name }
          : args !== null && typeof args.name === "string"
            ? { name: args.name }
            : {}),
        status,
        ...(result !== null && typeof result.model === "string" ? { model: result.model } : {}),
        ...(result !== null && typeof result.runner === "string" ? { runner: result.runner } : {}),
        ...(args !== null && typeof args.task === "string"
          ? { taskPreview: truncate(args.task, MAX_TASK_PREVIEW_CHARS).preview }
          : {}),
        ...(text !== undefined ? { resultPreview: text.preview } : {}),
        ...(result !== null && typeof result.id === "string" ? { id: result.id } : {}),
        ...(result !== null && typeof result.cwd === "string" ? { cwd: result.cwd } : {}),
        ...(turns !== null && turns.success ? { turns: turns.data } : {}),
        ...(toolCalls !== null && toolCalls.success ? { toolCalls: toolCalls.data } : {}),
        ...(usage !== null && usage.success ? { usage: usage.data } : {}),
        ...(typeof audit.data.nestedToolCallId === "string" && audit.data.nestedToolCallId
          ? { nestedToolCallId: audit.data.nestedToolCallId }
          : {}),
      });
    } else if (audit.data.ref === "agents.create" && result !== null && typeof result.name === "string") {
      if (actors.length >= MAX_ENVELOPE_ENTRIES) continue;
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

const MAX_STORED_CALLS = 30;
const MAX_TASK_DETAIL_CHARS = 64;
const MAX_MESSAGE_DETAIL_CHARS = 48;

function shortId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 8) : undefined;
}

function countValue(value: unknown): string {
  if (Array.isArray(value)) return String(value.length);
  if (typeof value === "object" && value !== null) return String(Object.keys(value).length);
  return "";
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function agentPreviewName(raw: unknown): string | undefined {
  const preview = asRecord(raw);
  if (preview === null || typeof preview.kind !== "string") return undefined;
  return typeof preview.name === "string" ? preview.name : undefined;
}

// Per-call detail text, ported from Pi's providerCallDetail plus the generic
// command/path/task fallback in nestedCallTitleText. Powers the collapsed
// `› tool detail` rows; empty detail renders as the bare tool name.
function auditCallDetail(
  provider: string,
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
  preview: unknown,
): string {
  if (provider === "agents") {
    const name = stringArg(args, "name");
    const previewName = agentPreviewName(preview);
    const id = shortId(args.id);
    const message = stringArg(args, "message");
    const task = stringArg(args, "task");
    switch (tool) {
      case "create":
        return name ?? "";
      case "run":
      case "spawn":
        return name ?? (task ? oneLine(task, MAX_TASK_DETAIL_CHARS) : (previewName ?? ""));
      case "ask":
      case "tell":
        return [previewName ?? name ?? id, message ? oneLine(message, MAX_MESSAGE_DETAIL_CHARS) : ""]
          .filter(Boolean)
          .join(" ");
      case "remove":
      case "stop":
      case "cleanup":
      case "wait":
      case "status":
      case "actorStatus":
      case "messages":
        return previewName ?? name ?? id ?? "";
      case "actors":
      case "list":
      case "models":
      case "peers":
        return countValue(result);
      default:
        return previewName ?? id ?? "";
    }
  }
  if (provider === "mesh") {
    switch (tool) {
      case "publish":
        return stringArg(args, "topic") ?? "";
      case "read":
        return [stringArg(args, "topic"), countValue(result)].filter(Boolean).join(" · ");
      case "get":
      case "put":
      case "delete":
        return stringArg(args, "key") ?? "";
      case "list":
        return [stringArg(args, "prefix"), countValue(result)].filter(Boolean).join(" · ");
      case "members":
        return countValue(result);
      default:
        return "";
    }
  }
  if (provider === "mcp") {
    switch (tool) {
      case "$call":
        return [stringArg(args, "server"), stringArg(args, "tool")].filter(Boolean).join(".");
      case "$register":
        return stringArg(args, "name") ?? "";
      case "$servers":
        return countValue(result);
      default:
        return "";
    }
  }
  const command = stringArg(args, "command");
  if (command) {
    const firstLine = command.split("\n")[0] ?? "";
    return firstLine ? `$ ${firstLine}` : "";
  }
  const path = stringArg(args, "path");
  if (path) return path;
  const pattern = stringArg(args, "pattern");
  if (pattern) return path ? `/${pattern}/ ${path}` : `/${pattern}/`;
  const task = stringArg(args, "task");
  if (task) return oneLine(task, MAX_TASK_DETAIL_CHARS);
  return "";
}

// One collapsed row per nested audit call, in envelope order. Mirrors the
// rows Pi's compact result renderer builds from the same audits.
export function extractFabricCalls(details: unknown): FabricCall[] {
  const record = asRecord(details);
  if (record === null || !Array.isArray(record.audits)) return [];
  const calls: FabricCall[] = [];
  for (const raw of record.audits.slice(0, MAX_STORED_CALLS)) {
    const audit = fabricAuditSchema.safeParse(raw);
    if (!audit.success) continue;
    const ref = typeof audit.data.ref === "string" ? audit.data.ref : undefined;
    if (!ref) continue;
    const [provider = ref, tool = ref] = ref.split(".");
    const args = asRecord(audit.data.args) ?? {};
    const detail = auditCallDetail(provider, tool, args, audit.data.result, audit.data.preview);
    calls.push({
      ref,
      tool,
      ...(detail ? { detail } : {}),
      ...(typeof audit.data.success === "boolean" ? { success: audit.data.success } : {}),
    });
  }
  return calls;
}

export function extractFabricContent(output: unknown): {
  agents: FabricAgent[];
  actors: FabricActor[];
  operations: FabricNestedCall[];
  calls: FabricCall[];
  kernel?: string;
  resultPreview?: string;
  resultTruncated: boolean;
} {
  const details = readDetails(output);
  const detailsParsed = fabricDetailsSchema.safeParse(details);
  const kernel = detailsParsed.success ? detailsParsed.data.kernel : undefined;
  const { agents, actors, textPreview } = readEnvelopeAudits(details);
  const operations = readEnvelopeOperations(details);
  const calls = extractFabricCalls(details);
  if (textPreview !== undefined) {
    // Agent text beats a JSON dump of the whole envelope as the
    // card/mirror preview.
    return {
      agents,
      actors,
      operations,
      calls,
      ...(kernel ? { kernel } : {}),
      resultPreview: textPreview.preview,
      resultTruncated: textPreview.truncated,
    };
  }
  return { agents, actors, operations, calls, ...(kernel ? { kernel } : {}), resultTruncated: false };
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
  calls: FabricCall[];
  kernel?: string;
  resultPreview?: string;
  resultTruncated: boolean;
} {
  if (result === null || result === undefined) {
    return { agents: [], actors: [], operations: [], calls: [], resultTruncated: false };
  }
  const envelope = extractFabricContent(result);
  const fallback = readResultArrays(result);
  const agents = mergeByName(envelope.agents, fallback.agents);
  const actors = mergeByName(envelope.actors, fallback.actors);
  const calls = envelope.calls;
  if (envelope.resultPreview !== undefined) {
    return {
      agents,
      actors,
      operations: envelope.operations,
      calls,
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
    calls,
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
