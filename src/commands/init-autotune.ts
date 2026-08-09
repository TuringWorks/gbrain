/**
 * Install-time tier assignment for local brains.
 *
 * Fires from `gbrain init` after `initSchema()` (so config writes are valid)
 * when the chosen chat model is an Ollama one. Without it, a fresh local brain
 * runs every tier on one model until the user discovers `gbrain models
 * autotune` — and most never would, because nothing points at it.
 *
 * Deliberately narrow:
 *  - Ollama only. It is the sole local provider exposing per-model
 *    capabilities; llama-server serves one model and LiteLLM proxies opaque
 *    backends, so neither has a fleet to rank.
 *  - Never overwrites a tier the user already set (autotune's own rule).
 *  - Fail-open. A daemon that is unreachable at init time is normal — people
 *    configure before starting `ollama serve`. It prints the one-line fix and
 *    moves on; init must not fail over an optimization.
 */

import type { BrainEngine } from '../core/engine.ts';

export async function maybeAutotuneLocalTiers(
  engine: BrainEngine,
  opts: { chatModel?: string; jsonOutput?: boolean },
): Promise<void> {
  const chat = opts.chatModel?.trim();
  if (!chat || !chat.startsWith('ollama:')) return;

  try {
    const { runModelsAutotune } = await import('./models.ts');
    if (!opts.jsonOutput) {
      process.stderr.write('\n[init] Assigning model tiers from your local Ollama fleet…\n');
    }
    // exitOnError:false is load-bearing. The CLI path exits non-zero when the
    // daemon is unreachable; inheriting that here would abort `gbrain init`
    // for the most ordinary reason imaginable — configuring gbrain before
    // starting `ollama serve`.
    await runModelsAutotune(engine, { json: opts.jsonOutput, exitOnError: false });
  } catch (e) {
    if (!opts.jsonOutput) {
      process.stderr.write(
        `[init] Could not assign per-tier models (${e instanceof Error ? e.message : String(e)}). ` +
        `Every tier will use ${chat}. Run \`gbrain models autotune\` once Ollama is up.\n`,
      );
    }
  }
}
