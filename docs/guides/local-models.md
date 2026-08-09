# Running gbrain on local models

You can run a whole brain — ingest, embed, search, `think`, and the subagent
tool loop — with no hosted API key anywhere. This guide covers how, and what
you trade away.

## The short version

```bash
# 1. Serve the models. Two pulls: one embedder, one chat model with tool calling.
ollama serve &
ollama pull nomic-embed-text
ollama pull qwen3

# 2. Point every touchpoint at Ollama.
gbrain init --pglite \
  --embedding-model ollama:nomic-embed-text \
  --embedding-dimensions 768 \
  --chat-model ollama:qwen3 \
  --expansion-model ollama:qwen3

# 3. Confirm the daemon is actually reachable and the wiring resolves.
gbrain doctor
```

`gbrain init` will not auto-pick a local provider for you. That is deliberate:
picking Ollama silently when you have `OPENAI_API_KEY` set is a
silent-broken-state class — the daemon may not be running, and you probably
meant the hosted provider. Local providers are always available by explicit
flag or through the interactive picker.

## Why this needed a fix

gbrain has shipped Ollama support since v0.32, but only for **embeddings**. The
`ollama` recipe declared one touchpoint. So a local install could index a brain
and search it, and then every synthesis step — `gbrain think`, query expansion,
`gbrain dream`, `gbrain agent run` — routed to Anthropic, because that was the
only thing the tier defaults knew how to name. The failure surfaced as
`NO_ANTHROPIC_API_KEY`, which reads as *gbrain requires Anthropic* rather than
*nothing told me what to use*.

Four separate things had to change for the local path to be real. They are
worth knowing about because each one is a place the behavior could regress:

1. **`ollama` and `llama-server` now declare `chat` and `expansion`
   touchpoints**, with tool calling. Without a chat touchpoint the gateway
   refuses to route synthesis to them at all.
2. **Tier defaults consult your `chat_model`.** The resolution chain's last
   step used to hardcode `anthropic:*`. It still does when you have an
   Anthropic key — behavior for existing brains is unchanged — but with no key
   it now falls through to whatever `chat_model` you configured.
3. **The subagent loop auto-routes non-Anthropic models.** gbrain has had a
   provider-agnostic tool loop since v0.38, gated behind
   `agent.use_gateway_loop`. A non-Anthropic model used to be *refused* with a
   pointer to that config key. It is now routed through the gateway loop
   automatically, because the legacy Anthropic-direct path could never have run
   it anyway. The flag still exists and still means something: it opts
   *Anthropic* models into the gateway loop too.
4. **The Anthropic SDK client is constructed lazily.** It used to be built when
   the worker registered its handlers, and the SDK constructor throws on a
   missing key — so `gbrain jobs work` died at startup on a keyless brain
   before any routing decision was reached.

## Giving each tier the right model

gbrain routes work through four model tiers — `utility` (classification,
verdicts), `reasoning` (the default workhorse), `deep` (expensive reasoning),
and `subagent` (the tool loop). With no per-tier config, a keyless brain runs
all four on your `chat_model`, which wastes the fleet in both directions: a 3B
model is the right classifier and the wrong deep reasoner.

`gbrain models autotune` reads what you have pulled and assigns each tier:

```
$ gbrain models autotune
Local fleet at http://localhost:11434/v1: 14 model(s), 7 tool-capable.

  ✔ utility    ollama:llama3.2:latest      128k ctx  2.0GB, smallest tool-capable without thinking
  ✔ reasoning  ollama:gpt-oss:20b          128k ctx  13.8GB, runner-up by size
  ✔ deep       ollama:qwen3.6:35b-mlx      128k ctx  21.9GB, largest tool-capable
  ✔ subagent   ollama:gpt-oss:20b          128k ctx  13.8GB, same workhorse
```

It runs automatically during `gbrain init` when you pick an Ollama chat model,
so a fresh local brain is tiered without a second command. Re-run it after
pulling a new model. `--dry-run` previews; `--json` is machine-readable.

**It never overwrites a tier you set by hand.** A hand-tuned tier is a
decision, so re-running after a pull is safe. Use `--force` to overwrite.

