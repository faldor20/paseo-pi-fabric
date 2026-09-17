import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  FABRIC_TOOL_NAME,
  readFabricExecInput,
  summarizeFabricCode,
  summarizeFabricResult,
  type FabricExecData,
} from "../shared/fabric";

// Mirrors terminal fabric-spawned children as managed Paseo subagents so they
// appear in the parent's subagents track, archive with the parent, and can be
// detached into standalone agents. The mirror is a labeled idle record
// carrying the child's reported outcome — it never re-runs the child's work.

export interface FabricMirrorCandidate {
  callId: string;
  childIndex: number;
  name: string;
  data: FabricExecData;
}

const TERMINAL_CHILD_STATUS = new Set(["completed", "failed", "stopped", "timed_out"]);

function mirrorStatusToCard(
  status: string,
): FabricExecData["status"] {
  if (status === "failed") return "failed";
  return "completed";
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
      candidates.push({
        callId: item.callId,
        childIndex,
        name: agent.name ?? `fabric-agent-${childIndex + 1}`,
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
        },
      });
    });
  }
  return candidates;
}

export async function mirrorFabricChildren(input: {
  paseo: PluginHandlerContext["paseo"];
  parentAgentId: string;
  cwd: string;
  timeline: readonly AgentTimelineItem[];
}): Promise<{ mirrored: number; note?: string }> {
  const candidates = collectFabricMirrorCandidates(input.timeline);
  if (candidates.length === 0) return { mirrored: 0 };
  const alreadyMirrored = await readMirroredCallIds(input.paseo, input.parentAgentId);
  let mirrored = 0;
  for (const candidate of candidates) {
    // No idempotency key on the 0.8.0 create call: skip call IDs that already
    // have a mirror child so repeated syncs stay side-effect free.
    if (alreadyMirrored.has(candidate.callId)) continue;
    try {
      const handle = await input.paseo.agents.create({
        config: { provider: "pi" },
        cwd: input.cwd,
        parent: input.parentAgentId,
        title: `fabric: ${candidate.name}`,
        labels: {
          "pi-fabric.mirror": "true",
          "pi-fabric.call-id": candidate.callId,
        },
      });
      await handle.timeline.append({
        type: "plugin",
        id: `fabric-mirror-${candidate.callId}-${candidate.childIndex}`,
        kind: "fabric-exec",
        version: 1,
        data: candidate.data,
      });
      alreadyMirrored.add(candidate.callId);
      mirrored += 1;
    } catch (error) {
      // Mirror creation must never break the parent turn; the next sync
      // retries the missing call ID.
      console.error(
        `[pi-fabric] mirror failed for ${candidate.callId}#${candidate.childIndex}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { mirrored };
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

function readParentId(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const agent = (entry as Record<string, unknown>).agent;
  if (typeof agent !== "object" || agent === null) return null;
  const parentId = (agent as Record<string, unknown>).parentAgentId;
  return typeof parentId === "string" ? parentId : null;
}

async function readMirroredCallIds(
  paseo: PluginHandlerContext["paseo"],
  parentAgentId: string,
): Promise<Set<string>> {
  const mirrored = new Set<string>();
  try {
    const { entries } = await paseo.agents.list();
    for (const entry of entries) {
      if (readParentId(entry) !== parentAgentId) continue;
      const callId = readLabel(entry, "pi-fabric.call-id");
      if (callId) mirrored.add(callId);
    }
  } catch (error) {
    console.error("[pi-fabric] agent list failed; mirrors may duplicate:", error);
  }
  return mirrored;
}
