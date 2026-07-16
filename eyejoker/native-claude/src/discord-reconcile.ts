export interface ReconcileMessage {
  id: string;
  nonce: string | number | null | undefined;
  createdTimestamp: number;
  author: { id: string };
}

export interface ReconcileMessageCollection<T extends ReconcileMessage = ReconcileMessage> {
  size: number;
  values(): IterableIterator<T>;
}

export interface ReconcileMessageFetcher<T extends ReconcileMessage = ReconcileMessage> {
  fetch(options: { limit: number; before?: string; cache?: boolean }): Promise<ReconcileMessageCollection<T>>;
}

export interface NonceReconcileOptions {
  pageSize?: number;
  maxPages?: number;
  clockSkewMs?: number;
}

export async function findBotMessageByNonce<T extends ReconcileMessage>(
  messages: ReconcileMessageFetcher<T>,
  botUserId: string,
  nonce: string,
  notBeforeMs: number,
  options: NonceReconcileOptions = {},
): Promise<T | null> {
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 1_000;
  const clockSkewMs = options.clockSkewMs ?? 5 * 60 * 1_000;
  if (!Number.isFinite(notBeforeMs)) throw new Error(`invalid outbox reconciliation timestamp: ${notBeforeMs}`);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error(`invalid Discord reconciliation page size: ${pageSize}`);
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`invalid Discord reconciliation max pages: ${maxPages}`);
  }

  const lowerBound = notBeforeMs - clockSkewMs;
  let before: string | undefined;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await messages.fetch({
      limit: pageSize,
      ...(before ? { before } : {}),
      cache: false,
    });
    const entries = [...page.values()];
    if (entries.length === 0) return null;

    const matched = entries.find(
      (message) =>
        message.author.id === botUserId &&
        String(message.nonce ?? "") === nonce &&
        message.createdTimestamp >= lowerBound,
    );
    if (matched) return matched;

    const oldest = entries.reduce((candidate, message) =>
      message.createdTimestamp < candidate.createdTimestamp ? message : candidate,
    );
    if (oldest.createdTimestamp < lowerBound || page.size < pageSize) return null;
    if (oldest.id === before) throw new Error(`Discord reconciliation pagination did not advance nonce=${nonce}`);
    before = oldest.id;
  }

  throw new Error(`Discord reconciliation exceeded ${maxPages} pages nonce=${nonce}; refusing duplicate send`);
}
