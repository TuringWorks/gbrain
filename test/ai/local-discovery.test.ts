/**
 * Local-model discovery + tier ranking.
 *
 * `rankForTiers` is pure, so the policy is pinned here against fixtures rather
 * than against whatever happens to be pulled on the machine running CI.
 *
 * The fixture is modelled on a real fleet, including the trap that motivated
 * the `completion AND tools` predicate: several Ollama embedding models
 * advertise `tools` without `completion`, and the largest of them outranks
 * most genuine chat models by size.
 */

import { describe, expect, test } from 'bun:test';
import {
  rankForTiers,
  effectiveContext,
  ollamaApiRoot,
  type LocalModelInfo,
} from '../../src/core/ai/local-discovery.ts';

function model(
  name: string,
  caps: string[],
  gb: number,
  trainedContext?: number,
): LocalModelInfo {
  return {
    name,
    capabilities: caps,
    bytes: gb * 1e9,
    ...(trainedContext !== undefined ? { trainedContext } : {}),
    chatCapable: caps.includes('completion') && caps.includes('tools'),
  };
}

/** Mirrors a real fleet: 7 chat-capable models and 7 embedders. */
const FLEET: LocalModelInfo[] = [
  model('qwen3.6:35b-mlx', ['completion', 'vision', 'thinking', 'tools'], 21.9, 262144),
  model('gpt-oss:20b', ['completion', 'tools', 'thinking'], 13.8, 131072),
  model('gemma4:12b-mlx', ['completion', 'tools', 'thinking'], 7.7, 262144),
  model('ornith:latest', ['completion', 'tools', 'thinking'], 5.6, 262144),
  model('lfm2.5:latest', ['completion', 'tools', 'thinking'], 5.2, 128000),
  model('granite4.1:3b', ['completion', 'tools'], 2.1, 131072),
  model('llama3.2:latest', ['completion', 'tools'], 2.0, 131072),
  // The trap: 7.6B, advertises tools, cannot generate text.
  model('qwen3-embedding:8b', ['tools', 'embedding'], 4.7, 40960),
  model('qwen3-embedding:4b', ['tools', 'embedding'], 2.5, 40960),
  model('qwen3-embedding:0.6b', ['tools', 'thinking', 'embedding'], 0.6, 40960),
  model('nomic-embed-text:latest', ['embedding'], 0.3, 2048),
  model('mxbai-embed-large:335m', ['embedding'], 0.7, 512),
  model('embeddinggemma:latest', ['embedding'], 0.6, 2048),
  model('nomic-embed-text-v2-moe:latest', ['embedding'], 1.0, 2048),
];

describe('rankForTiers — embedding models never reach a chat tier', () => {
  test('a tools-advertising embedding model is rejected, not ranked', () => {
    const a = rankForTiers(FLEET)!;
    const assigned = Object.values(a.tiers);
    for (const id of assigned) {
      expect(id, 'no embedding model may be assigned').not.toContain('embedding');
    }
    // And the rejection is explained, not silent — the reason has to name the
    // actual disqualifier so a user can tell it from "model not pulled".
    const trap = a.rejected.find(r => r.name === 'qwen3-embedding:8b');
    expect(trap).toBeDefined();
    expect(trap!.reason).toContain('no completion');
  });

  test('filtering on tools alone WOULD have picked one (the trap is real)', () => {
    // Guards the predicate itself: if someone relaxes `completion AND tools`
    // to just `tools`, this documents exactly what breaks.
    const toolsOnly = FLEET.filter(m => m.capabilities.includes('tools'))
      .sort((a, b) => b.bytes - a.bytes);
    const wouldRank = toolsOnly.map(m => m.name);
    expect(wouldRank).toContain('qwen3-embedding:8b');
    // It outranks four genuine chat models by size.
    expect(wouldRank.indexOf('qwen3-embedding:8b')).toBeLessThan(wouldRank.indexOf('granite4.1:3b'));
  });

  test('all 7 embedders are rejected and all 7 chat models are candidates', () => {
    const a = rankForTiers(FLEET)!;
    expect(a.rejected).toHaveLength(7);
    expect(new Set(Object.values(a.tiers)).size).toBeGreaterThanOrEqual(3);
  });
});

