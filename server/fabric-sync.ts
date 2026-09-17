import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  FABRIC_TOOL_NAME,
  readFabricExecInput,
  summarizeFabricCode,
  summarizeFabricResult,
  type FabricAgentStatus,
  type FabricExecData,
} from "../shared/fabric";

// Mirrors terminal fabric-spawned children as managed Paseo subagents so they
// appear in the parent's subagents track, archive with the parent, and can be
// detached into standalone agents. The mirror is a labeled idle record
// carrying the child's reported outcome — it never re-runs the child's work.

// Row data appended to each mirror. The card status is mapped onto the v1
// renderer enum; originalStatus preserves the fabric-reported child status
// verbatim (e.g. "timed_out") for readers of the stored row.
export type FabricMirrorData = FabricExecData & { originalStatus: FabricAgentStatus };

export interface FabricMirrorCandidate {
  callId: string;
  childIndex: number;
  name: string;
  data: FabricMirrorData;
  /** Fabric-reported child cwd; the parent cwd applies when absent. */
  cwd?: string;
  /**
   * Paseo `provider/model` for the mirror session, resolved from the audit
   * child model (`pi/<model>`). Null when neither the audit nor the parent
   * snapshot supplied a model; such children are skipped, never guessed.
   */
  provider: string | null;
}

const TERMINAL_CHILD_STATUS: ReadonlySet<FabricAgentStatus> = new Set([
  "completed",
  "failed",
  "stopped",
  "timed_out",
]);

// The v1 card only knows running/completed/failed/canceled. Stopped maps to
// canceled and timed_out to failed; the verbatim status stays in
// data.originalStatus and data.agents[0].status.
function mirrorStatusToCard(status: FabricAgentStatus): FabricExecData["status"] {
  if (status === "failed" || status === "timed_out") return "failed";
  if (status === "stopped") return "canceled";
  return "completed";
}

function mirrorKey(callId: string, childIndex: number): string {
  return `${callId}#${childIndex}`;
}

export function collectFabricMirrorCandidates(
  timeline: readonly AgentTimelineItem[],
): FabricMirrorCandidate[] {
  const candidates: FabricMirrorCandidate[] = [];
  for (const item of timeline) {
    if (item.type !== "tool_call" || item.name !== FABRIC_TOOL_NAME) continue;
    if (item.status === "running" || item.status === "canceled") continue;
    if (item.detail.type !== "unknown") continue;
    const program = readFabricExecInput(item.detail.input);
    if (program === null) continue;
    const { codePreview, lineCount, nestedCalls } = summarizeFabricCode(program.code);
    const summary = summarizeFabricResult(item.detail.output);
    summary.agents.forEach((agent, childIndex) => {
      if (!TERMINAL_CHILD_STATUS.has(agent.status)) return;
      // Only Pi-runner children can be mirrored as Pi sessions. Other
      // runners (claude, veda) have no mirror target; their outcome stays
      // on the parent card.
      if (agent.runner !== undefined && agent.runner !== "pi") return;
      candidates.push({
        callId: item.callId,
        childIndex,
        name: agent.name ?? `fabric-agent-${childIndex + 1}`,
        ...(agent.cwd ? { cwd: agent.cwd } : {}),
        provider: agent.model ? `pi/${agent.model}` : null,
        data: {
          codePreview: agent.taskPreview ?? codePreview,
          lineCount,
          ...(program.kernel ? { kernel: program.kernel } : {}),
          nestedCalls,
          agents: [agent],
          actors: [],
          ...(summary.resultPreview ? { resultPreview: summary.resultPreview } : {}),
          resultTruncated: summary.resultTruncated,
          status: mirrorStatusToCard(agent.status),
          originalStatus: agent.status,
        },
      });
    });
  }
  return candidates;
}

// Bounds idle Pi sessions created per turn. Deferred children stay
// unmirrored, so a later sync picks them up.
const MAX_MIRRORS_PER_SYNC = 10;

