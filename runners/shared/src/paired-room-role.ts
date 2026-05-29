export const PAIRED_ROOM_ROLES = ['owner', 'reviewer', 'arbiter'] as const;

export type PairedRoomRole = (typeof PAIRED_ROOM_ROLES)[number];

export function isPairedRoomRole(value: unknown): value is PairedRoomRole {
  return value === 'owner' || value === 'reviewer' || value === 'arbiter';
}

export function normalizePairedRoomRole(
  value: unknown,
): PairedRoomRole | undefined {
  return isPairedRoomRole(value) ? value : undefined;
}

export function normalizePairedRoomRoleOrNull(
  value: unknown,
): PairedRoomRole | null {
  return normalizePairedRoomRole(value) ?? null;
}
