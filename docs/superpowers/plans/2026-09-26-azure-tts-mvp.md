# Azure TTS MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add free-tier Azure Chinese speech synthesis with one female and one male character voice, per-shot speaker selection, durable private audio, and synchronized preview playback.

**Architecture:** Keep voice choice on each character and one speaking character on each shot. Generate one durable WAV per shot through an Azure Speech adapter, store bytes in the existing private R2 bucket and metadata in D1, and retain the last successful audio until a replacement succeeds. The preview keeps the existing visual timeline and coordinates a hidden audio element at each shot boundary.

**Tech Stack:** TypeScript, React 19, Vinext/Cloudflare Workers, D1, R2, Azure Speech REST API, Node test runner.

## Global Constraints

- Work only on the local `feat/azure-tts-mvp` branch and do not deploy or push.
- MVP exposes exactly two logical voices: `female` and `male`.
- Azure voice mapping is `female -> zh-CN-XiaoxiaoNeural` and `male -> zh-CN-YunxiNeural`.
- One shot has at most one speaking character; existing single `dialogue` text remains the spoken text and subtitle.
- Old project documents must load without migration or data loss.
- Generated audio remains private to the owning account and uses existing D1/R2 storage.
- Failed regeneration keeps the previous successful audio.
- No background music, sound effects, voice cloning, multi-line dialogue, or video export in this task.

---

### Task 1: Backward-compatible voice and shot-audio domain

**Files:**
- Modify: `lib/types.ts`
- Modify: `lib/domain.ts`
- Modify: `lib/sample.ts`
- Modify: `tests/domain.test.ts`
- Modify: `tests/server.test.ts`

**Interfaces:**
- Produces: `VoiceGender`, `ShotAudio`, `emptyShotAudio()`, and `normalizeProject(project)`.
- `Character.voice` is `female | male`.
- `Shot.speakerCharacterId` is `string | null`; `Shot.audio` stores URL, duration, source text/voice, and generation state.

- [x] **Step 1: Write failing domain tests**

```ts
test('new shots start without speaker or audio', () => {
  const result = newShot();
  assert.equal(result.speakerCharacterId, null);
  assert.deepEqual(result.audio, emptyShotAudio());
});

test('legacy projects gain default voices and empty audio state', () => {
  const legacy = structuredClone(project([shot('x')])) as any;
  legacy.characters = [{id:'c',name:'C',description:'',references:[]}];
  delete legacy.characters[0].voice;
  delete legacy.shots[0].speakerCharacterId;
  delete legacy.shots[0].audio;
  const normalized = normalizeProject(legacy);
  assert.equal(normalized.characters[0].voice, 'female');
  assert.equal(normalized.shots[0].speakerCharacterId, null);
  assert.equal(normalized.shots[0].audio.status, 'idle');
});
```

- [x] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/domain.test.ts`
Expected: FAIL because the new voice/audio interfaces and helpers do not exist.

- [x] **Step 3: Implement the domain model and normalization**

```ts
export type VoiceGender = 'female' | 'male';
export type ShotAudio = {
  url: string | null;
  duration: number | null;
  sourceText: string | null;
  sourceVoice: VoiceGender | null;
  status: 'idle' | 'generating' | 'failed';
  error: string | null;
  generationId: string | null;
  generationStartedAt: string | null;
};