export async function mirrorFabricChildren(input: {
  paseo: PluginHandlerContext["paseo"];
  parentAgentId: string;
  cwd: string;
  timeline: readonly AgentTimelineItem[];
}): Promise<{ mirrored: number; note?: string }> {
  const candidates = collectFabricMirrorCandidates(input.timeline);
  if (candidates.length === 0) return { mirrored: 0 };
  const alreadyMirrored = await readMirroredKeys(input.paseo);
  // Fail closed: an unreadable agent list must defer mirroring, not duplicate it.
  if (alreadyMirrored === null) {
    return { mirrored: 0, note: "Agent list unavailable; mirroring deferred to the next sync." };
  }
  const pending = candidates.filter(
    (candidate) => !alreadyMirrored.has(mirrorKey(candidate.callId, candidate.childIndex)),
  );
  const batch = pending.slice(0, MAX_MIRRORS_PER_SYNC);
  const overflow = pending.length - batch.length;
  // Provider fallback for audits that reported no child model: the parent's
  // own provider/model runs the same Pi runtime the child used.
  const parentProvider = await readParentProvider(input.paseo, input.parentAgentId);
  let mirrored = 0;
  let skipped = 0;
  for (const candidate of batch) {
    // No idempotency key on the 0.8.0 create call: skip children that already
    // have a mirror so repeated syncs stay side-effect free. The key covers
    // one child, not one call, so multi-child programs mirror every child.
    const provider = candidate.provider ?? parentProvider;
    if (provider === null) {
      skipped += 1;
      continue;
    }
    try {
      const handle = await input.paseo.agents.create({
        config: { provider },
        cwd: candidate.cwd ?? input.cwd,
        parent: input.parentAgentId,
        title: `fabric: ${candidate.name}`,
        labels: {
          "pi-fabric.mirror": "true",
          "pi-fabric.call-id": candidate.callId,
          "pi-fabric.child-index": String(candidate.childIndex),
          "pi-fabric.parent": input.parentAgentId,
        },
      });
      await handle.timeline.append({
        type: "plugin",
        id: `fabric-mirror-${candidate.callId}-${candidate.childIndex}`,
        kind: "fabric-exec",
        version: 1,
        data: candidate.data,
      });
      alreadyMirrored.add(mirrorKey(candidate.callId, candidate.childIndex));
      mirrored += 1;
    } catch (error) {
      // Mirror creation must never break the parent turn; the next sync
      // retries the missing child.
      console.error(
        `[pi-fabric] mirror failed for ${candidate.callId}#${candidate.childIndex}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  if (overflow > 0) {
    return {
      mirrored,
      note: `${overflow} further child${overflow === 1 ? "" : "ren"} deferred to a later sync (cap ${MAX_MIRRORS_PER_SYNC} per sync).`,
    };
  }
  if (skipped > 0) {
    return {
      mirrored,
      note: `${skipped} child${skipped === 1 ? "" : "ren"} skipped: no model reported and the parent has none either.`,
    };
  }
  return { mirrored };
}

/** Parent `provider/model` for mirrors whose audit reported no child model. */
async function readParentProvider(
  paseo: PluginHandlerContext["paseo"],
  parentAgentId: string,
): Promise<string | null> {
  try {
    const handle = paseo.agents.ref(parentAgentId);
    const snapshot = handle.current() ?? (await handle.refresh())?.agent ?? null;
    if (!snapshot || !snapshot.model) return null;
    return `${snapshot.provider}/${snapshot.model}`;
  } catch (error) {
    console.error("[pi-fabric] parent snapshot failed; model-less children skipped:", error);
    return null;
  }
}

function readLabel(entry: unknown, key: string): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const agent = (entry as Record<string, unknown>).agent;
  if (typeof agent !== "object" || agent === null) return null;
  const labels = (agent as Record<string, unknown>).labels;
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return null;
  const value = (labels as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

// All recorded mirror keys. Returns null when the agent list
// cannot be read so the caller defers instead of duplicating. Mirrors written
// before the child-index label existed carry no index and covered the call's
// first child only, so they map to `#0`.
async function readMirroredKeys(
  paseo: PluginHandlerContext["paseo"],
): Promise<Set<string> | null> {
  const mirrored = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    let payload: Awaited<ReturnType<typeof paseo.agents.list>>;
    try {
      payload = await paseo.agents.list({
        filter: { labels: { "pi-fabric.mirror": "true" } },
        page: cursor === undefined ? { limit: 100 } : { limit: 100, cursor },
      });
    } catch (error) {
      console.error("[pi-fabric] agent list failed; deferring mirrors:", error);
      return null;
    }
    for (const entry of payload.entries) {
      // No parent filter: AgentSnapshotPayload carries no parentAgentId, and
      // none is needed — fabric tool-call IDs are unique per originating Pi
      // session, so a call-id+index key can only belong to one parent.
      const callId = readLabel(entry, "pi-fabric.call-id");
      if (!callId) continue;
      mirrored.add(mirrorKey(callId, Number(readLabel(entry, "pi-fabric.child-index") ?? "0")));
    }
    if (!payload.pageInfo.hasMore || payload.pageInfo.nextCursor === null) break;
    cursor = payload.pageInfo.nextCursor;
  }
  return mirrored;
}
