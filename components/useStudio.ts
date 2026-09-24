'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, ProjectSummary } from '../lib/types';
import { api, getProject, listProjects, saveProject } from '../lib/client';
import { summarizeProject } from '../lib/domain';

export function useStudio() {
  const [project, setProject] = useState<Project | null>(null);
  const current = useRef<Project | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
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
    if (!current.current) return;
    replace(fn(current.current)); dirty.current = true; setSaveState('等待保存…');
    clearTimeout(timer.current); timer.current = setTimeout(() => { void flush().catch(() => {}); }, 600);
  }, [replace, flush]);
  useEffect(() => {
    alive.current = true;
    Promise.all([listProjects(), api<{ configured: boolean; model: string }>('/api/config')]).then(async ([list, settings]) => {
      if (!alive.current) return;
      setProjects(list.projects); setConfig(settings);
      if (list.projects[0]) { const result = await getProject(list.projects[0].id); if (alive.current) replace(result.project); }
    }).catch(e => { if (alive.current) setError(e.message); }).finally(() => { if (alive.current) setLoading(false); });
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty.current || pending.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { alive.current = false; clearTimeout(timer.current); window.removeEventListener('beforeunload', beforeUnload); };
  }, [replace]);
  const generating = project?.shots.some(s => s.status === 'generating') ?? false;
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
    setWorking(true); setError('');
    try { await flush(); const result = await getProject(id); replace(result.project); await refreshList(); }
    catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  }
  async function create(name: string, demo = false) {
    setWorking(true); setError('');
    try { await flush(); const result = await api<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ name, demo }) }); replace(result.project); await refreshList(); return true; }
    catch (e) { setError((e as Error).message); return false; } finally { setWorking(false); }
  }
  async function generate(shotId: string, count: number) {
    if (!current.current) return;
    setWorking(true); setError('');
    const id = current.current.id;
    try {
      await flush();
      replace({ ...current.current!, shots: current.current!.shots.map(s => s.id === shotId ? { ...s, status: 'generating', error: null } : s) });
      const result = await api<{ project: Project }>(`/api/projects/${id}/generate`, { method: 'POST', body: JSON.stringify({ shotId, count }) });
      replace(result.project); await refreshList();
    } catch (e) {
      const message = (e as Error).message;
      try { if (!dirty.current) replace((await getProject(id)).project); } catch { /* Keep last loaded data visible. */ }
      setError(message);
    } finally { setWorking(false); }
  }
  async function remove() {
    if (!current.current) return;
    setWorking(true);
    try { await flush(); await api(`/api/projects/${current.current.id}`, { method: 'DELETE' }); replace(null); dirty.current = false; setSaveState('已保存'); await refreshList(); }
    catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  }
  async function reload() {
    if (!current.current) { window.location.reload(); return; }
    setWorking(true);
    try { const result = await getProject(current.current.id); dirty.current = false; replace(result.project); setError(''); setSaveState('已保存'); }
    catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  }
  return { project, projects, loading, busy: working || generating, saveState, error, setError, config, update, open, create, generate, remove, flush, reload };
}
