export type HistoryMode = 'push' | 'replace' | 'none';
export type ProjectSection = 'shots' | 'characters' | 'scenes';

export function projectIdFromLocation(href: string): string | null {
  return new URL(href).searchParams.get('project')?.trim() || null;
}

export function projectLocation(id: string | null): string {
  return id ? `/?project=${encodeURIComponent(id)}` : '/';
}

export function workspaceViewFromLocation(href: string): 'home' | 'projects' {
  return new URL(href).searchParams.get('view') === 'projects' ? 'projects' : 'home';
}

export function projectSectionFromLocation(href: string): ProjectSection {
  const target = new URL(href).searchParams.get('target');
  return target === 'characters' || target === 'scenes' ? target : 'shots';
}

export function projectsLocation(target: ProjectSection = 'shots'): string {
  return target === 'shots' ? '/?view=projects' : `/?view=projects&target=${target}`;
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
