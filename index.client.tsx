import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FabricActorsPanel } from "./client/actors-panel";
import { FabricExecCard } from "./client/fabric-card";
import { transformFabricExec } from "./client/transform-fabric";
import { fabricExecDataSchema } from "./shared/fabric";

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "fabric-exec",
    query: { itemType: "tool_call" },
    transform: transformFabricExec,
  });
  client.addTimelineRenderer({
    kind: "fabric-exec",
    version: 1,
    schema: fabricExecDataSchema,
    Component: FabricExecCard,
  });
  client.addWorkspacePanel({
    id: "fabric-actors",
    title: "Fabric actors",
    icon: "Bot",
    context: "agent",
    Component: FabricActorsPanel,
  });
  client.addSlashCommand({
    name: "fabric-actors",
    description: "Show fabric actors for this agent",
    argumentHint: "",
    context: "agent",
    onSubmit({ openPanel }) {
      openPanel("fabric-actors");
    },
  });
  return () => {};
}
