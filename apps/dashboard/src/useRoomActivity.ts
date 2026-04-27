import { useCallback, useEffect, useState } from 'react';

import { fetchRoomTimeline, type DashboardRoomActivity } from './api';

export type RoomActivityMap = Record<string, DashboardRoomActivity>;

interface UseSelectedRoomActivityOptions {
  active: boolean;
  pollMs?: number;
  selectedRoomJid: string | null;
}

export function useSelectedRoomActivity({
  active,
  pollMs = 2000,
  selectedRoomJid,
}: UseSelectedRoomActivityOptions): {
  refreshRoom: (roomJid: string) => Promise<DashboardRoomActivity>;
  roomActivity: RoomActivityMap;
  roomActivityLoading: boolean;
} {
  const [roomActivity, setRoomActivity] = useState<RoomActivityMap>({});
  const [roomActivityLoading, setRoomActivityLoading] = useState(false);

  const refreshRoom = useCallback(async (roomJid: string) => {
    const activity = await fetchRoomTimeline(roomJid);
    setRoomActivity((previous) => ({
      ...previous,
      [roomJid]: activity,
    }));
    return activity;
  }, []);

  useEffect(() => {
    if (!active || !selectedRoomJid) {
      setRoomActivityLoading(false);
      return undefined;
    }

    let cancelled = false;
    let inFlight = false;
    let pollIntervalId: number | null = null;

    const fetchOnce = async (initial: boolean) => {
      if (cancelled || inFlight) return;
      inFlight = true;
      if (initial) setRoomActivityLoading(true);
      try {
        await refreshRoom(selectedRoomJid);
      } catch {
        /* Keep the last good timeline snapshot. */
      } finally {
        inFlight = false;
        if (!cancelled && initial) setRoomActivityLoading(false);
      }
    };

    void fetchOnce(true);
    pollIntervalId = window.setInterval(() => void fetchOnce(false), pollMs);

    return () => {
      cancelled = true;
      if (pollIntervalId !== null) window.clearInterval(pollIntervalId);
    };
  }, [active, pollMs, refreshRoom, selectedRoomJid]);

  return { refreshRoom, roomActivity, roomActivityLoading };
}
