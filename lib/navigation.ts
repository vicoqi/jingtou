import { SAMPLE_PROJECT_ID } from './project-access.ts';

export type HistoryMode = 'push' | 'replace' | 'none';
export type ProjectSection = 'shots' | 'characters' | 'scenes';
export type WorkspaceView = 'home' | 'projects' | 'characters' | 'scenes';

export function projectIdFromLocation(href: string): string | null {
  return new URL(href).searchParams.get('project')?.trim() || null;
}

export function projectLocation(id: string | null): string {
  return id ? `/?project=${encodeURIComponent(id)}` : '/';
}

export function workspaceViewFromLocation(href: string): WorkspaceView {
  const view = new URL(href).searchParams.get('view');
  return view === 'projects' || view === 'characters' || view === 'scenes' ? view : 'home';
}

export function isPublicStudioLocation(href:string):boolean {
  const id=projectIdFromLocation(href);
  return workspaceViewFromLocation(href)==='home' && (!id || id===SAMPLE_PROJECT_ID);
}

export function projectsLocation(): string {
  return '/?view=projects';
}

export function resourceLibraryLocation(section: Exclude<ProjectSection, 'shots'>): string {
  return `/?view=${section}`;
}

export function createProjectNavigation<T extends { id: string }>(ports: {
  current: () => T | null;
  save: () => Promise<void>;
  load: (id: string) => Promise<T>;
  show: (project: T | null) => void;
  write: (id: string | null, mode: Exclude<HistoryMode, 'none'>) => void;
  loading: (value: boolean) => void;
  error: (message: string) => void;
}) {
  let version = 0;
  return {
    get version() { return version; },
    cancel() { version++; },
    async navigate(id: string | null, mode: HistoryMode = 'push'): Promise<boolean> {
      const request = ++version;
      ports.loading(true);
      ports.error('');
      try {
        await ports.save();
        if (request !== version) return false;
        const project = id ? await ports.load(id) : null;
        if (request !== version) return false;
        ports.show(project);
        if (mode !== 'none') ports.write(project?.id ?? null, mode);
        return true;
      } catch (error) {
        if (request === version) {
          ports.write(ports.current()?.id ?? null, 'replace');
          ports.error(error instanceof Error ? error.message : '无法打开作品，请重试。');
        }
        return false;
      } finally {
        if (request === version) ports.loading(false);
      }
    },
  };
}