**Discovery runs once and writes config.** Model resolution stays a pure config
read — putting a probe in the resolution path would add a network round-trip to
every unconfigured call, which is worse than the flat defaults it fixes.

### What the ranking is, and is not

Ranking is by on-disk size, which is a proxy for capability, not a quality
measure — a 9B model tuned for reasoning may well beat a 12B generalist. That's
why every assignment is printed with its justification and stays overridable:

```bash
gbrain config set models.tier.deep ollama:your-preferred-model
```

Size specifically means *bytes*, not parameter count: quantized and MLX builds
frequently report no parameter count at all, so a parameter-based sort silently
drops them to the bottom of the fleet.

Two tier rules are deliberate. `utility` prefers the smallest model **without**
a `thinking` capability — classification returns a label, and reasoning tokens
spent on it are pure overhead. `reasoning` takes the runner-up rather than the
largest, so deep-tier latency isn't paid on every ordinary call.

### Why capability detection matters more than it sounds

Ollama reports per-model capabilities, and several **embedding** models
advertise `tools` while lacking `completion` — `qwen3-embedding:8b` reports
`[tools,embedding]`. At 7.6B it outranks most genuine chat models by size, so
selecting on `tools` alone lands a model that cannot generate text into a
reasoning tier. autotune requires `completion` **and** `tools`, and prints
every rejected model with the reason:

```
  Not eligible for chat tiers:
    - qwen3-embedding:8b    embedding model (advertises tools but has no completion)
```

`llama-server` and `litellm` are not autotuned: the former serves one model
chosen at launch, and the latter proxies opaque backends with no capability
API. Both keep the single-model behavior.

## What you give up

Be clear-eyed about this. Local is not free of cost, it just moves the cost.

**Prompt caching.** Anthropic's ephemeral cache markers are what keep a long
multi-turn subagent loop cheap. No other provider in the registry honors them,
so every turn re-sends the whole conversation. On a hosted non-Anthropic
provider that shows up as a linear cost increase. On a local model it shows up
as latency — a 20-turn loop re-processes a growing prompt 20 times.

**Context window.** The `ollama` and `llama-server` recipes declare a
conservative 4096-token context, because that is the un-tuned default for both.
That is *small* — smaller than a single `tokenmax` search payload. Raise the
daemon, then raise gbrain's budget to match:

```bash
# Ollama: raise the daemon's default, then tell gbrain about it.
OLLAMA_CONTEXT_LENGTH=32768 ollama serve
gbrain config set search.token_budget 12000
```

Leaving these mismatched is the most common way a local setup produces
plausible-but-truncated answers: the daemon silently drops the front of the
prompt, which is where the retrieved context lives — no error is raised
anywhere.

`gbrain models autotune` reports the context it measured per tier, so you can
see the real number rather than the recipe's conservative default. It reads the
length the daemon actually **serves** (which is `min(trained length, OLLAMA_CONTEXT_LENGTH)`),
not what the model was trained for — those differ by 32× on an un-tuned daemon,
and only the served value predicts truncation. The reading requires a chat
model to be resident, so run one query first if autotune reports it as unknown.

**Tool-calling quality.** Declaring `supports_tools: true` on the recipe says
the *server* speaks the protocol, not that your model uses it well. Small
models (4B and under) frequently emit malformed tool calls, re-call the same
tool in a loop, or ignore tools entirely. If `gbrain agent run` spins, try a
larger model before assuming a gbrain bug.

**Embedding quality.** `nomic-embed-text` at 768 dimensions is a real step down
from `voyage-3` or `text-embedding-3-large` on retrieval benchmarks. A common
middle path is local chat with hosted embeddings — embeddings are computed once
per document and are the cheaper half of the bill.

## Remote and cloud Ollama

The same recipe covers three deployments:

| Setup | Configuration |
|---|---|
| Local daemon | nothing — `http://localhost:11434/v1` is the default |
| Remote daemon | `OLLAMA_BASE_URL=http://gpu-box:11434/v1` (add `OLLAMA_API_KEY` if it sits behind an authenticating proxy) |
| Ollama Cloud | `OLLAMA_BASE_URL=https://ollama.com/v1` + `OLLAMA_API_KEY` |

