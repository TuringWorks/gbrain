/**
 * Local-model discovery for tier assignment.
 *
 * `resolveTierDefault` gives a keyless brain ONE model for all four tiers.
 * That works but wastes the local fleet: a 3B model is the right utility-tier
 * classifier and the wrong deep-tier reasoner, and vice versa. This module
 * discovers what the user has actually pulled and proposes a per-tier mapping.
 *
 * The design constraint that shapes everything here: **model resolution must
 * stay a pure config read.** Discovery therefore runs ONCE, at setup, and
 * writes `models.tier.*`; it is never consulted from the resolution path. A
 * network round-trip in front of every unconfigured LLM call would be a far
 * worse regression than the imperfect defaults it fixed.
 *
 * Ollama-only, deliberately. It is the one local provider exposing an
 * authoritative per-model capability list (`/api/show` → `capabilities`).
 * `llama-server` serves a single model chosen at launch, so there is nothing
 * to rank; LiteLLM proxies arbitrary backends and exposes no capability API.
 * Both keep the single-model behavior.
 *
 * NOTE: `/api/tags`, `/api/show` and `/api/ps` are Ollama-NATIVE endpoints,
 * not the OpenAI-compatible surface the gateway uses. The recipe's base URL
 * ends in `/v1`; `ollamaApiRoot()` strips it.
 */

import type { ModelTier } from '../model-config.ts';

/** One model as the Ollama daemon reports it. */
export interface LocalModelInfo {
  /** Ollama model id, e.g. `qwen3:32b`. Use verbatim — tags are significant. */
  name: string;
  /** Declared capabilities, e.g. ['completion','tools','thinking']. */
  capabilities: string[];
  /** On-disk size in bytes. The ranking signal — see chatCapable's doc. */
  bytes: number;
  /** Reported parameter count, e.g. '20.9B'. Absent for some builds (MLX). */
  parameterSize?: string;
  /** Context length the model was TRAINED for. Not necessarily what is served. */
  trainedContext?: number;
  /**
   * Usable as a chat / subagent model.
   *
   * Requires BOTH `completion` and `tools`, and the conjunction is
   * load-bearing rather than defensive: several embedding models advertise
   * `tools` WITHOUT `completion` (e.g. `qwen3-embedding:8b` reports
   * `[tools,embedding]`). Filtering on `tools` alone admits a multi-billion
   * parameter embedding model into a chat tier, where it ranks high by size
   * and cannot generate text at all.
   */
  chatCapable: boolean;
}

export interface TierAssignment {
  tiers: Record<ModelTier, string>;
  /** Human-readable justification per tier, for the command's output. */
  reasons: Record<ModelTier, string>;
  /** Models considered but rejected, with why. Surfaced so the pick is auditable. */
  rejected: Array<{ name: string; reason: string }>;
}

