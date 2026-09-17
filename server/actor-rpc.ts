import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  FABRIC_TOOL_NAME,
  summarizeFabricResult,
  type fabricActorLogRpc,
  type fabricActorTellRpc,
  type fabricActorsListRpc,
  type fabricSyncRpc,
} from "../shared/fabric";
import { mirrorFabricChildren } from "./fabric-sync";
import { listMeshActors, readMeshActorLog } from "./mesh";

type ActorsListInput = RpcInput<typeof fabricActorsListRpc>;
type ActorLogInput = RpcInput<typeof fabricActorLogRpc>;
type ActorTellInput = RpcInput<typeof fabricActorTellRpc>;
type SyncInput = RpcInput<typeof fabricSyncRpc>;

function isFabricToolCall(item: unknown): item is Extract<AgentTimelineItem, { type: "tool_call" }> {
  if (typeof item !== "object" || item === null) return false;
  const record = item as Record<string, unknown>;
  return record.type === "tool_call" && record.name === FABRIC_TOOL_NAME;
}

async function readParentTimelineItems(
  context: PluginHandlerContext,
  agentId: string,
): Promise<AgentTimelineItem[]> {
  const handle = context.paseo.agents.ref(agentId);
  const payload = await handle.timeline.refetch({ limit: 200 });
  return payload.entries
    .map((entry) => entry.item as unknown)
    .filter((item): item is AgentTimelineItem => isFabricToolCall(item) || isTimelineItem(item));
}

function isTimelineItem(item: unknown): item is AgentTimelineItem {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof (item as Record<string, unknown>).type === "string"
  );
}

async function resolveCwd(
  context: PluginHandlerContext,
  agentId: string,
): Promise<string | null> {
  const handle = context.paseo.agents.ref(agentId);
  const current = handle.current();
  if (current?.cwd) return current.cwd;
  const refetched = await handle.refresh();
  return refetched?.agent.cwd ?? null;
}

export async function listFabricActors(
  input: ActorsListInput,
  context: PluginHandlerContext,
) {
  const items = await readParentTimelineItems(context, input.agentId);
  const fromTimeline = new Map<string, { status: string; detail?: string }>();
  for (const item of items) {
    if (!isFabricToolCall(item) || item.detail.type !== "unknown") continue;
    if (item.status === "running") continue;
    const summary = summarizeFabricResult(item.detail.output);
    for (const actor of summary.actors) {
      fromTimeline.set(actor.name, {
        status: actor.status ?? "unknown",
        ...(actor.detail ? { detail: actor.detail } : {}),
      });
    }
  }
  const cwd = await resolveCwd(context, input.agentId);
  const mesh = cwd ? listMeshActors(cwd) : { root: null, actors: [] };
  const merged = new Map<string, { status: string; detail?: string; source: "timeline" | "mesh" }>();
  for (const [name, info] of fromTimeline) {
    merged.set(name, { ...info, source: "timeline" });
  }
  for (const actor of mesh.actors) {
    if (!merged.has(actor.name)) {
      merged.set(actor.name, {
        status: actor.status,
        ...(actor.detail ? { detail: actor.detail } : {}),
        source: "mesh",
      });
    }
  }
  return {
    actors: [...merged.entries()].map(([name, info]) => ({ name, ...info })),
  };
}

export async function readFabricActorLog(
  input: ActorLogInput,
  context: PluginHandlerContext,
) {
  const cwd = await resolveCwd(context, input.agentId);
  if (!cwd) {
    return { actorName: input.actorName, entries: [], note: "Parent agent cwd is unknown." };
  }
  const { entries, note } = readMeshActorLog(cwd, input.actorName, input.limit ?? 50);
  return {
    actorName: input.actorName,
    entries,
    ...(note ? { note } : {}),
  };
}

// The plugin subprocess cannot write fabric's mesh mailbox directly (registry
// writes take a stale-safe lock owned by the fabric runtime), so `tell`
// relays through the parent agent: Main's fabric runtime delivers the message
// to the actor's serial mailbox on its next turn.
export async function tellFabricActor(
  input: ActorTellInput,
  context: PluginHandlerContext,
) {
  const parent = context.paseo.agents.ref(input.parentAgentId);
  await parent.send(`Relay to fabric actor "${input.actorName}": ${input.message}`);
  return {
    relayed: true,
    note: `Sent to the parent agent for delivery to "${input.actorName}" on its next turn.`,
  };
}

export async function syncFabricAgent(input: SyncInput, context: PluginHandlerContext) {
  const handle = context.paseo.agents.ref(input.agentId);
  const payload = await handle.timeline.refetch({ limit: 200 });
  const items = payload.entries.map((entry) => entry.item as unknown as AgentTimelineItem);
  const current = handle.current();
  const refetched = current ? null : await handle.refresh();
  const cwd = current?.cwd ?? refetched?.agent.cwd ?? null;
  if (!cwd) return { mirrored: 0, note: "Parent agent cwd is unknown." };
  const result = await mirrorFabricChildren({
    paseo: context.paseo,
    parentAgentId: input.agentId,
    cwd,
    timeline: items,
  });
  return result;
}
