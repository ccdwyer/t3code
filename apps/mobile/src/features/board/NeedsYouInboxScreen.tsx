import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  EnvironmentId,
  type WorkflowNeedsAttentionTicketView,
} from "@t3tools/contracts";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { buildTicketRoutePath } from "../../lib/routes";
import { getEnvironmentClient } from "../../state/environment-session-registry";
import { useRemoteEnvironmentState } from "../../state/use-remote-environment-registry";

interface NeedsYouRow {
  readonly environmentId: EnvironmentId;
  readonly ticket: WorkflowNeedsAttentionTicketView;
}

function attentionLabel(ticket: WorkflowNeedsAttentionTicketView): string {
  switch (ticket.attentionKind) {
    case "waiting_for_approval":
      return "Needs approval";
    case "waiting_for_input":
      return "Needs input";
    case "blocked":
      return "Blocked";
    default:
      return ticket.status;
  }
}

function formatRelative(updatedAt: string): string {
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) {
    return "";
  }
  const deltaMs = Date.now() - then;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function NeedsYouInboxScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { environmentStateById } = useRemoteEnvironmentState();
  const [rows, setRows] = useState<readonly NeedsYouRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const environmentIds = useMemo(
    () => Object.keys(environmentStateById).map((id) => EnvironmentId.make(id)),
    [environmentStateById],
  );

  const load = useCallback(
    async (isActive: () => boolean) => {
      if (isActive()) {
        setError(null);
      }
      const aggregated: NeedsYouRow[] = [];
      const failures: string[] = [];

      await Promise.all(
        environmentIds.map(async (environmentId) => {
          const client = getEnvironmentClient(environmentId);
          if (!client) {
            return;
          }
          try {
            const tickets = await client.workflow.listNeedsAttentionTickets({});
            for (const ticket of tickets) {
              aggregated.push({ environmentId, ticket });
            }
          } catch (cause) {
            failures.push(cause instanceof Error ? cause.message : "Failed to load tickets.");
          }
        }),
      );

      if (!isActive()) {
        return;
      }

      aggregated.sort((a, b) => Date.parse(b.ticket.updatedAt) - Date.parse(a.ticket.updatedAt));
      setRows(aggregated);
      if (aggregated.length === 0 && failures.length > 0) {
        setError(failures[0] ?? "Failed to load tickets.");
      }
    },
    [environmentIds],
  );

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const isActive = () => !cancelled && mountedRef.current;
      setLoading(true);
      void load(isActive).finally(() => {
        if (isActive()) {
          setLoading(false);
        }
      });
      return () => {
        cancelled = true;
      };
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load(() => mountedRef.current).finally(() => {
      if (mountedRef.current) {
        setRefreshing(false);
      }
    });
  }, [load]);

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 20, gap: 12, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <Text className="font-t3-bold text-2xl text-foreground">Needs you</Text>

        {!loading && rows.length === 0 ? (
          <View className="flex-1 justify-center">
            <EmptyState
              title="You're all caught up"
              detail={error ?? "No tickets are waiting on you right now."}
            />
          </View>
        ) : null}

        {rows.map((row) => (
          <Pressable
            key={`${row.environmentId}:${row.ticket.ticketId}`}
            className="gap-1 rounded-[22px] border border-border bg-card p-4 active:opacity-70"
            onPress={() =>
              router.push(
                buildTicketRoutePath({
                  environmentId: row.environmentId,
                  boardId: row.ticket.boardId,
                  ticketId: row.ticket.ticketId,
                }),
              )
            }
          >
            <View className="flex-row items-center justify-between gap-2">
              <Text className="flex-1 font-t3-bold text-base text-foreground" numberOfLines={1}>
                {row.ticket.title}
              </Text>
              <Text className="font-sans text-xs text-foreground-muted">
                {formatRelative(row.ticket.updatedAt)}
              </Text>
            </View>
            <Text className="font-sans text-sm text-foreground-muted">{row.ticket.boardName}</Text>
            <View className="mt-1 self-start rounded-full bg-card-alt px-2.5 py-1">
              <Text className="font-t3-bold text-xs text-foreground">{attentionLabel(row.ticket)}</Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