/** Strip the OpenAI-compat `/v1` suffix to reach Ollama's native API root. */
export function ollamaApiRoot(baseURL: string): string {
  return baseURL.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

async function getJson(url: string, timeoutMs: number, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the `*.context_length` entry out of Ollama's model_info bag. */
function trainedContextFrom(modelInfo: Record<string, unknown> | undefined): number | undefined {
  if (!modelInfo) return undefined;
  const key = Object.keys(modelInfo).find(k => k.endsWith('.context_length'));
  if (!key) return undefined;
  const v = modelInfo[key];
  return typeof v === 'number' && v > 0 ? v : undefined;
}

/**
 * Enumerate the daemon's models with capabilities. One `/api/tags` call plus
 * one `/api/show` per model — metadata only, nothing is loaded into memory.
 */
export async function discoverOllamaModels(
  baseURL: string,
  opts: { timeoutMs?: number } = {},
): Promise<LocalModelInfo[]> {
  const root = ollamaApiRoot(baseURL);
  const timeoutMs = opts.timeoutMs ?? 5000;
  const tags = await getJson(`${root}/api/tags`, timeoutMs);
  const models: LocalModelInfo[] = [];
  for (const m of tags.models ?? []) {
    let capabilities: string[] = [];
    let trainedContext: number | undefined;
    try {
      const show = await getJson(`${root}/api/show`, timeoutMs, {
        method: 'POST',
        body: JSON.stringify({ model: m.name }),
        headers: { 'content-type': 'application/json' },
      });
      capabilities = Array.isArray(show.capabilities) ? show.capabilities : [];
      trainedContext = trainedContextFrom(show.model_info);
    } catch {
      // A model whose /api/show fails stays in the list with no capabilities,
      // so it is rejected rather than silently dropped from the audit trail.
    }
    models.push({
      name: m.name,
      capabilities,
      bytes: typeof m.size === 'number' ? m.size : 0,
      ...(m.details?.parameter_size ? { parameterSize: m.details.parameter_size } : {}),
      ...(trainedContext !== undefined ? { trainedContext } : {}),
      chatCapable: capabilities.includes('completion') && capabilities.includes('tools'),
    });
  }
  return models;
}

/**
 * Observe the context length the daemon actually SERVES, which is
 * `min(trained context, OLLAMA_CONTEXT_LENGTH)`.
 *
 * This matters more than the trained context and is the number budget math
 * needs. An un-tuned daemon serves 4096 while the model advertises 131072;
 * recording the trained value there makes gbrain send a prompt Ollama
 * silently truncates, and a truncated prompt loses the retrieved context at
 * the front — plausible answers, missing evidence, no error anywhere.
 *
 * Only `/api/ps` reveals it, and only for a LOADED model. We read whatever is
 * already resident (free) rather than loading anything: a caller that wants a
 * reading for a cold model must load it first.
 *
 * Returns the smallest served length observed among CHAT-CAPABLE models. The
 * chat-capable filter is not a detail — embedding models carry tiny contexts
 * (nomic-embed-text is trained for 2048), and a plain minimum across
 * everything resident clamps every chat tier to an embedder's window. Taking
 * the minimum is the right instinct (under-reporting costs capacity,
 * over-reporting costs correctness) but only within the population the number
 * describes.
 *
 * `opts.models` is what identifies chat-capability, so a caller that omits it
 * gets no reading rather than a wrong one.
 */
export async function observeServedContext(
  baseURL: string,
  opts: { timeoutMs?: number; models?: LocalModelInfo[] } = {},
): Promise<ServedContextObservation> {
  const root = ollamaApiRoot(baseURL);
  const chatNames = new Set((opts.models ?? []).filter(m => m.chatCapable).map(m => m.name));
  try {
    const ps = await getJson(`${root}/api/ps`, opts.timeoutMs ?? 5000);
    const loaded = (ps.models ?? []).filter(
      (m: any) => typeof m.context_length === 'number' && chatNames.has(m.name),
    );
    if (loaded.length === 0) return { definitive: false };
    const best = loaded.reduce((a: any, b: any) => (a.context_length <= b.context_length ? a : b));
    // Definitiveness: if the observed model was served LESS than it was
    // trained for, the daemon cap is exactly that number. If it was served
    // its full trained length, we learned only that the cap is at least that
    // — a bigger model might legitimately get more. Callers clamp either way
    // (under-reporting is the safe direction) but should say which they have.
    const trained = opts.models?.find(m => m.name === best.name)?.trainedContext;
    return {
      servedContext: best.context_length,
      observedFrom: best.name,
      definitive: trained !== undefined && best.context_length < trained,
    };
  } catch {
    return { definitive: false };
  }
}

export interface ServedContextObservation {
  /** Context length the daemon served for `observedFrom`. */
  servedContext?: number;
  /** Which loaded model the reading came from. */
  observedFrom?: string;
  /**
   * True when `servedContext` is the daemon's actual cap (the observed model
   * was clamped below its trained length). False when it is only a lower
   * bound — the observed model got everything it asked for, so a larger model
   * may be allowed more than this reading suggests.
   */
  definitive: boolean;
}

/**
 * Effective usable context for a model: the trained length, clamped by what
 * the daemon was observed to serve. Unknowns fall through to the other value,
 * and when both are unknown the caller keeps its own conservative default.
 */
export function effectiveContext(
  model: Pick<LocalModelInfo, 'trainedContext'>,
  servedContext?: number,
): number | undefined {
  if (model.trainedContext !== undefined && servedContext !== undefined) {
    return Math.min(model.trainedContext, servedContext);
  }
  return model.trainedContext ?? servedContext;
}

/**
 * Assign the four tiers from a discovered fleet. Pure — no I/O — so the policy
 * is testable against fixtures without a daemon.
 *
 * Ranking is by on-disk BYTES, not `parameterSize`: quantized and MLX builds
 * frequently omit the parameter count entirely (every `*-mlx` model in a real
 * fleet reported none), so a parameter-based sort silently drops them to the
 * bottom. Bytes are always present and correlate with capability within a
 * fleet. It is a proxy, not a quality ranking — a 9B tuned for reasoning may
 * well beat a 12B generalist, which is why the assignment is printed for
 * review and every tier stays overridable.
 */
export function rankForTiers(models: LocalModelInfo[]): TierAssignment | null {
  const rejected: Array<{ name: string; reason: string }> = [];
  const chat: LocalModelInfo[] = [];
  for (const m of models) {
    if (m.chatCapable) { chat.push(m); continue; }
    const why = m.capabilities.includes('embedding')
      ? m.capabilities.includes('tools')
        ? 'embedding model (advertises tools but has no completion)'
        : 'embedding model'
      : m.capabilities.length === 0
        ? 'capabilities unavailable'
        : `no tool calling (${m.capabilities.join(',')})`;
    rejected.push({ name: m.name, reason: why });
  }
  if (chat.length === 0) return null;

  const bySizeDesc = [...chat].sort((a, b) => b.bytes - a.bytes);
  const largest = bySizeDesc[0];
  // With three or more, the workhorse is the runner-up: the largest model is
  // reserved for the deep tier, where its latency is the point rather than a
  // tax paid on every ordinary call.
  const workhorse = bySizeDesc.length >= 3 ? bySizeDesc[1] : largest;
  // Utility runs classification and verdicts, where `thinking` is pure
  // overhead — it spends reasoning tokens on a job whose answer is a label.
  // Prefer the smallest NON-thinking model, falling back to the smallest.
  const bySizeAsc = [...bySizeDesc].reverse();
  const utility = bySizeAsc.find(m => !m.capabilities.includes('thinking')) ?? bySizeAsc[0];

  const q = (m: LocalModelInfo) => `ollama:${m.name}`;
  const gb = (m: LocalModelInfo) => `${(m.bytes / 1e9).toFixed(1)}GB`;

  return {
    tiers: {
      utility: q(utility),
      reasoning: q(workhorse),
      deep: q(largest),
      subagent: q(workhorse),
    },
    reasons: {
      utility: utility.capabilities.includes('thinking')
        ? `${gb(utility)}, smallest tool-capable (every candidate has thinking)`
        : `${gb(utility)}, smallest tool-capable without thinking`,
      reasoning: `${gb(workhorse)}, ${bySizeDesc.length >= 3 ? 'runner-up by size' : 'largest available'}`,
      deep: `${gb(largest)}, largest tool-capable`,
      subagent: `${gb(workhorse)}, same workhorse — the tool loop needs reliability, not peak size`,
    },
    rejected,
  };
}
