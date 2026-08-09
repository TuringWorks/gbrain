import type { Recipe } from '../types.ts';

/**
 * xAI (Grok). OpenAI-compatible chat endpoint at https://api.x.ai/v1.
 *
 * Chat + expansion only: xAI publishes no embedding model, so a brain routed
 * here for chat still needs a separate embedding provider (openai, voyage, or
 * ollama to stay local). `gbrain init` resolves each touchpoint independently,
 * so the mixed setup is the normal case, not a workaround.
 *
 * Pricing note: xAI tiers by PROMPT SIZE, not by model — the published rate
 * doubles once a request crosses 200k prompt tokens. The flat
 * `cost_per_1m_*_usd` fields carry the sub-200k tier, which is the only one
 * gbrain search payloads reach (tokenmax tops out around 20k). A caller
 * deliberately stuffing a 200k+ context will under-estimate by 2x.
 */
export const xai: Recipe = {
  id: 'xai',
  name: 'xAI (Grok)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.x.ai/v1',
  auth_env: {
    required: ['XAI_API_KEY'],
    optional: ['XAI_BASE_URL'],
    setup_url: 'https://console.x.ai',
  },
  touchpoints: {
    expansion: {
      models: ['grok-4.3', 'grok-build-0.1'],
      cost_per_1m_tokens_usd: 1.25,
      price_last_verified: '2026-08-08',
    },
    chat: {
      models: [
        'grok-4.5',
        'grok-4.3',
        'grok-4.20-0309-reasoning',
        'grok-4.20-0309-non-reasoning',
        'grok-4.20-multi-agent-0309',
        'grok-build-0.1',
      ],
      supports_tools: true,
      supports_subagent_loop: true,
      // No published prompt-cache contract. Don't inject cache_control.
      supports_prompt_cache: false,
      // xAI documents tool calling but not a strict `json_schema`
      // response_format. Stay on the schemaless expansion path until the
      // docs commit to it — a wrong `true` here breaks expand(), a wrong
      // `false` only costs a retry.
      supports_structured_outputs: false,
      max_context_tokens: 500_000, // grok-4.5; 4.3 and the 4.20 family carry 1M
      cost_per_1m_input_usd: 2.00, // grok-4.5, sub-200k-prompt tier
      cost_per_1m_output_usd: 6.00,
      price_last_verified: '2026-08-08',
    },
  },
  setup_hint: 'Get an API key at https://console.x.ai, then `export XAI_API_KEY=...`. Pair with a separate embedding provider — xAI ships none.',
};
