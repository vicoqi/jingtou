'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Character, GenerationKind, Project, ProjectSummary, ReferenceImage, ResourceLibrary } from '../lib/types';
import { api, ApiError, EMPTY_WORKSPACE_CONFIG, generateCharacterImages, generateShotAudio, getProject, getResourceLibrary, listProjects, loadWorkspace, saveProject } from '../lib/client';
import { rebaseProjectEdits, summarizeProject } from '../lib/domain';
import { createProjectNavigation, projectIdFromLocation, projectLocation } from '../lib/navigation';
import { canDeleteProject, isReadOnlyProject, SAMPLE_PROJECT_ID } from '../lib/project-access';
import { isWorkspaceBusy, mergeGenerationAcknowledgement, selectNewerProject } from '../lib/workspace-state';

export function useStudio(authenticated:boolean) {
  const [project, setProject] = useState<Project | null>(null);
  const current = useRef<Project | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [library, setLibrary] = useState<ResourceLibrary>({ characters: [], scenes: [] });
  const [libraryLoading, setLibraryLoading] = useState(authenticated);
  const [loading, setLoading] = useState(authenticated);
  const [working, setWorking] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [saveState, setSaveState] = useState('已保存');
  const [error, setError] = useState('');
  const [config, setConfig] = useState(() => structuredClone(EMPTY_WORKSPACE_CONFIG));
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<Promise<void> | null>(null);
  const alive = useRef(true);
  const libraryRequest = useRef(0);
  const replace = useCallback((p: Project | null) => { current.current = p; setProject(p); }, []);
  const refreshList = useCallback(async () => { if (!authenticated) return; const result = await listProjects(); if (alive.current) setProjects(result.projects); }, [authenticated]);
  const refreshLibrary = useCallback(async () => {
    if (!authenticated) return;
    const request = ++libraryRequest.current;
    setLibraryLoading(true);
    try {
      const result = await getResourceLibrary();
      if (alive.current && request === libraryRequest.current) setLibrary(result);
    } catch (e) {
      if (alive.current && request === libraryRequest.current) setError((e as Error).message);
    } finally {
      if (alive.current && request === libraryRequest.current) setLibraryLoading(false);
    }
  }, [authenticated]);
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
        void refreshLibrary();
      } catch (caught) {
        if (caught instanceof ApiError && caught.status===409 && current.current?.id===snapshot.id) {
          try {
            const latest=await getProject(snapshot.id);
            if (current.current?.id===snapshot.id) {
              replace(rebaseProjectEdits(current.current,latest.project));
              dirty.current=true;
              setSaveState('等待保存…');
              return;
            }
          } catch { /* Report the original save conflict below. */ }
        }
        dirty.current = true; setSaveState('保存失败'); setError((caught as Error).message); throw caught;
      }
    })();
    pending.current = work;
    try { await work; } finally { pending.current = null; }
    if (dirty.current) await flushSave();
  }, [replace, refreshLibrary]);
  const update = useCallback((fn: (p: Project) => Project) => {
    if (!authenticated || !current.current || isReadOnlyProject(current.current)) return;
    replace(fn(current.current)); dirty.current = true; setSaveState('等待保存…');
    clearTimeout(timer.current); timer.current = setTimeout(() => { void flush().catch(() => {}); }, 600);
  }, [authenticated, replace, flush]);
  const writeLocation = useCallback((id: string | null, mode: 'push' | 'replace') => {
    const url = projectLocation(id);
    if (mode === 'push' && `${window.location.pathname}${window.location.search}${window.location.hash}` === url) return;
    window.history[mode === 'push' ? 'pushState' : 'replaceState'](window.history.state, '', url);
  }, []);
  const navigation = useMemo(() => createProjectNavigation<Project>({
    current: () => current.current,
    save: flush,
    load: async id => {
      if (!authenticated && id!==SAMPLE_PROJECT_ID) throw new Error('请先登录后打开作品。');
      return (await getProject(id)).project;
    },
    show: replace,
    write: writeLocation,
    loading: setNavigating,
    error: setError,
  }), [authenticated, flush, replace, writeLocation]);
  useEffect(() => {
    let active = true;
    alive.current = true;
    const initialVersion = navigation.version;
    const visibleProjectId=()=>{
      const id=projectIdFromLocation(window.location.href);
      return authenticated || id===SAMPLE_PROJECT_ID ? id : null;
    };
    loadWorkspace(authenticated).then(async ([list, settings, resources]) => {
      if (!active) return;
      setProjects(list.projects); setConfig(settings); setLibrary(resources); setLibraryLoading(false);
      if (navigation.version === initialVersion) await navigation.navigate(visibleProjectId(), 'none');
    }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) { setLoading(false); setLibraryLoading(false); } });
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty.current || pending.current) { event.preventDefault(); event.returnValue = ''; } };
    const popState = () => { void navigation.navigate(visibleProjectId(), 'none'); };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('popstate', popState);
    return () => { active = false; alive.current = false; navigation.cancel(); clearTimeout(timer.current); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('popstate', popState); };
  }, [authenticated,navigation]);
  const generating = [...(project?.shots ?? []), ...(project?.scenes ?? [])].some(s => s.status === 'generating') || (project?.shots ?? []).some(s=>s.audio.status==='generating');
  const projectId = project?.id;
  useEffect(() => {
    if (!generating || working || !projectId) return;
    const interval = setInterval(() => {
      if (dirty.current || pending.current) return;
      void getProject(projectId).then(r => { if (current.current?.id === projectId && !dirty.current && !pending.current) replace(selectNewerProject(current.current,r.project)); }).catch(e => setError(e.message));
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
    if (!authenticated) return false;
    setWorking(true); setError('');
    const version = navigation.version;
    try {
      await flush();
      const result = await api<{ project: Project }>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      if (navigation.version === version) { replace(result.project); setSaveState('已保存'); writeLocation(result.project.id, 'push'); }
      await refreshList(); void refreshLibrary(); return true;
    }
    catch (e) { setError((e as Error).message); return false; } finally { setWorking(false); }
  }
  const create = (name: string, style: string) => createAndOpen('/api/projects', { name, style });
  const openSample = () => open(SAMPLE_PROJECT_ID);
  const copySample = () => isReadOnlyProject(current.current)
    ? createAndOpen(`/api/projects/${SAMPLE_PROJECT_ID}/copy`)
    : Promise.resolve(false);
  async function receiveGenerationAcknowledgement(incoming:Project,version:number) {
    if (current.current?.id!==incoming.id || navigation.version!==version) return;
    const saving=pending.current;
    const hasLocalEdits=dirty.current || saving!==null;
    replace(mergeGenerationAcknowledgement(current.current,incoming,hasLocalEdits));
    if (!hasLocalEdits) return;
    // An early autosave can fail before the server supplies the audio job ID.
    // Finish that attempt, then persist edits against the acknowledged revision.
    await saving?.catch(()=>{});
    if (current.current?.id===incoming.id && navigation.version===version && dirty.current) await flush();
  }
  async function generate(shotId: string, count: number, kind: GenerationKind = 'shots') {
    if (!authenticated || !current.current || isReadOnlyProject(current.current)) return;
    setError('');
    const id = current.current.id;
    const version = navigation.version;
    try {
      await flush();
      if (current.current?.id !== id || navigation.version !== version) return;
      replace({ ...current.current!, [kind]: (current.current![kind] ?? []).map(s => s.id === shotId ? { ...s, status: 'generating', error: null } : s) });
      const endpoint = kind === 'scenes' ? 'generate-scene' : 'generate';
      const target = kind === 'scenes' ? { sceneId: shotId } : { shotId };
      const result = await api<{ project: Project }>(`/api/projects/${id}/${endpoint}`, { method: 'POST', body: JSON.stringify({ ...target, count }) });
      await receiveGenerationAcknowledgement(result.project,version);
      await refreshList(); void refreshLibrary();
    } catch (e) {
      const message = (e as Error).message;
      try {
        if (!dirty.current && current.current?.id === id && navigation.version === version) {
          const result = await getProject(id);
          if (!dirty.current && current.current?.id === id && navigation.version === version) replace(result.project);
        }
      } catch { /* Keep last loaded data visible. */ }
      if (navigation.version === version) setError(message);
    }
  }
  async function removeProject(id: string):Promise<boolean> {
    if (!authenticated) return false;
    if (!canDeleteProject({id})) { setError('预设样例作品不可删除。'); return false; }
    setWorking(true);
    try {
      if (current.current?.id === id) await flush();
      await api(`/api/projects/${id}`, { method: 'DELETE' });
      if (current.current?.id === id) { await navigation.navigate(null, 'replace'); dirty.current = false; setSaveState('已保存'); }
      await refreshList(); await refreshLibrary(); return true;
    }
    catch (e) { setError((e as Error).message); return false; } finally { setWorking(false); }
  }
  async function remove():Promise<boolean> { return current.current ? removeProject(current.current.id) : false; }
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
  async function generateCharacter(draft:Pick<Character,'name'|'description'>,count:number):Promise<ReferenceImage[]> {
    if (!authenticated || !current.current || isReadOnlyProject(current.current)) throw new Error('当前作品不能生成角色参考图。');
    setWorking(true); setError('');
    const id=current.current.id;
    const version=navigation.version;
    try {
      await flush();
      if (current.current?.id!==id || navigation.version!==version) throw new Error('作品已切换，请重新生成。');
      const result=await generateCharacterImages(id,{name:draft.name,description:draft.description,count});
      if (current.current?.id!==id || navigation.version!==version) throw new Error('作品已切换，请重新生成。');
      return result.images;
    } catch (e) {
      const message=e instanceof Error ? e.message : '角色参考图生成失败，请重试。';
      if (navigation.version===version) setError(message);
      throw e instanceof Error ? e : new Error(message);
    } finally { setWorking(false); }
  }
  async function generateAudio(shotId:string) {
    if (!authenticated || !current.current || isReadOnlyProject(current.current)) return;
    setError('');
    const id=current.current.id;
    const version=navigation.version;
    try {
      await flush();
      if (current.current?.id!==id || navigation.version!==version) return;
      replace({...current.current,shots:current.current.shots.map(shot=>shot.id===shotId ? {...shot,audio:{...shot.audio,status:'generating',error:null}} : shot)});
      const result=await generateShotAudio(id,shotId);
      await receiveGenerationAcknowledgement(result.project,version);
      await refreshList();
    } catch (e) {
      const message=(e as Error).message;
      try {
        if (!dirty.current && current.current?.id===id && navigation.version===version) {
          const result=await getProject(id);
          if (!dirty.current && current.current?.id===id && navigation.version===version) replace(result.project);
        }
      } catch { /* Keep last loaded data visible. */ }
      if (navigation.version===version) setError(message);
    }
  }
  return { project, projects, library, libraryLoading, loading, busy: isWorkspaceBusy({working,navigating,generating}), readOnly: isReadOnlyProject(project), saveState, error, setError, config, update, open, openSample, copySample, home, create, generate, generateScene, generateCharacter, generateAudio, remove, removeProject, flush, reload, refreshLibrary };
}
