import type { PluginServerContext } from "@getpaseo/plugin/server";
import { fabricActorLogRpc, fabricActorTellRpc, fabricActorsListRpc } from "./shared/fabric";
import { listFabricActors, readFabricActorLog, tellFabricActor } from "./server/actor-rpc";
import { mirrorFabricChildren } from "./server/fabric-sync";

export default function contribute(server: PluginServerContext) {
  server.handle(fabricActorsListRpc, listFabricActors);
  server.handle(fabricActorLogRpc, readFabricActorLog);
  server.handle(fabricActorTellRpc, tellFabricActor);

  // Mirror terminal fabric children after each turn. Only top-level Pi
  // parents: mirrors are idle Pi agents themselves and must never sprout
  // their own mirrors. Failures are logged, never thrown: event-handler
  // errors must not disturb the parent agent.
  server.on("agent.turn_ended", async (event, context) => {
    if (event.agent.provider !== "pi") return;
    if (event.agent.parentAgentId !== null) return;
    if (event.outcome.kind === "canceled") return;
    try {
      await mirrorFabricChildren({
        paseo: context.paseo,
        parentAgentId: event.agent.id,
        cwd: event.agent.cwd,
        timeline: event.timeline,
      });
    } catch (error) {
      console.error(
        "[pi-fabric] mirror sync failed:",
        error instanceof Error ? error.message : error,
      );
    }
  });

  return () => {};
}