describe('rankForTiers — tier policy', () => {
  const a = rankForTiers(FLEET)!;

  test('deep gets the largest chat model', () => {
    expect(a.tiers.deep).toBe('ollama:qwen3.6:35b-mlx');
  });

  test('reasoning gets the runner-up, so deep-tier latency is not paid on every call', () => {
    expect(a.tiers.reasoning).toBe('ollama:gpt-oss:20b');
    expect(a.tiers.reasoning).not.toBe(a.tiers.deep);
  });

  test('subagent shares the reasoning workhorse', () => {
    expect(a.tiers.subagent).toBe(a.tiers.reasoning);
  });

  test('utility prefers the smallest NON-thinking model', () => {
    // Classification returns a label; reasoning tokens are pure overhead.
    // llama3.2 (2.0GB, no thinking) beats granite (2.1GB, no thinking) on size.
    expect(a.tiers.utility).toBe('ollama:llama3.2:latest');
  });

  test('utility falls back to smallest when every candidate thinks', () => {
    const allThinking = FLEET.filter(m => m.chatCapable && m.capabilities.includes('thinking'));
    const b = rankForTiers(allThinking)!;
    expect(b.tiers.utility).toBe('ollama:lfm2.5:latest'); // 5.2GB, smallest
    expect(b.reasons.utility).toContain('every candidate has thinking');
  });
});

describe('rankForTiers — degenerate fleets', () => {
  test('a single chat model maps every tier to it (matches the no-profile behavior)', () => {
    const one = [model('qwen3', ['completion', 'tools'], 5)];
    const a = rankForTiers(one)!;
    expect(new Set(Object.values(a.tiers))).toEqual(new Set(['ollama:qwen3']));
  });

  test('two chat models do not strand the reasoning tier on the smaller one', () => {
    const two = [
      model('big', ['completion', 'tools'], 20),
      model('small', ['completion', 'tools'], 2),
    ];
    const a = rankForTiers(two)!;
    expect(a.tiers.deep).toBe('ollama:big');
    expect(a.tiers.reasoning).toBe('ollama:big'); // runner-up rule needs 3+
    expect(a.tiers.utility).toBe('ollama:small');
  });

  test('no chat-capable model returns null rather than a bogus assignment', () => {
    expect(rankForTiers(FLEET.filter(m => !m.chatCapable))).toBeNull();
    expect(rankForTiers([])).toBeNull();
  });

  test('ranks by bytes, so quantized/MLX builds with no parameter_size still place', () => {
    // Every *-mlx model in a real fleet reported no parameter_size; a
    // parameter-based sort would silently drop them to the bottom.
    const mlx = FLEET.filter(m => m.chatCapable && m.name.includes('mlx'));
    expect(mlx.length).toBeGreaterThan(0);
    for (const m of mlx) expect(m.parameterSize).toBeUndefined();
    expect(rankForTiers(FLEET)!.tiers.deep).toBe('ollama:qwen3.6:35b-mlx');
  });
});

describe('effectiveContext — clamp to what the daemon serves', () => {
  test('clamps a model trained higher than the daemon serves', () => {
    // The dangerous direction: an un-tuned daemon serves 4096 while the model
    // advertises 131072. Recording the trained value makes gbrain send a
    // prompt Ollama silently truncates from the front, losing the retrieved
    // context with no error anywhere.
    expect(effectiveContext({ trainedContext: 131072 }, 4096)).toBe(4096);
  });

  test('does not inflate a model trained below what the daemon allows', () => {
    expect(effectiveContext({ trainedContext: 8192 }, 131072)).toBe(8192);
  });

  test('falls through when either side is unknown', () => {
    expect(effectiveContext({ trainedContext: 8192 }, undefined)).toBe(8192);
    expect(effectiveContext({}, 4096)).toBe(4096);
    expect(effectiveContext({}, undefined)).toBeUndefined();
  });
});

describe('ollamaApiRoot — native endpoints live beside the OpenAI-compat surface', () => {
  test('strips the /v1 suffix the gateway base URL carries', () => {
    expect(ollamaApiRoot('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(ollamaApiRoot('http://localhost:11434/v1/')).toBe('http://localhost:11434');
  });

  test('leaves a root without /v1 alone, and never leaves a trailing slash', () => {
    expect(ollamaApiRoot('http://gpu-box:11434')).toBe('http://gpu-box:11434');
    expect(ollamaApiRoot('http://gpu-box:11434/')).toBe('http://gpu-box:11434');
  });
});
