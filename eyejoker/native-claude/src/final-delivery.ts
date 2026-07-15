import { createHash } from "node:crypto";

export interface DeliveryPlan {
  chunks: string[];
  cursor: number;
  messageIds?: string[];
}

export function deliveryNonce(jobId: string, index: number): string {
  const hex = createHash("sha256").update(`${jobId}:${index}`).digest("hex").slice(0, 16);
  return BigInt(`0x${hex}`).toString(10);
}

export async function deliverPendingChunks(
  jobId: string,
  plan: DeliveryPlan,
  send: (index: number, content: string, nonce: string) => Promise<string>,
  markAccepted: (index: number, messageId: string) => Promise<void>,
): Promise<void> {
  for (let index = plan.cursor; index < plan.chunks.length; index += 1) {
    const messageId = await send(index, plan.chunks[index] ?? "", deliveryNonce(jobId, index));
    await markAccepted(index, messageId);
  }
}