**One trap worth stating plainly:** Ollama model ids ending in `-cloud` or
`:cloud` run on Ollama's servers *even when your base URL points at the local
daemon* — the daemon proxies them. Picking one sends your brain's contents
off-device. That is a privacy decision, not a performance one, and the model id
is the only thing that tells you.

## llama.cpp (`llama-server`)

`llama-server` serves **one model per process**. Running embeddings and chat
both locally through llama.cpp therefore means two processes on two ports:

```bash
./llama-server --model embed.gguf --embeddings --port 8080 &
./llama-server --model chat.gguf  --jinja      --port 8081 &

gbrain config set base_urls.llama-server http://localhost:8080/v1
```

`--jinja` is required for tool calling — it loads the model's chat template,
which is what emits `tool_calls`. Without it the subagent loop gets a model
that can never call a tool.

Because gbrain resolves each touchpoint independently, the more common setup is
mixing: llama.cpp for chat (where you want a specific GGUF) and Ollama for
embeddings (where you want convenience), or either one for chat with hosted
embeddings.

## Hosted non-Anthropic providers

Everything above about the tier-default and subagent-routing fixes applies
equally to hosted providers that aren't Anthropic. A brain on DeepSeek, xAI, or
Cerebras hit the exact same dead end. The registry now covers:

| Provider | id | key | chat | embeddings |
|---|---|---|---|---|
| xAI (Grok) | `xai` | `XAI_API_KEY` | yes | no |
| Cerebras | `cerebras` | `CEREBRAS_API_KEY` | yes | no |
| Fireworks AI | `fireworks` | `FIREWORKS_API_KEY` | yes | yes |
| SambaNova | `sambanova` | `SAMBANOVA_API_KEY` | yes | no |

Plus the previously-shipped OpenAI, Google, DeepSeek, Groq, Together, Mistral,
Moonshot, Zhipu, MiniMax, NVIDIA, Perplexity, OpenRouter, Azure OpenAI, and the
LiteLLM proxy escape hatch. Run `gbrain providers list` for the live registry —
that command reads the same recipes this table was written from, so it cannot
drift.

Fireworks is the only one of the four new providers that can serve a whole
brain alone; the other three ship no embedding model and need to be paired.

### Providers deliberately not added

Three more were considered and left out, because each needs transport work
rather than a recipe — a recipe is pure data over an OpenAI-compatible
endpoint, and these are not that:

- **AWS Bedrock** — requests are SigV4-signed against a regional host. That is
  a new `implementation` in the gateway's factory switch, not a `base_url`.
- **GitHub Copilot** — auth is an OAuth device flow with short-lived tokens, so
  there is no static key for `auth_env` to name.
- **poolside** — access is enterprise-gated; the endpoint contract could not be
  verified against public documentation, and shipping an unverifiable recipe
  is how stale model ids and wrong prices get in.

All three are reachable today through the `litellm` recipe, which is the
existing escape hatch for exactly this: run LiteLLM in front of them and point
gbrain at the proxy.

### A note on cost estimates

`cerebras`, `fireworks`, and `sambanova` do not publish stable per-1M-token
rates in a public table, so their recipes report cost as **unknown** rather
than carrying a guess. `--max-usd` pre-flights and `est_cost_usd` audit rows
will show no estimate for these providers. That is intentional: a fabricated
rate corrupts a budget gate silently, which is worse than an absent one.

xAI publishes rates, and the recipe carries the sub-200k-prompt tier. xAI
doubles its rate above a 200k-token prompt; gbrain search payloads top out
around 20k, so the recorded tier is the one you will actually pay — unless you
are deliberately stuffing enormous contexts, in which case estimates run 2x low.

## Verifying it works

```bash
gbrain doctor                       # probes the local endpoint; warns if unreachable
gbrain providers list               # confirms which recipes are ready
gbrain think "what did I write about retrieval?"
```

`gbrain doctor`'s `subagent_capability` check probes local endpoints directly.
A stopped daemon is the failure mode that no API-key check can catch, and it is
the single most common cause of a local brain that "stopped working".
