# Backend implementation report

The API initializes the D1 `projects` and `assets` tables and owner/update index with idempotent SQL before handling requests. The definitions match `db/schema.ts` and the generated migration. This covers a fresh local database and leaves a migrated database usable.

The demo uses the three shipped PNG files only. Its first shot offers all three as candidates; the other eleven rotate through them. All twelve shots have a selected candidate and a five-second duration. Character references use `linxia.png` and `chenyu.png`, which the generation route reads from the static asset binding.

Generation rejects requests that would take a shot beyond 200 candidates before calling the image provider or changing the project revision. Both image endpoints use a 240-second abort signal, before the ten-minute stale-job recovery threshold. Prompts state the exact one-based range of reference image inputs belonging to each character. Invalid project documents return HTTP 400.

Generation requires a server-side API key (`IMAGE_API_KEY` or `OPENAI_API_KEY`) and an explicit `IMAGE_MODEL`. The documented example `gpt-image-2.5-flare` is listed in the [OpenAI image generation documentation](https://developers.openai.com/api/docs/guides/tools-image-generation). No paid provider call was made.

Verification: `node --experimental-strip-types --test tests/server.test.ts tests/generation.test.ts` passed 18/18. `npm run typecheck` passed. The backend files pass lint; the full `npm run lint` currently reports an unrelated `components/Studio.tsx:61` Next.js link rule.
