# Dialogue Timing Implementation Plan

> **For agentic workers:** Execute this plan inline, task by task, following the existing test-driven-development and verification-before-completion workflow. Keep changes local on the current development branch.

**Goal:** Show actual speech duration, allow pauses before and after dialogue, explicitly fit shot duration to speech, and play the resulting timing correctly in preview.

**Architecture:** Persist `audioLeadIn` and `audioTailOut` on each shot, separate from generated audio. A shared timing module calculates duration requirements and audio offsets. The editor and preview consume these calculations; media synchronization is separately testable. Existing project JSON storage and merge logic retain the new fields without a database migration.

**Tech Stack:** TypeScript, React, existing Vinext/D1/R2 application, Node test runner.

## Global Constraints

- Existing and new shots default to zero pauses. Loading, editing pauses, and generating audio never automatically change shot duration.
- Pause fields accept finite numbers from 0 to 30 seconds. Shot duration retains the existing API maximum of 600 seconds; editor accepts 1 to 600 seconds.
- Fit uses actual usable audio, adds both pauses, and rounds up to a tenth of a second with a minimum of 1 second. Disable fitting if audio is missing, stale, generating, or the result exceeds 600 seconds.
- Timing changes do not make audio stale and do not call paid providers.
- Preserve readonly sample behavior, concurrent edits, other shots, and old project playback.
- Subtitles retain current whole-dialogue display. When explicit pauses are used, suppress subtitles outside the dialogue window. Sentence splitting and multiple speakers are outside this iteration.
- No commit, push, or deployment is included.

## Task 1: Persist timing and calculate speech windows

**Files:** `lib/types.ts`, `lib/domain.ts`, new `lib/shot-timing.ts`, `tests/domain.test.ts`, new `tests/shot-timing.test.ts`.

**Interfaces:**

```ts
type ShotTimingInput = {
  duration: number;
  audioLeadIn?: number;
  audioTailOut?: number;
  audio?: { url: string | null; duration?: number | null };
};
// Shared calculations; audioUsable excludes outdated audio.
getShotTiming(shot: ShotTimingInput, audioUsable?: boolean): {
  audioDuration: number | null;
  audioStart: number;
  audioEnd: number | null;
  requiredDuration: number | null;
  fitDuration: number | null;
  truncatedBy: number;
  shortfall: number;
};
getShotAudioPosition(shot: ShotTimingInput, localTime: number, audioUsable?: boolean): {
  currentTime: number;
  active: boolean;
};
```

- [x] Add failing tests for zero defaults, normalization, malformed pauses, fitting `0.2 + 6.8 + 0.5` into 7.5 seconds, unavailable audio, duration limits, and audio windows.
- [x] Run `node --experimental-strip-types --test tests/domain.test.ts tests/shot-timing.test.ts`; confirm failures identify missing timing behavior.
- [x] Add required numeric fields to `Shot`, initialize and normalize to zero, validate finite numbers in range, implement shared timing functions. Preserve the existing audio staleness checks.
- [x] Run the same tests and confirm they pass.

## Task 2: Editor controls

**Files:** new `components/ShotTimingControls.tsx`, `components/Studio.tsx`, `app/globals.css`.

**Interface:** `ShotTimingControls({project, shot, disabled, onChange})`, where `onChange` accepts `Partial<Shot>` and is connected to `patchShot`.

- [x] Build a timing panel with editable shot duration, lead-in and tail-out seconds, actual audio duration, required duration, overflow warning and explicit fit button.
- [x] Use local input drafts to allow clearing/retyping; validate finite range before updating. External fitting must immediately update the duration input. Key the panel by shot ID to reset drafts when switching shots.
- [x] Disable fitting for missing/stale/generating audio; show a clear message for requirements above the duration limit. Allow pause editing independently of audio generation.
- [x] Replace the old uncontrolled duration input; retain candidate count control. Add styles matching the existing inspector and responsive layout.

## Task 3: Preview synchronization

**Files:** `lib/playback.ts`, new `lib/preview-audio.ts`, `components/Preview.tsx`, `tests/preview.test.ts`, new `tests/preview-audio.test.ts`.

**Interface:** `syncPreviewAudio(audio, shot, localTime, playing)` consumes an audio element's current time, duration, pause and play methods, and uses `getShotAudioPosition`.

- [x] Add failing tests for before-speech silence, exact start/end boundaries, backward seeks into pauses, paused seeks into speech, tail-out, shot transitions, expired audio, subtitle visibility and shortfall reporting.
- [x] Run targeted tests and inspect the expected failures.
- [x] Extend `previewFrame` with audio offset/activity and indexed timing warnings. Keep legacy subtitle display when pauses are zero.
- [x] Synchronize the audio element when speech boundaries, shot timing, playing state or seek position change. Metadata callbacks read the latest playhead, and effect cleanup prevents old callbacks from starting audio. Clip playback at shot boundaries.
- [x] Show affected shot numbers in preview warnings and run targeted tests.

## Task 4: Persistence, regression verification and documentation

**Files:** `tests/server.test.ts`, `tests/domain.test.ts`, `README.md`, `docs/README.md`.

- [x] Add server tests proving timing survives save/reopen and concurrent audio completion without changing manually set duration. Reject invalid pause values through the API.
- [x] Verify local edit rebasing retains pauses while adopting newly generated audio.
- [x] Document the controls, defaults, range, fit behavior and current subtitle scope.
- [x] Before review, `npm test` passed 123 tests; typecheck, lint and diff whitespace checks passed.
- [x] Review the final diff and preserve local timing edits when a generation acknowledgement arrives before autosave. Added regression cases in `tests/workspace-state.test.ts`.
- [ ] Browser/HTTP integration, production build and the newly added acknowledgement regression cases are deferred following the user's request to perform code review and leave runtime testing to them.

## Acceptance Example

With a 5-second shot and 6.8-second valid audio, setting 0.2-second lead-in and 0.5-second tail-out displays an overflow warning without changing the shot. Clicking fit sets 7.5 seconds. Preview remains silent until 0.2 seconds, plays through 7.0 seconds, holds the image until 7.5 seconds, and advances to the next shot. Seeking and pausing retain the correct relative audio position. Old projects load with zero pauses and their original durations.

## Review Follow-up

The existing generation acknowledgement handler could replace edits made between the POST and its response. `mergeGenerationAcknowledgement` now merges server generation state while retaining local edits if autosave is queued or in flight. Both image and speech generation use it. The shared acknowledgement handler also waits for an in-flight autosave and retries remaining dirty edits after the server supplies the job ID; project/navigation guards prevent saving into a different workspace. The final review is read-only, with no browser or provider requests.
