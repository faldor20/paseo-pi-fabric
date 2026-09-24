import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import { fabricExecDataSchema, type FabricAgentStatus } from "../shared/fabric";

type FabricExecCardData = z.output<typeof fabricExecDataSchema>;

// Pi's compact TUI shows at most 8 nested calls before the expand hint.
const COLLAPSED_CALL_LIMIT = 8;

const statusMarker: Record<FabricExecCardData["status"], string> = {
  running: "◐",
  completed: "✓",
  failed: "✕",
  canceled: "○",
};

const callMarker = (success: boolean | undefined): string =>
  success === false ? "✕" : "›";

const agentMarker: Record<FabricAgentStatus, string> = {
  completed: "✓",
  failed: "✕",
  stopped: "■",
  timed_out: "◷",
  running: "◐",
  unknown: "•",
};

function callsMeta(data: FabricExecCardData): string | null {
  if (data.status === "running") return "Running…";
  if (data.calls.length > 0) {
    const failed = data.calls.filter((call) => call.success === false).length;
    const calls = `${data.calls.length} ${data.calls.length === 1 ? "call" : "calls"}`;
    return failed > 0 ? `${calls} · ${failed} failed` : calls;
  }
  if (data.resultPreview !== undefined) return "Evaluated";
  return null;
}

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
      description: { color: theme.colors.foregroundMuted },
      code: { color: theme.colors.foreground, fontFamily: "monospace" as const },
      row: { flexDirection: "row" as const, gap: 8 },
      marker: { color: theme.colors.accent },
      markerDim: { color: theme.colors.foregroundMuted },
      markerError: { color: theme.colors.statusDanger },
      rowText: { color: theme.colors.foreground, flex: 1 },
      rowDetail: { color: theme.colors.foregroundMuted, flex: 1 },
      subText: { color: theme.colors.foregroundMuted, flex: 1 },
      expander: { color: theme.colors.foregroundMuted },
      sectionLabel: { color: theme.colors.foregroundMuted, fontWeight: "600" as const },
    }),
    [theme],
  );
  const data = item.data;
  // Pi shows the return output inline on failure; otherwise it waits behind
  // the expander like the program source.
  const [showAllCalls, setShowAllCalls] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [showReturn, setShowReturn] = useState(data.status === "failed");
  const [showAgents, setShowAgents] = useState(false);

  const title = data.displayName ?? data.titleHint ?? "Fabric";
  const meta = callsMeta(data);
  const visibleCalls = showAllCalls ? data.calls : data.calls.slice(0, COLLAPSED_CALL_LIMIT);
  const hiddenCalls = data.calls.length - visibleCalls.length;
  const subtitle = data.displayDescription;
  const programLabel = [
    "Program",
    `${data.lineCount} ${data.lineCount === 1 ? "line" : "lines"}`,
    data.kernel ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  const hasAgents = data.agents.length > 0 || data.actors.length > 0;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.marker}>{statusMarker[data.status]}</Text>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        <Text style={styles.status}>{data.status}</Text>
      </View>
      {subtitle ? (
        <Text style={styles.description} numberOfLines={2}>
          {subtitle}
        </Text>
      ) : null}
      {meta ? <Text style={styles.meta}>{meta}</Text> : null}
      {visibleCalls.map((call, index) => (
        <View key={`${call.ref}-${index}`} style={styles.row}>
          <Text style={call.success === false ? styles.markerError : styles.markerDim}>
            {callMarker(call.success)}
          </Text>
          <Text style={styles.rowText} numberOfLines={2}>
            {call.tool}
            {call.detail ? <Text style={styles.rowDetail}> {call.detail}</Text> : null}
          </Text>
        </View>
      ))}
      {hiddenCalls > 0 && !showAllCalls ? (
        <Pressable onPress={() => setShowAllCalls(true)}>
          <Text style={styles.expander}>
            … {hiddenCalls} more {hiddenCalls === 1 ? "call" : "calls"}
          </Text>
        </Pressable>
      ) : null}
      <Pressable onPress={() => setShowCode((open) => !open)}>
        <Text style={styles.expander}>
          {showCode ? "▾" : "▸"} {programLabel}
        </Text>
      </Pressable>
      {showCode ? <Text style={styles.code}>{data.codePreview}</Text> : null}
      {hasAgents ? (
        <Pressable onPress={() => setShowAgents((open) => !open)}>
          <Text style={styles.expander}>
            {showAgents ? "▾" : "▸"} {data.agents.length}{" "}
            {data.agents.length === 1 ? "subagent" : "subagents"}
            {data.actors.length > 0
              ? ` · ${data.actors.length} ${data.actors.length === 1 ? "actor" : "actors"}`
              : ""}
          </Text>
        </Pressable>
      ) : null}
      {showAgents
        ? data.agents.map((agent, index) => {
            const label = [agent.name ?? "agent", agent.status, agent.model]
              .filter(Boolean)
              .join(" · ");
            return (
              <View key={`agent-${label}-${index}`} style={styles.row}>
                <Text style={styles.marker}>{agentMarker[agent.status]}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowText}>{label}</Text>
                  {agent.taskPreview ? (
                    <Text style={styles.subText} numberOfLines={2}>
                      {agent.taskPreview}
                    </Text>
                  ) : null}
                  {agent.resultPreview ? (
                    <Text style={styles.subText} numberOfLines={4}>
                      {agent.resultPreview}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })
        : null}
      {showAgents
        ? data.actors.map((actor, index) => {
            const label = [actor.name, actor.status].filter(Boolean).join(" · ");
            return (
              <View key={`actor-${label}-${index}`} style={styles.row}>
                <Text style={styles.marker}>•</Text>
                <Text style={styles.rowText}>{label}</Text>
              </View>
            );
          })
        : null}
      {data.resultPreview !== undefined ? (
        <Pressable onPress={() => setShowReturn((open) => !open)}>
          <Text style={styles.expander}>{showReturn ? "▾" : "▸"} Return</Text>
        </Pressable>
      ) : null}
      {showReturn && data.resultPreview !== undefined ? (
        <Text style={styles.subText}>
          {data.resultPreview}
          {data.resultTruncated ? "  (truncated)" : ""}
        </Text>
      ) : null}
    </View>
  );
}
