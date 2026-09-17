import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { z } from "zod";
import { fabricExecDataSchema, type FabricAgentStatus } from "../shared/fabric";

type FabricExecCardData = z.output<typeof fabricExecDataSchema>;

const statusMarker: Record<FabricExecCardData["status"], string> = {
  running: "◐",
  completed: "✓",
  failed: "✕",
  canceled: "○",
};

const agentMarker: Record<FabricAgentStatus, string> = {
  completed: "✓",
  failed: "✕",
  stopped: "■",
  timed_out: "◷",
  running: "◐",
  unknown: "•",
};

export function FabricExecCard({ item, theme }: PluginTimelineItemProps<FabricExecCardData>) {
  const styles = useMemo(
    () => ({
      card: {
        gap: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: 12,
        backgroundColor: theme.colors.surface1,
      },
      header: { flexDirection: "row" as const, gap: 8, alignItems: "center" as const },
      title: { color: theme.colors.foreground, fontWeight: "600" as const, flex: 1 },
      status: { color: theme.colors.foregroundMuted },
      meta: { color: theme.colors.foregroundMuted },
      code: { color: theme.colors.foreground, fontFamily: "monospace" as const },
      row: { flexDirection: "row" as const, gap: 8 },
      marker: { color: theme.colors.accent },
      rowText: { color: theme.colors.foreground, flex: 1 },
      subText: { color: theme.colors.foregroundMuted, flex: 1 },
    }),
    [theme],
  );
  const data = item.data;
  const subtitle = [
    `${data.lineCount} lines`,
    data.kernel ? `${data.kernel} kernel` : null,
    `${data.nestedCalls.length} refs`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.marker}>{statusMarker[data.status]}</Text>
        <Text style={styles.title}>Fabric program</Text>
        <Text style={styles.status}>{data.status}</Text>
      </View>
      <Text style={styles.meta}>{subtitle}</Text>
      <Text style={styles.code} numberOfLines={8}>
        {data.codePreview}
      </Text>
      {data.nestedCalls.length > 0 ? (
        <Text style={styles.meta}>
          {data.nestedCalls.map((call) => `${call.ref}×${call.count}`).join("  ")}
        </Text>
      ) : null}
      {data.agents.map((agent, index) => {
        const label = [agent.name ?? "agent", agent.status, agent.model]
          .filter(Boolean)
          .join(" · ");
        return (
          <View key={`agent-${label}-${index}`} style={styles.row}>
            <Text style={styles.marker}>{agentMarker[agent.status]}</Text>
            <Text style={styles.rowText}>{label}</Text>
          </View>
        );
      })}
      {data.actors.map((actor, index) => {
        const label = [actor.name, actor.status].filter(Boolean).join(" · ");
        return (
          <View key={`actor-${label}-${index}`} style={styles.row}>
            <Text style={styles.marker}>•</Text>
            <Text style={styles.rowText}>{label}</Text>
          </View>
        );
      })}
      {data.resultPreview ? (
        <Text style={styles.subText} numberOfLines={6}>
          {data.resultPreview}
          {data.resultTruncated ? "  (truncated)" : ""}
        </Text>
      ) : null}
    </View>
  );
}
