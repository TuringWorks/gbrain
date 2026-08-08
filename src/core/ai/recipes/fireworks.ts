import type { Recipe } from '../types.ts';

/**
 * Fireworks AI — hosted open-weight models with an OpenAI-compatible surface,
 * covering chat AND embeddings. The one provider in this wave that can serve a
 * whole brain on its own.
 *
 * Model ids are fully-qualified paths (`accounts/fireworks/models/<name>`),
 * which contain no colon, so `provider:model` parsing is unambiguous:
 * `fireworks:accounts/fireworks/models/kimi-k2-instruct-0905`. Users on a
 * dedicated deployment substitute their own account segment — that's why the
 * model lists here stay advisory (`tier: 'openai-compat'` never rejects an
 * unlisted id).
 *
 * NOTE on pricing: Fireworks prices per-model by parameter-count band and
 * changes the bands as the model library rotates. Rather than pin a number
 * that goes stale silently, `cost_per_1m_*` is left undefined (the
 * litellm-proxy choice). Cost views report unknown instead of wrong.
 */
export const fireworks: Recipe = {
  id: 'fireworks',
  name: 'Fireworks AI',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.fireworks.ai/inference/v1',
  auth_env: {
    required: ['FIREWORKS_API_KEY'],
    optional: ['FIREWORKS_BASE_URL'],
    setup_url: 'https://fireworks.ai/account/api-keys',
  },
  touchpoints: {
    embedding: {
      models: ['nomic-ai/nomic-embed-text-v1.5'],
      // Matryoshka: trained to truncate anywhere in 64..768. Fireworks honors
      // the `dimensions` parameter, so the standard ladder is selectable and
      // the Matryoshka allowlist governs (no `trust_custom_dims` needed).
      dims_options: [768, 512, 256, 128, 64],
      default_dims: 768,
      cost_per_1m_tokens_usd: undefined,
      price_last_verified: '2026-08-08',
      // Batch capacity tracks the serving deployment, not a documented
      // static cap. Same posture as together/litellm.
      no_batch_cap: true,
    },
    expansion: {
      models: ['accounts/fireworks/models/kimi-k2-instruct-0905'],
      cost_per_1m_tokens_usd: undefined,
      price_last_verified: '2026-08-08',
    },
    chat: {
      models: ['accounts/fireworks/models/kimi-k2-instruct-0905'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      // Documented: `response_format` accepts `json_schema` with a supplied schema.
      supports_structured_outputs: true,
      max_context_tokens: 131_072,
      cost_per_1m_input_usd: undefined,
      cost_per_1m_output_usd: undefined,
      price_last_verified: '2026-08-08',
    },
  },
  setup_hint: 'Get an API key at https://fireworks.ai/account/api-keys, then `export FIREWORKS_API_KEY=...`. Model ids are full paths: --model fireworks:accounts/fireworks/models/<name>.',
};
