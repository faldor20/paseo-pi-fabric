import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import {
  FABRIC_TOOL_NAME,
  fabricExecDataSchema,
  readFabricExecInput,
  summarizeFabricCode,
  summarizeFabricResult,
  type FabricExecData,
} from "../shared/fabric";

type FabricTransformer = PluginTimelineTransformerContribution<"tool_call">["transform"];

export const transformFabricExec: FabricTransformer = ({ item }) => {
  if (item.name !== FABRIC_TOOL_NAME || item.detail.type !== "unknown") {
    return;
  }
  const program = readFabricExecInput(item.detail.input);
  // Without program source there is nothing to summarize; keep the row.
  if (program === null) return;

  const { codePreview, lineCount, nestedCalls } = summarizeFabricCode(program.code);
  const data: FabricExecData = {
    codePreview,
    lineCount,
    ...(program.kernel ? { kernel: program.kernel } : {}),
    nestedCalls,
    agents: [],
    actors: [],
    resultTruncated: false,
    status:
      item.status === "running"
        ? "running"
        : item.status === "failed"
          ? "failed"
          : item.status === "canceled"
            ? "canceled"
            : "completed",
  };

  if (item.status !== "running") {
    const summary = summarizeFabricResult(item.detail.output);
    data.agents = summary.agents;
    data.actors = summary.actors;
    if (summary.resultPreview !== undefined) {
      data.resultPreview = summary.resultPreview;
    }
    data.resultTruncated = summary.resultTruncated;
  }

  const parsed = fabricExecDataSchema.safeParse(data);
  if (!parsed.success) return;
  return {
    items: [{ type: "plugin" as const, kind: "fabric-exec", version: 1, data: parsed.data }],
  };
};
