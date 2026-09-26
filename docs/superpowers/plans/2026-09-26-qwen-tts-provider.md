# Qwen TTS Provider Implementation Plan

**Goal:** Keep speech synthesis behind a provider interface and use Alibaba Cloud Model Studio `qwen3-tts-flash` without changing stored project data or invalidating existing audio.

**Architecture:** Characters continue to store a logical `female` or `male` voice. A runtime speech-provider factory maps that logical voice to Qwen3 system voices and returns normalized WAV bytes plus duration. Server configuration reports only non-secret provider metadata to the browser and keeps the existing private audio-storage flow.

**Tech Stack:** TypeScript, Cloudflare Workers, React, Vitest, Miniflare.

---

### Task 1: Add the provider interface and Qwen HTTP adapter

**Files:**
- Modify: `tests/speech.test.ts`
- Modify: `lib/speech.ts`

1. Add failing tests for a `SpeechProvider` factory and Qwen synthesis. Verify the adapter sends the model, text, logical-to-provider voice mapping, and Chinese language type to the official Qwen MaaS multimodal-generation endpoint.
2. Add failing tests proving the returned signed OSS URL is fetched immediately, arbitrary download hosts are rejected, WAV bytes are validated, and upstream errors do not expose API keys or raw response bodies.
3. Run `npm test -- --run tests/speech.test.ts` and confirm the new tests fail because Qwen support is absent.
4. Implement provider types and the two-step Qwen request/download flow. Permit only HTTPS downloads from Beijing OSS hosts; upgrade the documented HTTP OSS URL to HTTPS before fetching.
5. Run the focused test again and confirm it passes.

### Task 2: Select providers from server environment and use them for generation

**Files:**
- Modify: `tests/server.test.ts`
- Modify: `tests/client-auth.test.ts`
- Modify: `tests/http-smoke.mjs`
- Modify: `lib/server.ts`
- Modify: `lib/client.ts`
- Modify: `worker/index.ts`

1. Add failing server tests for public configuration metadata, Qwen audio generation, and incomplete provider configuration.
2. Run the focused server/client tests and confirm the expected failures.
3. Add the Qwen provider environment variables and resolver.
4. Use the normalized provider interface for generation. Keep the existing retry, state merge, private asset persistence, and old-audio-on-failure behavior.
5. Update browser configuration types and smoke expectations, then rerun the focused tests.

### Task 3: Make settings and setup documentation provider-aware

**Files:**
- Modify: `components/Studio.tsx`
- Modify: `.env.example`
- Modify: `README.md`

1. Change the settings panel to render the provider and model returned by `/api/config`, with Qwen setup variable names.
2. Document the provider abstraction, Qwen3 DashScope endpoint requirements, and default model and voice IDs. Preserve the current note about when existing shot audio becomes stale.
3. Add the new environment variables to `.env.example` without adding credentials.

### Task 4: Verify the integrated change

**Files:**
- Review all modified files.

1. Run `npm test -- --run`.
2. Run `npm run build`.
3. Run `git diff --check` and inspect `git status --short`.
4. Review the diff for secret leakage, unsafe external URL fetching, schema changes, and accidental unrelated edits.
