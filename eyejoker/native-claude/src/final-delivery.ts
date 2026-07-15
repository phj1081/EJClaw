import { createHash } from "node:crypto";
import type { OutboundFile } from "./types";

export interface DeliveryPlan {
  chunks: string[];
  cursor: number;
  messageIds?: string[];
  files?: OutboundFile[];
}

export function deliveryNonce(jobId: string, index: number): string {
  const hex = createHash("sha256").update(`${jobId}:${index}`).digest("hex").slice(0, 16);
  return BigInt(`0x${hex}`).toString(10);
}

export async function deliverPendingChunks(
  jobId: string,
  plan: DeliveryPlan,
  send: (index: number, content: string, nonce: string, files: OutboundFile[]) => Promise<string>,
  markSent: (index: number, messageId: string) => Promise<void> | void,
): Promise<void> {
  for (let index = plan.cursor; index < plan.chunks.length; index += 1) {
    const content = plan.chunks[index]!;
    const files = index === 0 ? (plan.files ?? []) : [];
    const messageId = await send(index, content, deliveryNonce(jobId, index), files);
    await markSent(index, messageId);
  }
}
