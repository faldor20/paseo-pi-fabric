import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "../shared/fabric";

const TIMELINE_PAGE_SIZE = 200;
const TIMELINE_MAX_PAGES = 10;

// Full parent timeline, oldest first. Single refetch pages are capped by the
// daemon, so walk back while older rows exist; the page cap bounds the read
// for very long histories.
export async function readFullTimeline(
  paseo: PluginHandlerContext["paseo"],
  agentId: string,
): Promise<AgentTimelineItem[]> {
  const handle = paseo.agents.ref(agentId);
  const first = await handle.timeline.refetch({ limit: TIMELINE_PAGE_SIZE });
  const pages: AgentTimelineItem[][] = [first.entries.map((entry) => entry.item)];
  let cursor = first.startCursor;
  let hasOlder = first.hasOlder;
  for (let page = 1; page < TIMELINE_MAX_PAGES && hasOlder && cursor !== null; page += 1) {
    const next = await handle.timeline.refetch({
      direction: "before",
      cursor,
      limit: TIMELINE_PAGE_SIZE,
    });
    pages.unshift(next.entries.map((entry) => entry.item));
    cursor = next.startCursor;
    hasOlder = next.hasOlder;
  }
  return pages.flat();
}
