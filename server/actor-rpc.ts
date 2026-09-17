import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  FABRIC_TOOL_NAME,
  summarizeFabricResult,
  type fabricActorLogRpc,
  type fabricActorTellRpc,
  type fabricActorsListRpc,
} from "../shared/fabric";
import { listMeshActors, readMeshActorLog } from "./mesh";
import { readFullTimeline } from "./timeline";

type ActorsListInput = RpcInput<typeof fabricActorsListRpc>;
type ActorLogInput = RpcInput<typeof fabricActorLogRpc>;
type ActorTellInput = RpcInput<typeof fabricActorTellRpc>;

function isFabricToolCall(
  item: AgentTimelineItem,
): item is Extract<AgentTimelineItem, { type: "tool_call" }> {
  return item.type === "tool_call" && item.name === FABRIC_TOOL_NAME;
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

export async function listFabricActors(input: ActorsListInput, context: PluginHandlerContext) {
  const items = await readFullTimeline(context.paseo, input.agentId);
  const fromTimeline = new Map<string, { status: string }>();
  for (const item of items) {
    if (!isFabricToolCall(item) || item.detail.type !== "unknown") continue;
    if (item.status === "running") continue;
    const summary = summarizeFabricResult(item.detail.output);
    for (const actor of summary.actors) {
      fromTimeline.set(actor.name, { status: actor.status ?? "unknown" });
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

export async function readFabricActorLog(input: ActorLogInput, context: PluginHandlerContext) {
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
export async function tellFabricActor(input: ActorTellInput, context: PluginHandlerContext) {
  const parent = context.paseo.agents.ref(input.parentAgentId);
  await parent.send(`Relay to fabric actor "${input.actorName}": ${input.message}`);
  return {
    relayed: true,
    note: `Sent to the parent agent for delivery to "${input.actorName}" on its next turn.`,
  };
}
