/**
 * Mixture of Agents (MoA) — lightweight reference opinions.
 *
 * Queries external API models (Kimi, GLM, etc.) in parallel for their
 * opinions on the deadlock. These opinions are then injected into the
 * SDK-based arbiter's prompt so it can aggregate all perspectives.
 *
 * No extra SDK processes. The existing arbiter (Claude/Codex subscription)
 * naturally becomes the aggregator.
 */
import { logger } from './logger.js';

export interface MoaModelConfig {
  name: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** API format: 'openai' (default) or 'anthropic' (Messages API). */
  apiFormat: 'openai' | 'anthropic';
}

export interface MoaConfig {
  enabled: boolean;
  referenceModels: MoaModelConfig[];
}

export interface MoaReferenceResult {
  model: string;
  response: string;
  error?: string;
}

export interface MoaReferenceStatus {
  model: string;
  checkedAt: string;
  ok: boolean;
  error: string | null;
  responseLength?: number;
}

const referenceStatuses = new Map<string, MoaReferenceStatus>();

function normalizeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reject MoA base URLs that point at loopback / private / link-local hosts.
 *
 * MoA reference models are external SaaS endpoints (Kimi, GLM, ...). Allowing
 * an internal host lets a compromised or misconfigured settings write turn the
 * server-side MoA fetch into an SSRF probe (e.g. cloud metadata at
 * 169.254.169.254). Only http(s) to a non-private host is permitted.
 */
export function assertSafeMoaBaseUrl(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid MoA base URL: ${baseUrl}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`MoA base URL must use http(s): ${baseUrl}`);
  }
  if (isPrivateOrLocalHost(parsed.hostname)) {
    throw new Error(
      `MoA base URL host is not allowed (loopback/private/link-local): ${parsed.hostname}`,
    );
  }
  return parsed;
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    return true;
  }
  // IPv6 loopback / link-local / unique-local
  if (host === '::1' || host === '::') return true;
  if (
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127 || a === 0 || a === 10) return true; // loopback / this-host / private
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / tailnet
  }
  return false;
}

function recordReferenceStatus(
  status: Omit<MoaReferenceStatus, 'checkedAt'>,
): MoaReferenceStatus {
  const next: MoaReferenceStatus = {
    ...status,
    checkedAt: new Date().toISOString(),
  };
  referenceStatuses.set(status.model, next);
  return next;
}

export function getMoaReferenceStatuses(): MoaReferenceStatus[] {
  return [...referenceStatuses.values()];
}

async function queryModel(
  model: MoaModelConfig,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 60_000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    assertSafeMoaBaseUrl(model.baseUrl);
    const base = model.baseUrl.replace(/\/+$/, '');
    const isAnthropic = model.apiFormat === 'anthropic';

    const url = isAnthropic
      ? `${base}/v1/messages`
      : `${base}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (isAnthropic) {
      headers['x-api-key'] = model.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${model.apiKey}`;
    }

    const body = isAnthropic
      ? {
          model: model.model,
          system: systemPrompt,
          max_tokens: 2048,
          messages: [{ role: 'user', content: userPrompt }],
        }
      : {
          model: model.model,
          max_tokens: 2048,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const respBody = await response.text().catch(() => '');
      throw new Error(
        `${response.status} ${response.statusText}: ${respBody.slice(0, 200)}`,
      );
    }

    const data = await response.json();

    // Parse response based on format
    let content: string | undefined;
    if (isAnthropic) {
      const blocks = (data as { content?: { type: string; text: string }[] })
        .content;
      content = blocks
        ?.filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('');
    } else {
      content = (data as { choices?: { message?: { content?: string } }[] })
        .choices?.[0]?.message?.content;
    }

    if (!content) throw new Error('Empty response from model');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Query all reference models in parallel and return their opinions.
 * These are injected into the SDK arbiter's prompt — the arbiter
 * aggregates them into a final verdict.
 */
export async function collectMoaReferences(args: {
  config: MoaConfig;
  systemPrompt: string;
  contextPrompt: string;
}): Promise<MoaReferenceResult[]> {
  const { config, systemPrompt, contextPrompt } = args;

  logger.info(
    {
      models: config.referenceModels.map((m) => m.name),
    },
    'MoA: querying reference models for opinions',
  );

  const results = await Promise.allSettled(
    config.referenceModels.map((model) =>
      queryModel(model, systemPrompt, contextPrompt),
    ),
  );

  return results.map((result, i) => {
    const model = config.referenceModels[i].name;
    if (result.status === 'fulfilled') {
      recordReferenceStatus({
        model,
        ok: true,
        error: null,
        responseLength: result.value.length,
      });
      logger.info(
        { model, responseLen: result.value.length },
        'MoA: reference model responded',
      );
      return { model, response: result.value };
    }
    const error = normalizeError(result.reason);
    recordReferenceStatus({ model, ok: false, error });
    logger.warn({ model, error }, 'MoA: reference model failed');
    return { model, response: '', error };
  });
}

export async function probeMoaReferenceModel(
  model: MoaModelConfig,
): Promise<MoaReferenceStatus> {
  try {
    const response = await queryModel(
      model,
      'You are a configuration health check. Reply with a short plain-text OK.',
      'Reply exactly: OK',
      20_000,
    );
    return recordReferenceStatus({
      model: model.name,
      ok: true,
      error: null,
      responseLength: response.length,
    });
  } catch (err) {
    return recordReferenceStatus({
      model: model.name,
      ok: false,
      error: normalizeError(err),
    });
  }
}

/**
 * Format reference opinions into a section that gets appended
 * to the arbiter's prompt.
 */
export function formatMoaReferencesForPrompt(
  references: MoaReferenceResult[],
): string | null {
  const successful = references.filter((r) => !r.error && r.response);
  if (successful.length === 0) return null;

  const opinions = successful
    .map((r) => `### ${r.model}:\n${r.response}`)
    .join('\n\n---\n\n');

  return [
    '',
    `<moa-references count="${successful.length}">`,
    `The following ${successful.length} independent AI models have also reviewed this deadlock:`,
    '',
    opinions,
    '',
    'Consider these perspectives alongside the conversation. Where they agree, that strengthens the case.',
    'Where they disagree, weigh the evidence. Your verdict is final.',
    '</moa-references>',
  ].join('\n');
}
