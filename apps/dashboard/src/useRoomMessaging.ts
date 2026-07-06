import { useEffect, useState } from 'react';

import { type DashboardRoomActivity, sendRoomMessage } from './api';
import {
  useSelectedRoomActivity,
  type RoomActivityMap,
} from './useRoomActivity';

export type PendingMessagesMap = Record<
  string,
  Array<DashboardRoomActivity['messages'][number]>
>;

interface UseRoomMessagingOptions {
  active: boolean;
  nickname: string;
  refresh: (showSpinner?: boolean) => Promise<void>;
  setError: (error: string | null) => void;
}

export function useRoomMessaging({
  active,
  nickname,
  refresh,
  setError,
}: UseRoomMessagingOptions): {
  handleRoomMessage: (
    roomJid: string,
    text: string,
    requestId: string,
  ) => Promise<boolean>;
  pendingMessages: PendingMessagesMap;
  roomActivity: RoomActivityMap;
  roomActivityLoading: boolean;
  roomMessageKey: string | null;
  selectedRoomJid: string | null;
  setSelectedRoomJid: (jid: string | null) => void;
} {
  const [roomMessageKey, setRoomMessageKey] = useState<string | null>(null);
  const [selectedRoomJid, setSelectedRoomJid] = useState<string | null>(null);
  const {
    refreshRoom: refreshRoomActivity,
    roomActivity,
    roomActivityLoading,
  } = useSelectedRoomActivity({
    active,
    selectedRoomJid: selectedRoomJid,
  });
  const [pendingMessages, setPendingMessages] = useState<PendingMessagesMap>(
    {},
  );

  async function handleRoomMessage(
    roomJid: string,
    text: string,
    requestId: string,
  ) {
    setRoomMessageKey(roomJid);
    const optimisticId = `opt:${requestId}`;
    const displayName = nickname || 'Web Dashboard';
    const optimisticMsg = {
      id: optimisticId,
      sender: 'me',
      senderName: displayName,
      content: text,
      timestamp: new Date().toISOString(),
      isFromMe: true,
      isBotMessage: false,
      sourceKind: 'human' as const,
    };
    setPendingMessages((prev) => ({
      ...prev,
      [roomJid]: [...(prev[roomJid] ?? []), optimisticMsg],
    }));
    try {
      await sendRoomMessage(roomJid, text, requestId, nickname || null);
      try {
        await refreshRoomActivity(roomJid);
      } catch {
        /* refresh will retry on next poll */
      }
      void refresh(false);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingMessages((prev) => {
        const list = prev[roomJid];
        if (!list) return prev;
        const next = list.filter((m) => m.id !== optimisticId);
        if (next.length === 0) {
          const { [roomJid]: _drop, ...rest } = prev;
          void _drop;
          return rest;
        }
        return { ...prev, [roomJid]: next };
      });
      return false;
    } finally {
      setRoomMessageKey(null);
    }
  }

  useEffect(() => {
    setPendingMessages((prev) => {
      const next: typeof prev = {};
      let changed = false;
      for (const [jid, list] of Object.entries(prev)) {
        const fetched = roomActivity[jid]?.messages ?? [];
        const confirmedKeys = new Set(
          fetched.map((m) => `${m.senderName}${m.content}`),
        );
        const remaining = list.filter(
          (m) => !confirmedKeys.has(`${m.senderName}${m.content}`),
        );
        if (remaining.length !== list.length) changed = true;
        if (remaining.length > 0) next[jid] = remaining;
      }
      return changed ? next : prev;
    });
  }, [roomActivity]);

  return {
    handleRoomMessage,
    pendingMessages,
    roomActivity,
    roomActivityLoading,
    roomMessageKey,
    selectedRoomJid,
    setSelectedRoomJid,
  };
}
