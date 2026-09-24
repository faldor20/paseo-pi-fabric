import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  FABRIC_TOOL_NAME,
  fabricChildKey,
  readFabricExecInput,
  summarizeFabricCode,
  summarizeFabricResult,
  titleHintForCode,
  type FabricAgentStatus,
  type FabricExecData,
} from "../shared/fabric";

// Mirrors fabric-spawned children as managed Paseo subagents so they appear in
// the parent's subagents track, archive with the parent, and can be detached
// into standalone agents. Single-card design: live mirrors are created WITHOUT
// a card (so the shell appears in the subagents list while the child runs);
// the one final card lands at turn_ended via appendMirrorCardOnce. Mirrors are
// idle Pi records carrying the child's reported outcome — they never re-run
// the child's work.

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
  /**
   * Stable audit id when pi-fabric emits `nestedToolCallId` (forward-compat;
   * absent today). Preferred for live-loop dedupe; labels still key on
   * call-id + child-index.
   */
  nestedToolCallId?: string;
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
  return fabricChildKey(callId, childIndex);
}

function mirrorCardId(callId: string, childIndex: number): string {
  return `fabric-mirror-${callId}-${childIndex}`;
}

export function collectFabricMirrorCandidates(
  timeline: readonly AgentTimelineItem[],
  options?: { includeRunning?: boolean },
): FabricMirrorCandidate[] {
  // Default is terminal-only (turn_ended reconcile). The live loop passes
  // includeRunning to also shell running/unknown children, without cards.
  const includeRunning = options?.includeRunning ?? false;
  const candidates: FabricMirrorCandidate[] = [];
  for (const item of timeline) {
    if (item.type !== "tool_call" || item.name !== FABRIC_TOOL_NAME) continue;
    if (item.status === "canceled") continue;
    if (item.status === "running" && !includeRunning) continue;
    if (item.detail.type !== "unknown") continue;
    const program = readFabricExecInput(item.detail.input);
    if (program === null) continue;
    const { codePreview, lineCount, nestedCalls } = summarizeFabricCode(program.code);
    const summary = summarizeFabricResult(item.detail.output);
    const titleHint = titleHintForCode(program.code);
    summary.agents.forEach((agent, childIndex) => {
      if (!includeRunning && !TERMINAL_CHILD_STATUS.has(agent.status)) return;
      // Only Pi-runner children can be mirrored as Pi sessions. Other
      // runners (claude, veda) have no mirror target; their outcome stays
      // on the parent card.
      if (agent.runner !== undefined && agent.runner !== "pi") return;
      // The stable audit id travels on the candidate for live-loop dedupe,
      // never into the stored card row (same shape/ids as before).
      const { nestedToolCallId, ...cardAgent } = agent;
      candidates.push({
        callId: item.callId,
        childIndex,
        name: agent.name ?? `fabric-agent-${childIndex + 1}`,
        ...(agent.cwd ? { cwd: agent.cwd } : {}),
        provider: agent.model ? `pi/${agent.model}` : null,
        ...(typeof nestedToolCallId === "string" && nestedToolCallId
          ? { nestedToolCallId }
          : {}),
        data: {
          codePreview: agent.taskPreview ?? codePreview,
          lineCount,
          ...(program.kernel ? { kernel: program.kernel } : {}),
          nestedCalls,
          agents: [cardAgent],
          actors: [],
          ...(summary.resultPreview ? { resultPreview: summary.resultPreview } : {}),
          resultTruncated: summary.resultTruncated,
          status: mirrorStatusToCard(agent.status),
          originalStatus: agent.status,
          ...(titleHint ? { titleHint } : {}),
          calls: summary.calls,
        },
      });
    });
  }
  return candidates;
}

// Bounds idle Pi sessions created per turn. Deferred children stay
// unmirrored, so a later sync picks them up.
const MAX_MIRRORS_PER_SYNC = 10;

