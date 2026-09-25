# Global Character and Scene Libraries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sidebar Character Library and Scene Generation entries show resources from every saved project, while project tabs continue to edit only the open project.

**Architecture:** Add an owner-scoped `/api/library` read endpoint that projects stored documents into compact character and scene library entries. Load that data in `useStudio`, render two read-only global library views, and let each card open its source project directly in the matching editor tab. Keep all resource data inside its original project document.

**Tech Stack:** TypeScript, React 19, Vinext, Cloudflare Worker/D1, Node test runner, CSS.

## Global Constraints

- Local repository only; do not push to a remote repository.
- Global libraries aggregate only projects owned by the current workspace owner.
- Resource editing remains project-scoped and existing project data is not copied or migrated.
- The canonical sample remains read-only and is excluded until explicitly copied into My Works.

---

### Task 1: Owner-scoped resource library API

**Files:**
- Modify: `lib/types.ts`
- Modify: `lib/server.ts`
- Modify: `tests/server.test.ts`

**Interfaces:**
- Produces: `ResourceLibrary`, `LibraryCharacter`, and `LibraryScene` DTO types.
- Produces: `GET /api/library` returning `{ characters, scenes }`.

- [x] **Step 1: Write the failing API test**

Create two owned projects and one foreign project, save characters and scenes in each, request `/api/library`, and assert that only owned entries are returned with `projectId`, `projectName`, counts, style, and a compact preview URL.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --experimental-strip-types --test --test-name-pattern="global resource library" tests/server.test.ts`

Expected: status or response shape assertion fails because `/api/library` does not exist.

- [x] **Step 3: Add compact DTO types and endpoint**

Use these shapes:

```ts
export type LibraryCharacter = Character & {
  projectId: string;
  projectName: string;
  shotCount: number;
};

export type LibraryScene = Pick<Scene, 'id' | 'name' | 'description' | 'style' | 'status'> & {
  projectId: string;
  projectName: string;
  shotCount: number;
  candidateCount: number;
  previewUrl: string | null;
};

export type ResourceLibrary = {
  characters: LibraryCharacter[];
  scenes: LibraryScene[];
};
```

Read only rows matching the resolved owner, preserve project update order, and never return full scene candidate histories.

- [x] **Step 4: Run the focused test and verify GREEN**

Run the same focused command and expect the new test to pass.

### Task 2: Client library state

**Files:**
- Modify: `lib/client.ts`
- Modify: `components/useStudio.ts`

**Interfaces:**
- Consumes: `GET /api/library` and `ResourceLibrary`.
- Produces: `studio.library`, `studio.libraryLoading`, and `studio.refreshLibrary()`.

- [x] **Step 1: Add the typed client request**

```ts
export const getResourceLibrary = () => api<ResourceLibrary>('/api/library');
```

- [x] **Step 2: Load and refresh global data**

Load projects, image configuration, and the resource library together during initialization. Refresh the library after successful saves, project creation/copy, generation completion, and project deletion so sidebar counts and previews remain current.

- [x] **Step 3: Run type checking**

Run: `npm run typecheck`

Expected: exit code 0.

### Task 3: Global resource views and navigation

**Files:**
- Create: `components/ResourceLibraries.tsx`
- Modify: `components/Studio.tsx`
- Modify: `lib/navigation.ts`
- Modify: `tests/navigation.test.ts`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `ResourceLibrary` and a callback `(projectId, section) => void`.
- Produces: global character and scene overview pages.

- [x] **Step 1: Write failing navigation tests**

Assert these stable URLs and restoration rules:

```ts
assert.equal(resourceLibraryLocation('characters'), '/?view=characters');
assert.equal(resourceLibraryLocation('scenes'), '/?view=scenes');
assert.equal(workspaceViewFromLocation('http://localhost:3000/?view=characters'), 'characters');
assert.equal(workspaceViewFromLocation('http://localhost:3000/?view=scenes'), 'scenes');
```

- [x] **Step 2: Run navigation tests and verify RED**

Run: `node --experimental-strip-types --test tests/navigation.test.ts`

Expected: missing export or mismatched URL assertion.

- [x] **Step 3: Implement global navigation**

The sidebar entries write the global view URL and unload the current project after saving. Browser reload/back restores the global page. Project-level top tabs retain their existing `setPage('characters' | 'scenes')` behavior.

- [x] **Step 4: Implement resource cards**

Characters show primary reference image, description, source project, reference count, and shot count. Scenes show selected/most recent preview, description, style, source project, candidate count, and shot count. Each card has an explicit action that opens the source project in the matching project editor.

- [x] **Step 5: Add responsive styles**

Use a reusable responsive grid, preserve the existing dark visual system, and collapse metadata cleanly on mobile.

- [x] **Step 6: Run focused and full checks**

Run:

```bash
node --experimental-strip-types --test tests/navigation.test.ts
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: all commands exit 0.

### Task 4: Integration verification and local commit

**Files:**
- Modify: `tests/http-smoke.mjs`

- [x] **Step 1: Extend HTTP smoke coverage**

After persisting a character and scene, request `/api/library` and assert both entries appear with the correct source project. Continue to avoid paid generation.

- [x] **Step 2: Run integration test**

Run: `npm run test:integration`

Expected: smoke test passes and reports global library persistence.

- [x] **Step 3: Review and commit locally**

Run `git diff --check`, inspect the final diff, and create one local commit. Do not push.
