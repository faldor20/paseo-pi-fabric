import type { PluginServerContext } from "@getpaseo/plugin/server";
import { fabricActorLogRpc, fabricActorTellRpc, fabricActorsListRpc } from "./shared/fabric";
import { listFabricActors, readFabricActorLog, tellFabricActor } from "./server/actor-rpc";
import { archiveFabricMirrors, mirrorFabricChildren } from "./server/fabric-sync";
import { startFabricLiveSync, stopAllFabricLiveSync, stopFabricLiveSync } from "./server/live-sync";

export default function contribute(server: PluginServerContext) {
  server.handle(fabricActorsListRpc, listFabricActors);
  server.handle(fabricActorLogRpc, readFabricActorLog);
  server.handle(fabricActorTellRpc, tellFabricActor);

  // Shell newly spawned children as cardless mirrors while the turn runs, so
  // they appear in the subagents list within ~2s of the spawn. Only top-level
  // Pi parents: mirrors are idle Pi agents themselves and must never sprout
  // their own mirrors. Polling is fire-and-forget; loop errors are logged and
  // stop the loop, never thrown into the hook.
  server.on("agent.turn_started", (event, context) => {
    if (event.agent.provider !== "pi") return;
    if (event.agent.parentAgentId !== null) return;
    startFabricLiveSync(
      context.paseo,
      { id: event.agent.id, cwd: event.agent.cwd },
      event.turnId,
    );
  });

  // Stop the live loop, then reconcile: ensure mirrors for every terminal
  // child (covering restart-missed spawns) and append the single final card
  // to each mirror exactly once. Failures are logged, never thrown:
  // event-handler errors must not disturb the parent agent.
  server.on("agent.turn_ended", async (event, context) => {
    if (event.agent.provider !== "pi") return;
    if (event.agent.parentAgentId !== null) return;
    stopFabricLiveSync(event.agent.id);
    if (event.outcome.kind === "canceled") return;
    try {
      const result = await mirrorFabricChildren({
        paseo: context.paseo,
        parentAgentId: event.agent.id,
        cwd: event.agent.cwd,
        timeline: event.timeline,
      });
      // The return value is the only visibility into silent no-ops (skips,
      // empty candidates); always log it.
      console.log(
        `[pi-fabric] turn_ended sync for ${event.agent.id}: ${JSON.stringify(result)}`,
      );
    } catch (error) {
      console.error(
        "[pi-fabric] mirror sync failed:",
        error instanceof Error ? error.message : error,
      );
    }
  });

  // Archiving the parent archives its mirrors: dead shells leave the
  // subagents list together instead of polluting later audits.
  server.on("agent.archived", async (event, context) => {
    if (event.agent.provider !== "pi") return;
    if (event.agent.parentAgentId !== null) return;
    try {
      const archived = await archiveFabricMirrors(context.paseo, event.agent.id);
      if (archived > 0) {
        console.log(`[pi-fabric] archived ${archived} mirrors of ${event.agent.id}`);
      }
    } catch (error) {
      console.error(
        "[pi-fabric] mirror archive failed:",
        error instanceof Error ? error.message : error,
      );
    }
  });

  return () => {
    stopAllFabricLiveSync();
  };
}