// Find-or-create the labeled mirror for one child, WITHOUT appending any
// card. Returns null when mirroring must defer (unreadable agent list,
// unresolvable provider, failed create) — the caller retries on a later sync.
// Safe to race with itself: the label lookup re-checks just before creating.
export async function ensureFabricMirror(
  paseo: PluginHandlerContext["paseo"],
  parentAgentId: string,
  cwd: string,
  candidate: FabricMirrorCandidate,
): Promise<{ mirrorAgentId: string; created: boolean } | null> {
  return ensureMirrorWithProvider(paseo, parentAgentId, cwd, candidate, undefined);
}

async function ensureMirrorWithProvider(
  paseo: PluginHandlerContext["paseo"],
  parentAgentId: string,
  cwd: string,
  candidate: FabricMirrorCandidate,
  // undefined resolves the parent fallback inside; null means known-absent.
  parentProvider: string | null | undefined,
): Promise<{ mirrorAgentId: string; created: boolean } | null> {
  let existingId: string | null;
  try {
    existingId = await findMirrorId(paseo, candidate.callId, candidate.childIndex);
  } catch (error) {
    console.error("[pi-fabric] mirror lookup failed; deferring:", error);
    return null;
  }
  if (existingId !== null) return { mirrorAgentId: existingId, created: false };
  const resolvedParent =
    parentProvider === undefined ? await readParentProvider(paseo, parentAgentId) : parentProvider;
  // No idempotency key on the 0.8.0 create call: the lookup above is the
  // dedupe, so repeated syncs stay side-effect free. The key covers one
  // child, not one call, so multi-child programs mirror every child.
  const provider = candidate.provider ?? resolvedParent;
  if (provider === null) return null;
  try {
    const handle = await paseo.agents.create({
      config: { provider },
      cwd: candidate.cwd ?? cwd,
      parent: parentAgentId,
      title: `fabric: ${candidate.name}`,
      labels: {
        "pi-fabric.mirror": "true",
        "pi-fabric.call-id": candidate.callId,
        "pi-fabric.child-index": String(candidate.childIndex),
        "pi-fabric.parent": parentAgentId,
      },
    });
    return { mirrorAgentId: handle.id, created: true };
  } catch (error) {
    // Mirror creation must never break the parent turn; the next sync
    // retries the missing child.
    console.error(
      `[pi-fabric] mirror failed for ${candidate.callId}#${candidate.childIndex}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// Append the single final card to a mirror, once. The daemon timeline append
// never dedupes by id, so guard on a fresh read: append only when the card id
// is absent. Returns true when this call appended the card.
export async function appendMirrorCardOnce(
  paseo: PluginHandlerContext["paseo"],
  mirrorAgentId: string,
  callId: string,
  childIndex: number,
  data: FabricMirrorData,
): Promise<boolean> {
  const cardId = mirrorCardId(callId, childIndex);
  let present = false;
  try {
    // Mirror timelines hold only this card; one page is the whole history.
    const page = await paseo.agents.ref(mirrorAgentId).timeline.refetch({ limit: 100 });
    present = page.entries.some(
      (entry) => entry.item.type === "plugin" && entry.item.id === cardId,
    );
  } catch (error) {
    console.error(`[pi-fabric] mirror timeline read failed for ${mirrorAgentId}:`, error);
    return false;
  }
  if (present) return false;
  try {
    await paseo.agents.ref(mirrorAgentId).timeline.append({
      type: "plugin",
      id: cardId,
      kind: "fabric-exec",
      version: 1,
      data,
    });
    return true;
  } catch (error) {
    console.error(`[pi-fabric] mirror card append failed for ${mirrorAgentId}:`, error);
    return false;
  }
}

export async function mirrorFabricChildren(input: {
  paseo: PluginHandlerContext["paseo"];
  parentAgentId: string;
  cwd: string;
  timeline: readonly AgentTimelineItem[];
}): Promise<{ mirrored: number; note?: string }> {
  const candidates = collectFabricMirrorCandidates(input.timeline);
  if (candidates.length === 0) return { mirrored: 0 };
  const mirrorIndex = await readMirrorIndex(input.paseo);
  // Fail closed: an unreadable agent list must defer mirroring, not duplicate it.
  if (mirrorIndex === null) {
    return { mirrored: 0, note: "Agent list unavailable; mirroring deferred to the next sync." };
  }
  // Provider fallback for audits that reported no child model: the parent's
  // own provider/model runs the same Pi runtime the child used.
  const parentProvider = await readParentProvider(input.paseo, input.parentAgentId);
  let mirrored = 0;
  let created = 0;
  let overflow = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    // The cap bounds session creation only: already-mirrored children
    // (including cardless live shells) always get their card reconcile.
    let mirrorAgentId = mirrorIndex.get(mirrorKey(candidate.callId, candidate.childIndex));
    if (mirrorAgentId === undefined) {
      if (created >= MAX_MIRRORS_PER_SYNC) {
        overflow += 1;
        continue;
      }
      if ((candidate.provider ?? parentProvider) === null) {
        skipped += 1;
        continue;
      }
      const ensured = await ensureMirrorWithProvider(
        input.paseo,
        input.parentAgentId,
        candidate.cwd ?? input.cwd,
        candidate,
        parentProvider,
      );
      // Null here is a lookup/create failure (provider was checked above);
      // already logged, retried on the next sync.
      if (ensured === null) continue;
      created += 1;
      mirrorAgentId = ensured.mirrorAgentId;
      mirrorIndex.set(mirrorKey(candidate.callId, candidate.childIndex), mirrorAgentId);
    }
    if (
      await appendMirrorCardOnce(
        input.paseo,
        mirrorAgentId,
        candidate.callId,
        candidate.childIndex,
        candidate.data,
      )
    ) {
      mirrored += 1;
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

function readAgentId(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const agent = (entry as Record<string, unknown>).agent;
  if (typeof agent !== "object" || agent === null) return null;
  const id = (agent as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

// The mirror id for one child, or null when no mirror exists yet. Narrowed
// by call-id label so the live loop never pages the whole mirror set. Throws
// on list failure so the caller defers instead of duplicating.
async function findMirrorId(
  paseo: PluginHandlerContext["paseo"],
  callId: string,
  childIndex: number,
): Promise<string | null> {
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const payload = await paseo.agents.list({
      filter: { labels: { "pi-fabric.mirror": "true", "pi-fabric.call-id": callId } },
      page: cursor === undefined ? { limit: 100 } : { limit: 100, cursor },
    });
    for (const entry of payload.entries) {
      if ((readLabel(entry, "pi-fabric.child-index") ?? "0") !== String(childIndex)) continue;
      const id = readAgentId(entry);
      if (id !== null) return id;
    }
    if (!payload.pageInfo.hasMore || payload.pageInfo.nextCursor === null) break;
    cursor = payload.pageInfo.nextCursor;
  }
  return null;
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

// Recorded mirrors by child key, with mirror agent ids for the card
// reconcile. Returns null when the agent list cannot be read so the caller
// defers instead of duplicating. Mirrors written before the child-index label
// existed carry no index and covered the call's first child only, so they map
// to `#0`.
async function readMirrorIndex(
  paseo: PluginHandlerContext["paseo"],
): Promise<Map<string, string> | null> {
  const index = new Map<string, string>();
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
      const id = readAgentId(entry);
      if (!callId || id === null) continue;
      index.set(mirrorKey(callId, Number(readLabel(entry, "pi-fabric.child-index") ?? "0")), id);
    }
    if (!payload.pageInfo.hasMore || payload.pageInfo.nextCursor === null) break;
    cursor = payload.pageInfo.nextCursor;
  }
  return index;
}
