'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GenerationKind, Project, ProjectSummary } from '../lib/types';
import { api, getProject, listProjects, saveProject } from '../lib/client';
import { summarizeProject } from '../lib/domain';
import { createProjectNavigation, projectIdFromLocation, projectLocation } from '../lib/navigation';
import { isReadOnlyProject, SAMPLE_PROJECT_ID } from '../lib/project-access';

export function useStudio() {
  const [project, setProject] = useState<Project | null>(null);
  const current = useRef<Project | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [saveState, setSaveState] = useState('已保存');
  const [error, setError] = useState('');
  const [config, setConfig] = useState({ configured: false, model: '' });
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<Promise<void> | null>(null);
  const alive = useRef(true);
  const replace = useCallback((p: Project | null) => { current.current = p; setProject(p); }, []);
  const refreshList = useCallback(async () => { const result = await listProjects(); if (alive.current) setProjects(result.projects); }, []);
  const flush = useCallback(async function flushSave(): Promise<void> {
    clearTimeout(timer.current);
    if (pending.current) { await pending.current; if (dirty.current) await flushSave(); return; }
    const snapshot = current.current;
    if (!dirty.current || !snapshot) return;
    if (isReadOnlyProject(snapshot)) { dirty.current = false; return; }
    dirty.current = false; setSaveState('保存中…');
    const work = (async () => {
      try {
        const { project: saved } = await saveProject(snapshot);
        if (current.current?.id === saved.id) {
          const next = current.current === snapshot ? saved : { ...current.current, revision: saved.revision, updatedAt: saved.updatedAt };
          replace(next);
        }
        setSaveState(dirty.current ? '等待保存…' : '已保存'); setError('');
        setProjects(items => items.map(item => item.id === saved.id ? summarizeProject(saved) : item));
      } catch (e) {
        dirty.current = true; setSaveState('保存失败'); setError((e as Error).message); throw e;
      }
    })();
    pending.current = work;
    try { await work; } finally { pending.current = null; }
    if (dirty.current) await flushSave();
  }, [replace]);
  const update = useCallback((fn: (p: Project) => Project) => {
    if (!current.current || isReadOnlyProject(current.current)) return;
    replace(fn(current.current)); dirty.current = true; setSaveState('等待保存…');
    clearTimeout(timer.current); timer.current = setTimeout(() => { void flush().catch(() => {}); }, 600);
  }, [replace, flush]);
  const writeLocation = useCallback((id: string | null, mode: 'push' | 'replace') => {
    const url = projectLocation(id);
    if (mode === 'push' && `${window.location.pathname}${window.location.search}${window.location.hash}` === url) return;
    window.history[mode === 'push' ? 'pushState' : 'replaceState'](window.history.state, '', url);
  }, []);
  const navigation = useMemo(() => createProjectNavigation<Project>({
    current: () => current.current,
    save: flush,
    load: async id => (await getProject(id)).project,
    show: replace,
    write: writeLocation,
    loading: setNavigating,
    error: setError,
  }), [flush, replace, writeLocation]);
  useEffect(() => {
    let active = true;
    alive.current = true;
    const initialVersion = navigation.version;
    Promise.all([listProjects(), api<{ configured: boolean; model: string }>('/api/config')]).then(async ([list, settings]) => {
      if (!active) return;
      setProjects(list.projects); setConfig(settings);
      if (navigation.version === initialVersion) await navigation.navigate(projectIdFromLocation(window.location.href), 'none');
    }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty.current || pending.current) { event.preventDefault(); event.returnValue = ''; } };
    const popState = () => { void navigation.navigate(projectIdFromLocation(window.location.href), 'none'); };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('popstate', popState);
    return () => { active = false; alive.current = false; navigation.cancel(); clearTimeout(timer.current); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('popstate', popState); };
  }, [navigation]);
  const generating = [...(project?.shots ?? []), ...(project?.scenes ?? [])].some(s => s.status === 'generating');
  const projectId = project?.id;
  useEffect(() => {
    if (!generating || working || !projectId) return;
    const interval = setInterval(() => {
      if (dirty.current || pending.current) return;
      void getProject(projectId).then(r => { if (current.current?.id === projectId && !dirty.current && !pending.current) replace(r.project); }).catch(e => setError(e.message));
    }, 3000);
    return () => clearInterval(interval);
  }, [generating, working, projectId, replace]);
  async function open(id: string) {
    if (await navigation.navigate(id)) await refreshList().catch(e => setError(e.message));
  }
  async function home() {
    const opened = await navigation.navigate(null);
    if (opened) await refreshList().catch(e => setError(e.message));
    return opened;
  }
  async function createAndOpen(path: string, body?: { name: string; style?: string }) {
    setWorking(true); setError('');
    const version = navigation.version;
    try {
      await flush();
      const result = await api<{ project: Project }>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      if (navigation.version === version) { replace(result.project); setSaveState('已保存'); writeLocation(result.project.id, 'push'); }
      await refreshList(); return true;
    }
    catch (e) { setError((e as Error).message); return false; } finally { setWorking(false); }
  }
  const create = (name: string, style: string) => createAndOpen('/api/projects', { name, style });
  const openSample = () => open(SAMPLE_PROJECT_ID);
  const copySample = () => isReadOnlyProject(current.current)
    ? createAndOpen(`/api/projects/${SAMPLE_PROJECT_ID}/copy`)
    : Promise.resolve(false);
  async function generate(shotId: string, count: number, kind: GenerationKind = 'shots') {
    if (!current.current || isReadOnlyProject(current.current)) return;
    setWorking(true); setError('');
    const id = current.current.id;
    const version = navigation.version;
    try {
      await flush();
      if (current.current?.id !== id || navigation.version !== version) return;
      replace({ ...current.current!, [kind]: (current.current![kind] ?? []).map(s => s.id === shotId ? { ...s, status: 'generating', error: null } : s) });
      const endpoint = kind === 'scenes' ? 'generate-scene' : 'generate';
      const target = kind === 'scenes' ? { sceneId: shotId } : { shotId };
      const result = await api<{ project: Project }>(`/api/projects/${id}/${endpoint}`, { method: 'POST', body: JSON.stringify({ ...target, count }) });
      if (current.current?.id === id && navigation.version === version) replace(result.project);
      await refreshList();
    } catch (e) {
      const message = (e as Error).message;
      try {
        if (!dirty.current && current.current?.id === id && navigation.version === version) {
          const result = await getProject(id);
          if (!dirty.current && current.current?.id === id && navigation.version === version) replace(result.project);
        }
      } catch { /* Keep last loaded data visible. */ }
      if (navigation.version === version) setError(message);
    } finally { setWorking(false); }
  }
  async function remove() {
    if (!current.current || isReadOnlyProject(current.current)) return;
    setWorking(true);
    const id = current.current.id;
    try {
      await flush(); await api(`/api/projects/${id}`, { method: 'DELETE' });
      if (current.current?.id === id) { await navigation.navigate(null, 'replace'); dirty.current = false; setSaveState('已保存'); }
      await refreshList();
    }
    catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  }
  async function reload() {
    if (!current.current) { window.location.reload(); return; }
    setWorking(true);
    const id = current.current.id;
    const version = navigation.version;
    try {
      const result = await getProject(id);
      if (current.current?.id === id && navigation.version === version) { dirty.current = false; replace(result.project); setError(''); setSaveState('已保存'); }
    }
    catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  }
  const generateScene = (sceneId: string, count: number) => generate(sceneId, count, 'scenes');
  return { project, projects, loading, busy: working || navigating || generating, readOnly: isReadOnlyProject(project), saveState, error, setError, config, update, open, openSample, copySample, home, create, generate, generateScene, remove, flush, reload };
}
