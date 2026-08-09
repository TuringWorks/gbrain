/**
 * Local / non-Anthropic provider support.
 *
 * The invariant under test is a single user-visible claim: a brain configured
 * for a local model must be able to run WITHOUT any hosted API key. Through
 * v0.42 that claim was false in four independent places, and each one is
 * pinned below so it can't silently come back:
 *
 *   1. `ollama` / `llama-server` declared embeddings only — no chat touchpoint,
 *      so synthesis could never route to a local model at all.
 *   2. `resolveTierDefault` (step 7 of the model-resolution chain) hardcoded
 *      `anthropic:*`, so a brain that correctly set `chat_model` to Ollama
 *      still resolved every tier to an unreachable Anthropic id.
 *   3. The subagent handler REFUSED non-Anthropic models unless an
 *      undiscoverable config key was set, even though the provider-agnostic
 *      gateway loop it was refusing to use supports them.
 *   4. The Anthropic SDK client was constructed at worker-REGISTRATION time,
 *      so a keyless brain threw before any routing decision was made.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getRecipe, listRecipes } from '../../src/core/ai/recipes/index.ts';
import { assertTouchpoint } from '../../src/core/ai/model-resolver.ts';
import {
  TIER_DEFAULTS,
  resolveTierDefault,
  _resetDeprecationWarningsForTest,
  type ModelTier,
} from '../../src/core/model-config.ts';
import { classifyCapabilities } from '../../src/core/ai/capabilities.ts';

// ── env/config isolation ────────────────────────────────────────────────────
// Same hazard `test/helpers/no-anthropic-key.ts` documents: a developer machine
// with a real key in ~/.gbrain/config.json makes the "no key" path untestable.
// These tests additionally need to WRITE a config, so they own a temp home
// rather than reusing that helper.

const _cleanups: Array<() => void> = [];

function withTempBrainHome(config: Record<string, unknown> | null): void {
  const origHome = process.env.GBRAIN_HOME;
  const origKey = process.env.ANTHROPIC_API_KEY;
  const tmp = mkdtempSync(join(tmpdir(), 'gbrain-local-providers-'));
  if (config) {
    mkdirSync(join(tmp, '.gbrain'), { recursive: true });
    writeFileSync(join(tmp, '.gbrain', 'config.json'), JSON.stringify(config), 'utf-8');
  }
  process.env.GBRAIN_HOME = tmp;
  delete process.env.ANTHROPIC_API_KEY;
  _cleanups.push(() => {
    if (origHome !== undefined) process.env.GBRAIN_HOME = origHome;
    else delete process.env.GBRAIN_HOME;
    if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
    else delete process.env.ANTHROPIC_API_KEY;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
}

afterEach(() => {
  while (_cleanups.length) _cleanups.pop()!();
  // resolveTierDefault memoizes its one-shot stderr notice; clear it so each
  // test observes a fresh resolution rather than a suppressed one.
  _resetDeprecationWarningsForTest();
});

// ── 1. local recipes can actually chat ──────────────────────────────────────

describe('local providers declare every touchpoint a brain needs', () => {
  test('ollama covers embedding + expansion + chat', () => {
    const r = getRecipe('ollama')!;
    expect(r.touchpoints.embedding).toBeDefined();
    expect(r.touchpoints.expansion).toBeDefined();
    expect(r.touchpoints.chat).toBeDefined();
  });

  test('ollama and llama-server chat can drive the subagent tool loop', () => {
    for (const id of ['ollama', 'llama-server']) {
      // classifyCapabilities is the gate the subagent queue + handler consult.
      // `degraded:no_caching` is the expected verdict — usable, just uncached.
      // Anything in the `unusable:*` / `unknown` family means the loop refuses
      // the job, which is the pre-fix behavior we are removing.
      const verdict = classifyCapabilities(`${id}:some-model`);
      expect(verdict, `${id} must be loop-capable`).toBe('degraded:no_caching');
    }
  });

  test('local chat is free — a nonzero cost would corrupt --max-usd pre-flights', () => {
    for (const id of ['ollama', 'llama-server']) {
      const chat = getRecipe(id)!.touchpoints.chat!;
      expect(chat.cost_per_1m_input_usd).toBe(0);
      expect(chat.cost_per_1m_output_usd).toBe(0);
    }
  });

  test('local recipes accept arbitrary model ids (the user pulled/launched it, not us)', () => {
    expect(() => assertTouchpoint(getRecipe('ollama')!, 'chat', 'qwen3:32b')).not.toThrow();
    expect(() => assertTouchpoint(getRecipe('llama-server')!, 'chat', 'whatever.gguf')).not.toThrow();
  });

  test('local recipes carry a reachability probe — a stopped daemon is the real failure mode', () => {
    // No key can be missing for a local provider, so key checks catch nothing.
    // The probe is what `gbrain doctor` uses instead.
    expect(typeof getRecipe('ollama')!.probe).toBe('function');
    expect(typeof getRecipe('llama-server')!.probe).toBe('function');
  });
});

// ── 2. tier resolution without an Anthropic credential ──────────────────────

const ALL_TIERS: ModelTier[] = ['utility', 'reasoning', 'deep', 'subagent'];

describe('resolveTierDefault — the step-7 fallback', () => {
  test('with an Anthropic key present, every tier is byte-identical to before', () => {
    withTempBrainHome({ chat_model: 'ollama:qwen3' });
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    for (const tier of ALL_TIERS) {
      expect(resolveTierDefault(tier)).toBe(TIER_DEFAULTS[tier]);
    }
  });

  test('with no key but a local chat_model, every tier resolves to the local model', () => {
    withTempBrainHome({ chat_model: 'ollama:qwen3' });
    for (const tier of ALL_TIERS) {
      expect(resolveTierDefault(tier)).toBe('ollama:qwen3');
    }
  });

  test('with no key and no chat_model, the Anthropic default stands', () => {
    // Deliberate: the resulting error names the missing key honestly. Someone
    // who has configured nothing has not chosen a local brain — they have an
    // unfinished setup, and inventing an Ollama default for them would fail
    // more confusingly (connection refused) than the truthful key error.
    withTempBrainHome({});
    for (const tier of ALL_TIERS) {
      expect(resolveTierDefault(tier)).toBe(TIER_DEFAULTS[tier]);
    }
  });

  test('an anthropic chat_model with no key is not dressed up as a substitution', () => {
    withTempBrainHome({ chat_model: 'anthropic:claude-sonnet-4-6' });
    expect(resolveTierDefault('reasoning')).toBe(TIER_DEFAULTS.reasoning);
  });

  test('an unreadable config falls back rather than throwing', () => {
    withTempBrainHome(null); // no config.json at all
    expect(() => resolveTierDefault('reasoning')).not.toThrow();
    expect(resolveTierDefault('reasoning')).toBe(TIER_DEFAULTS.reasoning);
  });

  test('a hosted non-Anthropic chat_model is honored too (not just local)', () => {
    // The fix is about "no Anthropic credential", not about "local" — a brain
    // on DeepSeek or xAI hit the exact same dead end.
    withTempBrainHome({ chat_model: 'deepseek:deepseek-chat' });
    expect(resolveTierDefault('reasoning')).toBe('deepseek:deepseek-chat');
  });
});

// ── 3. a local model survives the subagent tier gate ────────────────────────

describe('subagent tier accepts a local model', () => {
  test('resolveModel does not fall back to Anthropic for a local subagent model', async () => {
    withTempBrainHome({});
    const engine = {
      getConfig: async (k: string) => (k === 'models.tier.subagent' ? 'ollama:qwen3' : null),
    } as never;
    const { resolveModel } = await import('../../src/core/model-config.ts');
    const got = await resolveModel(engine, { tier: 'subagent', fallback: 'anthropic:claude-sonnet-4-6' });
    expect(got).toBe('ollama:qwen3');
  });

  test('the no-caching notice does not tell a free provider that Anthropic is cheaper', async () => {
    withTempBrainHome({});
    const written: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => { written.push(String(s)); return true; }) as typeof process.stderr.write;
    try {
      const engine = {
        getConfig: async (k: string) => (k === 'models.tier.subagent' ? 'ollama:qwen3' : null),
      } as never;
      const { resolveModel } = await import('../../src/core/model-config.ts');
      await resolveModel(engine, { tier: 'subagent', fallback: 'anthropic:claude-sonnet-4-6' });
    } finally {
      process.stderr.write = origWrite;
    }
    const notice = written.join('');
    expect(notice).toContain('prompt caching');
    // Local inference is free at the margin — a cost warning is simply wrong,
    // and it is what a deliberately-local brain would see on every process.
    expect(notice).not.toContain('For lower cost');
    expect(notice).not.toContain('cost scales linearly');
    expect(notice).toContain('slower');
  });
});

// ── 4. the new hosted providers ─────────────────────────────────────────────

describe('vibecody provider delta — xai / cerebras / fireworks / sambanova', () => {
  const NEW_IDS = ['xai', 'cerebras', 'fireworks', 'sambanova'];

  test('all four are registered', () => {
    const ids = new Set(listRecipes().map(r => r.id));
    for (const id of NEW_IDS) {
      expect(ids.has(id), `${id} not registered`).toBe(true);
    }
  });

  test('all four are chat-capable and loop-capable', () => {
    for (const id of NEW_IDS) {
      const chat = getRecipe(id)!.touchpoints.chat;
      expect(chat, `${id} must declare chat`).toBeDefined();
      expect(chat!.supports_tools).toBe(true);
      expect(chat!.supports_subagent_loop).toBe(true);
      expect(classifyCapabilities(`${id}:some-model`)).toBe('degraded:no_caching');
    }
  });

  test('all four require a key and pin a base URL', () => {
    for (const id of NEW_IDS) {
      const r = getRecipe(id)!;
      expect(r.auth_env?.required?.length, `${id} must require a key`).toBeGreaterThan(0);
      expect(r.base_url_default, `${id} must pin a base URL`).toBeTruthy();
      // createOpenAICompatible appends only the route, never the version
      // segment — a base URL missing /v1 silently 404s every call.
      expect(r.base_url_default!.endsWith('/v1')).toBe(true);
    }
  });

  test('providers with unpublished per-token rates report unknown, never a guess', () => {
    // Fabricating a rate is worse than admitting ignorance: it silently
    // corrupts --max-usd pre-flights and est_cost_usd audit rows.
    for (const id of ['cerebras', 'fireworks', 'sambanova']) {
      const chat = getRecipe(id)!.touchpoints.chat!;
      expect(chat.cost_per_1m_input_usd).toBeUndefined();
      expect(chat.cost_per_1m_output_usd).toBeUndefined();
    }
  });

  test('xai carries its published sub-200k tier rate', () => {
    const chat = getRecipe('xai')!.touchpoints.chat!;
    expect(chat.cost_per_1m_input_usd).toBeGreaterThan(0);
    expect(chat.cost_per_1m_output_usd).toBeGreaterThan(chat.cost_per_1m_input_usd!);
  });

  test('fireworks is the only one of the four that can also embed', () => {
    expect(getRecipe('fireworks')!.touchpoints.embedding).toBeDefined();
    for (const id of ['xai', 'cerebras', 'sambanova']) {
      expect(getRecipe(id)!.touchpoints.embedding, `${id} declares no embedding model`).toBeUndefined();
    }
  });
});