export const emptyShotAudio = ():ShotAudio => ({
  url:null,duration:null,sourceText:null,sourceVoice:null,
  status:'idle',error:null,generationId:null,generationStartedAt:null,
});
```

Normalize legacy characters to `female`, legacy shots to no speaker/empty audio, and validate speaker membership, audio state, internal asset URLs, duration, source fields, and voice enums. Give the two sample characters female/male voices and alternate their speaking-character IDs across sample shots.

- [x] **Step 4: Run domain and server tests and verify GREEN**

Run: `npm test -- tests/domain.test.ts tests/server.test.ts`
Expected: PASS with legacy projects loading and current validation preserved.

- [x] **Step 5: Commit the domain slice**

```bash
git add lib/types.ts lib/domain.ts lib/sample.ts tests/domain.test.ts tests/server.test.ts
git commit -m "feat: add character voices and shot audio state"
```

### Task 2: Azure Speech provider adapter

**Files:**
- Create: `lib/speech.ts`
- Create: `tests/speech.test.ts`

**Interfaces:**
- Produces: `AZURE_VOICES`, `buildSpeechSsml(text, gender)`, `requestAzureSpeech(options)`, `detectWavDuration(bytes)`.
- `requestAzureSpeech` returns `{bytes:Uint8Array,mime:'audio/wav',duration:number}`.

- [x] **Step 1: Write failing provider tests**

```ts
test('Azure request maps female and male voices and escapes dialogue', async () => {
  let body = '';
  const result = await requestAzureSpeech({
    key:'key',region:'eastasia',gender:'female',text:'你 & 我 <一起>',
    fetcher:async (url,init) => {
      assert.equal(String(url),'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1');
      body=String(init?.body);
      return new Response(wavFixture(24000),{headers:{'content-type':'audio/wav'}});
    },
  });
  assert.match(body,/zh-CN-XiaoxiaoNeural/);
  assert.match(body,/你 &amp; 我 &lt;一起&gt;/);
  assert.equal(result.duration,1);
});

test('Azure errors expose status without leaking credentials', async () => {
  await assert.rejects(
    requestAzureSpeech({key:'secret',region:'eastasia',gender:'male',text:'测试',fetcher:async()=>new Response('denied',{status:401})}),
    /Speech provider failed \(401\)/,
  );
});
```

- [x] **Step 2: Run the provider test and verify RED**

Run: `npm test -- tests/speech.test.ts`
Expected: FAIL because `lib/speech.ts` does not exist.

- [x] **Step 3: Implement Azure WAV generation**

```ts
export const AZURE_VOICES = {
  female:'zh-CN-XiaoxiaoNeural',
  male:'zh-CN-YunxiNeural',
} as const;

