import { useMutation, useQuery } from "@tanstack/react-query";
import { type PluginAgentPanelProps, useRpc } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import {
  fabricActorLogRpc,
  fabricActorTellRpc,
  fabricActorsListRpc,
} from "../shared/fabric";

function ActorRow({
  theme,
  agentId,
  name,
  status,
  detail,
  callLog,
  callTell,
  logData,
  logPending,
}: {
  theme: PluginAgentPanelProps["theme"];
  agentId: string;
  name: string;
  status: string;
  detail?: string;
  callLog: (input: { agentId: string; actorName: string }) => Promise<unknown>;
  callTell: (input: {
    parentAgentId: string;
    actorName: string;
    message: string;
  }) => Promise<unknown>;
  logData: { actorName: string; entries: string[]; note?: string } | undefined;
  logPending: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const styles = useMemo(
    () => ({
      row: {
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: 12,
        backgroundColor: theme.colors.surface1,
      },
      title: { color: theme.colors.foreground, fontWeight: "600" as const },
      meta: { color: theme.colors.foregroundMuted },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 8,
        color: theme.colors.foreground,
      },
      button: { padding: 10, borderRadius: 8, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground, textAlign: "center" as const },
      log: { color: theme.colors.foregroundMuted },
    }),
    [theme],
  );
  const showingLog = logData?.actorName === name;

  const handleTell = useCallback(() => {
    const message = draft.trim();
    if (!message) return;
    void callTell({ parentAgentId: agentId, actorName: name, message }).then(() => {
      setSent("Relayed to Main for delivery.");
      setDraft("");
    });
  }, [agentId, callTell, draft, name]);

  return (
    <View style={styles.row}>
      <Text style={styles.title}>{name}</Text>
      <Text style={styles.meta}>{[status, detail].filter(Boolean).join(" · ")}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Show log for ${name}`}
        onPress={() => void callLog({ agentId, actorName: name })}
        style={styles.button}
      >
        <Text style={styles.buttonText}>{logPending ? "Loading…" : "Show log"}</Text>
      </Pressable>
      {showingLog ? (
        <Text style={styles.log}>
          {logData.entries.length > 0 ? logData.entries.join("\n") : "(no entries)"}
          {logData.note ? `\n${logData.note}` : ""}
        </Text>
      ) : null}
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder={`Message ${name}…`}
        placeholderTextColor={theme.colors.foregroundMuted}
        style={styles.input}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Send message to ${name}`}
        onPress={handleTell}
        style={styles.button}
      >
        <Text style={styles.buttonText}>Send</Text>
      </Pressable>
      {sent ? <Text style={styles.meta}>{sent}</Text> : null}
    </View>
  );
}

export function FabricActorsPanel({ agentId, theme, layout }: PluginAgentPanelProps) {
  const listActors = useRpc(fabricActorsListRpc);
  const readLog = useRpc(fabricActorLogRpc);
  const tellActor = useRpc(fabricActorTellRpc);
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        gap: 12,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24 },
      detail: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );

  const actorsQuery = useQuery({
    queryKey: ["fabric-actors", agentId],
    queryFn: () => listActors({ agentId }),
  });
  const [logData, setLogData] = useState<
    { actorName: string; entries: string[]; note?: string } | undefined
  >();
  const logMutation = useMutation({
    mutationFn: (input: { agentId: string; actorName: string }) => readLog(input),
    onSuccess: (data) => setLogData(data),
  });
  const tellMutation = useMutation({
    mutationFn: (input: { parentAgentId: string; actorName: string; message: string }) =>
      tellActor(input),
  });

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Fabric actors</Text>
      {actorsQuery.isPending ? <Text style={styles.detail}>Loading actors…</Text> : null}
      {actorsQuery.error ? (
        <Text style={styles.error}>{actorsQuery.error.message}</Text>
      ) : null}
      {actorsQuery.data?.actors.length === 0 ? (
        <Text style={styles.detail}>
          No fabric actors seen in this agent&apos;s timeline yet.
        </Text>
      ) : null}
      {actorsQuery.data?.actors.map((actor) => (
        <ActorRow
          key={`${actor.source}:${actor.name}`}
          theme={theme}
          agentId={agentId}
          name={actor.name}
          status={actor.status}
          detail={actor.detail}
          callLog={(input) => logMutation.mutateAsync(input)}
          callTell={(input) => tellMutation.mutateAsync(input)}
          logData={logData}
          logPending={logMutation.isPending}
        />
      ))}
      {tellMutation.error ? (
        <Text style={styles.error}>{tellMutation.error.message}</Text>
      ) : null}
    </View>
  );
}
