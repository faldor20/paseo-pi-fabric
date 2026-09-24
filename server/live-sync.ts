import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { collectFabricMirrorCandidates, ensureFabricMirror } from "./fabric-sync";
import { fabricChildKey } from "../shared/fabric";

// Live fabric-child mirroring: while a top-level Pi turn runs, poll the parent
// timeline and shell newly spawned children as cardless mirrors, so they show
// up in the subagents list within ~2s of the spawn. The single final card
// still lands only at turn_ended (appendMirrorCardOnce), which also reconciles
// anything the loop missed. There is no streaming hook, hence polling.

const LIVE_POLL_MS = 2000;
const LIVE_RETRY_MS = 5000;
const LIVE_TIMELINE_LIMIT = 200;

interface LiveLoop {
  turnId: string | null;
  stop: () => void;
}

const liveLoops = new Map<string, LiveLoop>();

export function startFabricLiveSync(
  paseo: PluginHandlerContext["paseo"],
  parent: { id: string; cwd: string },
  turnId: string | null,
): void {
  // A new turn supersedes any previous loop for the agent (turnId change).
  stopFabricLiveSync(parent.id);
  const seen = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const loop: LiveLoop = {
    turnId,
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
  liveLoops.set(parent.id, loop);

  const tick = async (): Promise<void> => {
    if (stopped || liveLoops.get(parent.id) !== loop) return;
    try {
      // One cheap tail-page read per poll; the active turn's fabric rows are
      // at the tail. Non-Pi noise costs one RPC and collects nothing.
      const page = await paseo.agents
        .ref(parent.id)
        .timeline.refetch({ limit: LIVE_TIMELINE_LIMIT });
      failures = 0;
      const candidates = collectFabricMirrorCandidates(
        page.entries.map((entry) => entry.item),
        { includeRunning: true },
      );
      for (const candidate of candidates) {
        const key = fabricChildKey(
          candidate.callId,
          candidate.childIndex,
          candidate.nestedToolCallId,
        );
        if (seen.has(key)) continue;
        // Mark only on success so a transient failure retries next poll;
        // the turn_ended reconcile is the backstop either way. Never append
        // cards from the loop.
        const ensured = await ensureFabricMirror(
          paseo,
          parent.id,
          candidate.cwd ?? parent.cwd,
          candidate,
        );
        if (ensured !== null) seen.add(key);
      }
    } catch (error) {
      // Hook errors must never crash the daemon: back off once, then stop.
      failures += 1;
      console.error(
        `[pi-fabric] live sync failed for ${parent.id} (attempt ${failures}):`,
        error instanceof Error ? error.message : error,
      );
      if (failures >= 2 || stopped) {
        stopFabricLiveSync(parent.id);
        return;
      }
      arm(LIVE_RETRY_MS);
      return;
    }
    if (!stopped) arm(LIVE_POLL_MS);
  };

  const arm = (ms: number): void => {
    timer = setTimeout(() => {
      void tick();
    }, ms);
    // The daemon must never be kept alive by a forgotten loop.
    timer.unref();
  };

  // Poll immediately so an already-spawned child shells without waiting a
  // full interval; the loop then continues every LIVE_POLL_MS.
  void tick();
}

export function stopFabricLiveSync(agentId: string): void {
  const loop = liveLoops.get(agentId);
  if (loop === undefined) return;
  liveLoops.delete(agentId);
  loop.stop();
}

export function stopAllFabricLiveSync(): void {
  for (const agentId of liveLoops.keys()) stopFabricLiveSync(agentId);
}
