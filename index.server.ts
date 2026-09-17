import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  fabricActorLogRpc,
  fabricActorTellRpc,
  fabricActorsListRpc,
  fabricSyncRpc,
} from "./shared/fabric";
import { listFabricActors, readFabricActorLog, syncFabricAgent, tellFabricActor } from "./server/actor-rpc";
import { mirrorFabricChildren } from "./server/fabric-sync";

export default function contribute(server: PluginServerContext) {
  server.handle(fabricActorsListRpc, listFabricActors);
  server.handle(fabricActorLogRpc, readFabricActorLog);
  server.handle(fabricActorTellRpc, tellFabricActor);
  server.handle(fabricSyncRpc, syncFabricAgent);

  // Mirror terminal fabric children after each turn. Failures are logged,
  // never thrown: event-handler errors must not disturb the parent agent.
  server.on("agent.turn_ended", async (event, context) => {
    if (event.agent.provider !== "pi") return;
    if (event.outcome.kind === "canceled") return;
    await mirrorFabricChildren({
      paseo: context.paseo,
      parentAgentId: event.agent.id,
      cwd: event.agent.cwd,
      timeline: event.timeline,
    });
  });

  return () => {};
}