const response = await fetcher(
  `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
  {
    method:'POST',
    headers:{
      'Ocp-Apim-Subscription-Key':key,
      'Content-Type':'application/ssml+xml',
      'X-Microsoft-OutputFormat':'riff-24khz-16bit-mono-pcm',
      'User-Agent':'JingtouStudio',
    },
    body:buildSpeechSsml(text,gender),
    signal:AbortSignal.timeout(60_000),
  },
);
```

Validate the region with `^[a-z0-9-]+$`, escape XML, cap text at 1,000 characters, verify RIFF/WAVE headers, cap output at 20 MiB, and calculate duration from WAV chunks rather than assuming a fixed header layout.

- [x] **Step 4: Run provider tests and verify GREEN**

Run: `npm test -- tests/speech.test.ts`
Expected: PASS with valid WAV parsing and safe upstream errors.

- [x] **Step 5: Commit the provider slice**

```bash
git add lib/speech.ts tests/speech.test.ts
git commit -m "feat: add Azure speech provider"
```

### Task 3: Private audio generation API and configuration

**Files:**
- Modify: `lib/server.ts`
- Modify: `worker/index.ts`
- Modify: `tests/server.test.ts`
- Modify: `tests/auth.test.ts`

**Interfaces:**
- Consumes: `requestAzureSpeech`, normalized project audio state, existing session owner.
- Produces: `POST /api/projects/:id/generate-audio` with `{shotId}` and audio configuration in `GET /api/config`.

- [x] **Step 1: Write failing API tests**

```ts
test('audio generation uses the speaking character voice and saves private WAV bytes', async () => {
  const project = await projectWithDialogue();
  const response = await handleApiRequest(
    request(`/api/projects/${project.id}/generate-audio`,'POST',{shotId:project.shots[0].id}),
    {...env,AZURE_SPEECH_KEY:'key',AZURE_SPEECH_REGION:'eastasia'},
    {fetcher:async (_url,init) => {
      assert.match(String(init?.body),/zh-CN-XiaoxiaoNeural/);
      return new Response(wavFixture(24000),{headers:{'content-type':'audio/wav'}});
    }},
  );
  assert.equal(response.status,200);
  const generated=(await json(response)).project;
  assert.equal(generated.shots[0].audio.duration,1);
  assert.match(generated.shots[0].audio.url,/^\/api\/assets\//);
});
```

Add cases for missing configuration, blank dialogue, missing/invalid speaking character, foreign-account access, read-only sample, provider failure preserving prior audio, concurrent edits, and audio-asset ownership.

- [x] **Step 2: Run API tests and verify RED**

Run: `npm test -- tests/server.test.ts tests/auth.test.ts`
Expected: FAIL because `/generate-audio` is missing.

- [x] **Step 3: Implement the endpoint and ownership checks**

Add `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` to `ApiEnv` and Worker `Env`. Return:

```ts
{
  configured: imageConfigured,
  model: imageModel,
  speech: {
    configured: Boolean(env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION),
    provider: 'Azure Speech',
    voices: {female:'女声',male:'男声'},
  },
}
```

The endpoint must flush a generating marker with CAS, call Azure, write the WAV to R2, insert D1 metadata, and merge into the latest project revision. On error, keep `url`, `duration`, `sourceText`, and `sourceVoice`, while setting audio status/error retryably. Include audio URLs in project ownership validation and use generic “素材” wording for asset retrieval errors.

- [x] **Step 4: Run API tests and verify GREEN**

Run: `npm test -- tests/server.test.ts tests/auth.test.ts`
Expected: PASS with private audio and failure recovery.

- [x] **Step 5: Commit the API slice**

```bash
git add lib/server.ts worker/index.ts tests/server.test.ts tests/auth.test.ts
git commit -m "feat: generate private shot audio"
```

### Task 4: Character voice and shot speaker controls

**Files:**
- Modify: `lib/client.ts`
- Modify: `components/useStudio.ts`
- Modify: `components/Characters.tsx`
- Modify: `components/Studio.tsx`
- Modify: `app/globals.css`
- Modify: `tests/client-auth.test.ts`

**Interfaces:**
- Consumes: `POST .../generate-audio`, `Character.voice`, `Shot.speakerCharacterId`, and speech config.
- Produces: `useStudio.generateAudio(shotId)` and user controls for choosing/previewing logical voices and generating shot audio.

- [x] **Step 1: Write failing client configuration test**

```ts
test('guest workspace has an unconfigured speech service without private requests', async () => {
  const [,settings] = await loadWorkspace(false);
  assert.deepEqual(settings.speech,{configured:false,provider:'Azure Speech',voices:{female:'女声',male:'男声'}});
});
```

- [x] **Step 2: Run the client test and verify RED**

Run: `npm test -- tests/client-auth.test.ts`
Expected: FAIL because speech configuration is absent.

- [x] **Step 3: Add the UI and client action**

Character editor:

```tsx
<label>角色音色
  <select value={editing.voice} onChange={e=>setEditing({...editing,voice:e.target.value as VoiceGender})}>
    <option value="female">女声</option>
    <option value="male">男声</option>
  </select>
</label>
```

Shot editor adds a speaking-character select restricted to `shot.characterIds`, shows current/stale/failed/generating status, provides an audio player when a URL exists, and calls `studio.generateAudio(shot.id)`. Changing character associations must clear an invalid `speakerCharacterId` but retain prior generated audio until replacement succeeds. Disable generation unless speech is configured, dialogue is non-empty, and a speaker is selected.

- [x] **Step 4: Run tests, typecheck, and verify GREEN**

Run: `npm test -- tests/client-auth.test.ts && npm run typecheck`
Expected: PASS with no TypeScript errors.

- [x] **Step 5: Commit the UI slice**

```bash
git add lib/client.ts components/useStudio.ts components/Characters.tsx components/Studio.tsx app/globals.css tests/client-auth.test.ts
git commit -m "feat: add character voice and shot speech controls"
```

### Task 5: Audio-aware preview synchronization

**Files:**
- Modify: `lib/playback.ts`
- Modify: `components/Preview.tsx`
- Modify: `tests/preview.test.ts`

**Interfaces:**
- Produces: `previewFrame(...).start`, `previewFrame(...).audio`, and preview audio coordination at shot boundaries and seeks.

- [x] **Step 1: Write failing playback tests**

```ts
test('preview exposes selected shot audio and its local offset', () => {
  const withAudio = shots.map((shot,index)=>({...shot,audio:index===1?{url:'/api/assets/audio',duration:2}:null}));
  const frame = previewFrame(withAudio,6.25);
  assert.equal(frame.start,5);
  assert.equal(frame.localTime,1.25);
  assert.equal(frame.audio?.url,'/api/assets/audio');
});
```

- [x] **Step 2: Run preview tests and verify RED**

Run: `npm test -- tests/preview.test.ts`
Expected: FAIL because preview frame does not expose audio timing.

- [x] **Step 3: Coordinate the hidden audio element**

Use one `<audio ref={audioRef} preload="auto" />`. On shot changes, set its source and local time; on play/pause, mirror playback; on seeking within the same shot, set `audio.currentTime`; on audio end, let the visual timeline continue. Keep requestAnimationFrame for silent portions and resynchronize global time from audio while it is actively playing. Replace the mute placeholder with a working mute button and show a warning count for shots whose dialogue has missing or stale audio.

- [x] **Step 4: Run preview tests and typecheck**

Run: `npm test -- tests/preview.test.ts && npm run typecheck`
Expected: PASS with exact existing shot boundaries and audio offsets.

- [x] **Step 5: Commit the preview slice**

```bash
git add lib/playback.ts components/Preview.tsx tests/preview.test.ts
git commit -m "feat: synchronize speech in preview"
```

### Task 6: Configuration docs and complete validation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `tests/http-smoke.mjs`
- Modify: `docs/superpowers/plans/2026-09-26-azure-tts-mvp.md`

**Interfaces:**
- Documents: `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, Azure F0 setup, the two fixed voices, and restart requirement.

- [x] **Step 1: Extend the HTTP smoke test without making a paid provider call**

Assert that authenticated `/api/config` contains a `speech` object, anonymous configuration remains protected, legacy projects load with audio defaults, and `/generate-audio` returns `503` when local Azure credentials are absent.

- [x] **Step 2: Run the smoke test against the completed worktree and verify GREEN**

Run: `npm run test:integration`
Expected: FAIL on the new speech assertions before the complete feature is wired into the running app.

- [x] **Step 3: Document configuration and finish the checklist**

```dotenv
AZURE_SPEECH_KEY=
AZURE_SPEECH_REGION=eastasia
```

Document that the Azure F0 tier currently includes 0.5 million neural TTS characters per month, keys remain server-side, generated WAV files are private, and the local server must restart after configuration changes. Mark each completed plan checkbox.

- [x] **Step 4: Run complete verification**

Run: `npm test`
Expected: all tests pass.

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm run lint`
Expected: exit 0.

Run: `npm run build`
Expected: successful Vinext build.

Run: `git diff --check`
Expected: no output.

- [x] **Step 5: Commit documentation and integration coverage**

```bash
git add .env.example README.md tests/http-smoke.mjs docs/superpowers/plans/2026-09-26-azure-tts-mvp.md
git commit -m "docs: configure Azure speech MVP"
```

## Self-Review

- Spec coverage: two role voices, role selection, per-shot speaker, generation, private persistence, failure recovery, preview sync, configuration, legacy compatibility, and local-only delivery are covered.
- Scope exclusions are explicit; no BGM, effects, cloning, multi-line dialogue, or export is introduced.
- Type consistency: `VoiceGender`, `ShotAudio`, `speakerCharacterId`, `audio`, `generateAudio`, and `speech` config names are used consistently across tasks.
- Placeholder scan: no TBD/TODO steps remain.
