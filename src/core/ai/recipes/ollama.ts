import type { Recipe } from '../types.ts';
import { probeOllama } from '../probes.ts';

/**
 * Ollama — the zero-cost local lane.
 *
 * Serves an OpenAI-compatible API on `http://localhost:11434/v1` by default.
 * Three deployment shapes, all the same recipe:
 *
 *   1. Local daemon (default)   — `ollama serve` on this machine.
 *   2. Remote daemon            — set `OLLAMA_BASE_URL=http://gpu-box:11434/v1`.
 *                                 Set `OLLAMA_API_KEY` too when the remote host
 *                                 sits behind an authenticating reverse proxy.
 *   3. Ollama Cloud             — `OLLAMA_BASE_URL=https://ollama.com/v1` plus
 *                                 `OLLAMA_API_KEY`. NOTE: cloud-suffixed model
 *                                 ids (`…-cloud`, `…:cloud`) run on Ollama's
 *                                 servers even when the base URL points at the
 *                                 LOCAL daemon — the daemon proxies them. Picking
 *                                 one sends brain content off-device; that is a
 *                                 privacy decision, not a performance one.
 *
 * All four touchpoints are declared, so a keyless install can run the full
 * brain — embeddings, query expansion, chat/`think`, and the subagent tool
 * loop — with no hosted API key anywhere.
 */
export const ollama: Recipe = {
  id: 'ollama',
  name: 'Ollama (local)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:11434/v1',
  auth_env: {
    required: [], // Ollama runs unauthenticated locally; users pass `ollama` as the key.
    optional: ['OLLAMA_BASE_URL', 'OLLAMA_API_KEY'],
    setup_url: 'https://ollama.ai',
  },
  touchpoints: {
    embedding: {
      // #2271: modern local embed models added so assertTouchpoint accepts them.
      models: [
        'nomic-embed-text',
        'mxbai-embed-large',
        'all-minilm',
        'qwen3-embed-8b',
        'snowflake-arctic-embed-l-v2',
        'bge-m3',
      ],
      // #2051: per-model native dims. Ollama serves models spanning 384..4096,
      // so the recipe-wide default_dims below is only correct for nomic. Without
      // this map `init --embedding-model ollama:bge-m3` built a 768-wide column
      // for a model that emits 1024, and the mismatch only surfaced at first
      // insert. Resolved via `embeddingDimsForModel()`; unlisted models still
      // fall back to default_dims, and trust_custom_dims keeps an explicit
      // --embedding-dimensions override working for models not named here.
      model_dims: {
        'nomic-embed-text': 768,
        'mxbai-embed-large': 1024,
        'all-minilm': 384,
        'qwen3-embed-8b': 4096,
        'snowflake-arctic-embed-l-v2': 1024,
        'bge-m3': 1024,
      },
      default_dims: 768, // nomic-embed-text native dim
      trust_custom_dims: true, // #2271: local models carry varied native dims
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-04-20',
      // Ollama's batch capacity depends on the locally loaded model + the
      // OLLAMA_NUM_PARALLEL config; no static cap to declare. v0.32 (#779).
      no_batch_cap: true,
    },
    // Same OpenAI-compatible endpoint as chat. Declared so an explicit
    // `expansion_model: ollama:<id>` resolves instead of silently dropping
    // expansion (the #1135 class). A small instruct model is the natural
    // pick — multi-query rewrites need no tool calling.
    expansion: {
      models: ['llama3.2', 'qwen3:4b', 'qwen3:8b', 'mistral-small3.2'],
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-08-08',
    },
    chat: {
      // Advisory, not an allowlist: `tier: 'openai-compat'` means
      // assertTouchpoint never rejects an unlisted id, so any model the
      // user has pulled works. These are the tool-calling-capable families
      // worth defaulting to — Ollama exposes tool calling only for models
      // whose template declares it, and the subagent loop is useless without.
      models: [
        'llama3.3',
        'llama3.1',
        'qwen3',
        'qwen3:8b',
        'qwen3:14b',
        'qwen3:32b',
        'qwen2.5',
        'mistral-small3.2',
        'mistral-nemo',
        'gpt-oss:20b',
        'gpt-oss:120b',
        'devstral',
      ],
      supports_tools: true,
      // The loop's crash-replay no longer depends on provider-native tool_use
      // ids (v0.38 D11 moved stable-id generation gbrain-side), so an
      // openai-compatible local backend is replay-safe. Tool-call QUALITY
      // still varies by model — a 4B model will loop badly where a 32B one
      // won't. That's a model-selection problem, not a capability gate.
      supports_subagent_loop: true,
      // No cross-request prompt cache. Ollama keeps the model resident and
      // reuses the KV cache for a shared prefix within a session, but there
      // is no Anthropic-style `cache_control` marker to honor, so the loop
      // must not inject one.
      supports_prompt_cache: false,
      // Ollama's OpenAI-compat layer accepts `response_format: json_object`
      // but does NOT honor a strict `json_schema`. Leaving this false routes
      // expansion through the schemaless text path, which it can satisfy.
      supports_structured_outputs: false,
      // Ollama truncates to the model's `num_ctx` (default 4096) unless the
      // Modelfile or `OLLAMA_CONTEXT_LENGTH` raises it. Declaring the
      // conservative default keeps the token-budget math honest; users who
      // raised it can override with `search.token_budget`.
      max_context_tokens: 4096,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-08-08',
    },
  },
  /**
   * Probe the OpenAI-compatible /v1/models endpoint. Caller passes the
   * resolved baseURL (from cfg.base_urls['ollama'] or env) so the probe
   * checks the same endpoint live traffic will use.
   */
  async probe(baseURL?: string) {
    const url = baseURL ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1';
    const result = await probeOllama(url);
    if (!result.reachable) {
      return {
        ready: false,
        hint: `Ollama not reachable at ${url}. Start it with \`ollama serve\`, or set OLLAMA_BASE_URL to a remote daemon.`,
      };
    }
    if (!result.models_endpoint_valid) {
      return {
        ready: false,
        hint: `Ollama reached but /v1/models returned an unexpected shape: ${result.error ?? 'unknown'}.`,
      };
    }
    return { ready: true };
  },
  setup_hint: 'Install Ollama from https://ollama.ai, then `ollama serve` and pull a model for each touchpoint you use — e.g. `ollama pull nomic-embed-text` (embeddings) and `ollama pull qwen3` (chat). Remote daemon or Ollama Cloud: set OLLAMA_BASE_URL (+ OLLAMA_API_KEY).',
};
