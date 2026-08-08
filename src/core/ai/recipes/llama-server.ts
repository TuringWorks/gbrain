import type { Recipe } from '../types.ts';
import { probeLlamaServer } from '../probes.ts';

/**
 * llama.cpp's `llama-server` (also published as `@llama.cpp/llama-server`).
 * Exposes OpenAI-compatible `/v1/embeddings` and `/v1/chat/completions`
 * endpoints. Distinct from Ollama: different default port (8080), different
 * model-management story (you launch it with `--model <path>`; the server
 * serves whatever model was passed).
 *
 * One server instance serves one model. Running embeddings AND chat locally
 * therefore means either two `llama-server` processes on different ports —
 * one with `--embeddings`, one with `--jinja` for tool calling — or pairing
 * this recipe with `ollama` for the other touchpoint. `gbrain init` can point
 * each touchpoint at a different provider, so the mixed setup is supported.
 *
 * Like LiteLLM, this recipe ships with `models: []` because the model
 * identity is whatever the user launched llama-server with. They MUST
 * pass `--embedding-model llama-server:<id>` and `--embedding-dimensions
 * <N>`. The wizard refuses to pick implicit defaults.
 *
 * Reference: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 */
export const llamaServer: Recipe = {
  id: 'llama-server',
  name: 'llama.cpp llama-server (local)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:8080/v1',
  auth_env: {
    required: [],
    optional: ['LLAMA_SERVER_BASE_URL', 'LLAMA_SERVER_API_KEY'],
    setup_url:
      'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md',
  },
  touchpoints: {
    embedding: {
      models: [], // user-driven; whatever model the server was launched with
      user_provided_models: true,
      default_dims: 0, // forces explicit --embedding-dimensions
      trust_custom_dims: true, // #2271: user knows the launched model's native dim
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-05-10',
      // llama-server enforces a hard request-COUNT cap equal to its launch
      // batch size (`--batch-size`, default 32): it rejects requests with
      // more inputs with `batch size N > maximum allowed batch size 32`.
      // The token-budget split can't bound item count, so cap it here. A
      // server launched with a larger `-b` can raise this. v0.32 (#779).
      max_batch_items: 32,
    },
    // Same server, same OpenAI-compatible surface. `models: []` for the same
    // reason embedding declares it: model identity is whatever the server was
    // launched with (`--model <gguf-path>`), so there is nothing to enumerate.
    expansion: {
      models: [],
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-08-08',
    },
    chat: {
      models: [],
      // llama.cpp's server implements OpenAI-style `tools` / `tool_calls` and
      // ships per-family chat templates (`--jinja`) that emit them. Whether a
      // given GGUF actually calls tools well depends on the model, not the
      // server — same caveat as Ollama.
      supports_tools: true,
      supports_subagent_loop: true,
      // KV-cache reuse across requests is a server-side prefix optimization,
      // not an Anthropic-style cache_control contract. Nothing to mark up.
      supports_prompt_cache: false,
      // llama.cpp honors a strict GBNF grammar, but its OpenAI-compat
      // `response_format: json_schema` handling varies by build. Stay on the
      // schemaless path — correct everywhere, at the cost of one retry.
      supports_structured_outputs: false,
      // Set by `--ctx-size` at launch (default 4096). Declaring the launch
      // default keeps token-budget math honest for an un-tuned server.
      max_context_tokens: 4096,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-08-08',
    },
  },
  /**
   * Probe via the OpenAI-compatible /v1/models endpoint. Caller passes the
   * resolved baseURL (from cfg.base_urls['llama-server'] or env), so the
   * probe agrees with what the gateway will actually call. Falls back to
   * env / localhost:8080 when called without an argument.
   */
  async probe(baseURL?: string) {
    const url = baseURL ?? process.env.LLAMA_SERVER_BASE_URL ?? 'http://localhost:8080/v1';
    const result = await probeLlamaServer(url);
    if (!result.reachable) {
      return {
        ready: false,
        hint: `llama-server not reachable at ${url}. Start it with \`./llama-server --model <path> --embeddings\` (embeddings) or \`./llama-server --model <path> --jinja\` (chat/tools), or set LLAMA_SERVER_BASE_URL.`,
      };
    }
    if (!result.models_endpoint_valid) {
      return {
        ready: false,
        hint: `llama-server reached but /v1/models returned an unexpected shape: ${result.error ?? 'unknown'}.`,
      };
    }
    return { ready: true };
  },
  setup_hint:
    'Build llama.cpp, then `llama-server --model <gguf-path> --embeddings` for embeddings (set --embedding-model llama-server:<id> + --embedding-dimensions <N>), or `llama-server --model <gguf-path> --jinja` for chat with tool calling. One model per server — run two ports, or pair with ollama.',
};
