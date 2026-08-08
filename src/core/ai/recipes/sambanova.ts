import type { Recipe } from '../types.ts';

/**
 * SambaNova Cloud — RDU-hosted open-weight models behind an OpenAI-compatible
 * chat surface.
 *
 * Chat + expansion only. SambaNova's OpenAI-compatibility guide covers chat
 * completions and the Responses API; it does not document an embeddings route,
 * so declaring one would be a guess that only fails at first insert.
 *
 * NOTE on the base URL: SambaNova issues the base URL alongside the API key
 * (dedicated deployments get their own host), so the pinned default is the
 * public shared endpoint and `SAMBANOVA_BASE_URL` / `base_urls.sambanova`
 * overrides it. Users on a dedicated endpoint MUST override.
 *
 * NOTE on pricing: per-model rates are not published in a stable public table.
 * `cost_per_1m_*` stays undefined rather than fabricated.
 *
 * Known API limitation: `n > 1` is rejected when `tools` is present. gbrain
 * never sets `n`, so this doesn't bite the subagent loop — recorded so a
 * future multi-sample caller doesn't rediscover it in production.
 */
export const sambanova: Recipe = {
  id: 'sambanova',
  name: 'SambaNova Cloud',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.sambanova.ai/v1',
  auth_env: {
    required: ['SAMBANOVA_API_KEY'],
    optional: ['SAMBANOVA_BASE_URL'],
    setup_url: 'https://cloud.sambanova.ai/apis',
  },
  touchpoints: {
    expansion: {
      models: ['Meta-Llama-3.3-70B-Instruct', 'gpt-oss-120b'],
      cost_per_1m_tokens_usd: undefined,
      price_last_verified: '2026-08-08',
    },
    chat: {
      // Production models only. The preview tier (DeepSeek-V3.2 at 32k,
      // gemma-4-31B-it) is omitted so the wizard can't default onto a model
      // whose id or availability moves without notice.
      models: [
        'MiniMax-M2.7',
        'DeepSeek-V3.1',
        'Meta-Llama-3.3-70B-Instruct',
        'gpt-oss-120b',
      ],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      // Not documented in the OpenAI-compatibility guide. Schemaless path.
      supports_structured_outputs: false,
      // Conservative: the smallest production context in the list above.
      // MiniMax-M2.7 carries 192k; a brain pinned to it can raise
      // `search.token_budget` accordingly.
      max_context_tokens: 131_072,
      cost_per_1m_input_usd: undefined,
      cost_per_1m_output_usd: undefined,
      price_last_verified: '2026-08-08',
    },
  },
  setup_hint: 'Get an API key at https://cloud.sambanova.ai/apis, then `export SAMBANOVA_API_KEY=...` (and SAMBANOVA_BASE_URL if you are on a dedicated endpoint). Pair with a separate embedding provider.',
};
