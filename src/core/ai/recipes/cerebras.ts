import type { Recipe } from '../types.ts';

/**
 * Cerebras Inference — wafer-scale hardware, the fastest tokens/sec tier
 * available. Same role in the routing table as Groq: the latency lane.
 *
 * Chat + expansion only; Cerebras serves no embedding model.
 *
 * NOTE on the base URL: Cerebras documents the host as
 * `https://api.cerebras.ai` and the OpenAI-compatible routes under `/v1`.
 * The recipe pins the `/v1` suffix because `createOpenAICompatible` appends
 * only the route (`/chat/completions`), never the version segment.
 *
 * NOTE on pricing: Cerebras does not publish per-1M-token rates on its public
 * pricing page (self-serve starts at a $10 credit; per-model rates live behind
 * the dashboard). `cost_per_1m_*` is therefore left undefined rather than
 * guessed — same choice litellm-proxy makes. Cost views treat undefined as
 * "unknown", which is honest; a fabricated number would silently corrupt
 * `--max-usd` pre-flights.
 */
export const cerebras: Recipe = {
  id: 'cerebras',
  name: 'Cerebras Inference',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.cerebras.ai/v1',
  auth_env: {
    required: ['CEREBRAS_API_KEY'],
    optional: ['CEREBRAS_BASE_URL'],
    setup_url: 'https://cloud.cerebras.ai',
  },
  touchpoints: {
    expansion: {
      models: ['gpt-oss-120b', 'gemma-4-31b'],
      cost_per_1m_tokens_usd: undefined,
      price_last_verified: '2026-08-08',
    },
    chat: {
      // `zai-glm-4.7` is deliberately omitted: Cerebras scheduled it for
      // deprecation on 2026-08-17. Listing a model that dies in days would
      // make it a wizard-pickable default.
      models: ['gpt-oss-120b', 'gemma-4-31b'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      // Cerebras documents `response_format: json_schema` and recommends it
      // over json_object for models that support it.
      supports_structured_outputs: true,
      // Paid tier. The free tier caps at 65k — a free-tier key will see
      // provider-side truncation before gbrain's budget math kicks in.
      max_context_tokens: 131_072,
      cost_per_1m_input_usd: undefined,
      cost_per_1m_output_usd: undefined,
      price_last_verified: '2026-08-08',
    },
  },
  setup_hint: 'Get an API key at https://cloud.cerebras.ai, then `export CEREBRAS_API_KEY=...`. Pair with a separate embedding provider — Cerebras ships none.',
};
