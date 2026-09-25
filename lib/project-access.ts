import type { Project } from './types.ts';

// This reserved ID is served from the bundled sample, never from saved projects.
export const SAMPLE_PROJECT_ID = 'sample-summer-letter';

export function isReadOnlyProject(project: Pick<Project, 'id'> | null): boolean {
  return project?.id === SAMPLE_PROJECT_ID;
}
