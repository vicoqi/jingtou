'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Character, GenerationKind, Project, ProjectSummary, ReferenceImage, ResourceLibrary, VideoSource } from '../lib/types';
import { api, ApiError, EMPTY_WORKSPACE_CONFIG, generateCharacterImages, generateShotAudio, generateShotVideo, generateStoryboard, getProject, getResourceLibrary, listProjects, loadWorkspace, saveProject } from '../lib/client';
import { generationDeletionConflict, rebaseProjectEdits, shotVideoSource, summarizeProject } from '../lib/domain';
import { videoFrameEditConflict } from '../lib/video-frames';
import { createProjectNavigation, projectIdFromLocation, projectLocation } from '../lib/navigation';
import { canDeleteProject, isReadOnlyProject, SAMPLE_PROJECT_ID } from '../lib/project-access';
import { isWorkspaceBusy, mergeGenerationAcknowledgement, selectNewerProject } from '../lib/workspace-state';
import { newId } from '../lib/id';

type PendingShotJob = { projectId:string; shotId:string; kind:GenerationKind|'audio'|'video'; frame?:'start'|'end'; generationId:string; startedAt:string; source?:VideoSource };
const pendingGenerationState = (job:PendingShotJob) => ({status:'generating' as const,error:null,generationId:job.generationId,generationStartedAt:job.startedAt});

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
  const pendingShotJobs = useRef(new Map<string,PendingShotJob>());
  const replace = useCallback((p: Project | null) => {
    // Another job's acknowledgement, a poll, or a save conflict can arrive before
    // this POST returns. Retain its optimistic locks until its own response arrives.
    const jobs=[...pendingShotJobs.current.values()].filter(job=>job.projectId===p?.id);
    const next=p && jobs.length ? {...p,
      shots:p.shots.map(shot=>jobs.filter(job=>job.kind!=='scenes' && job.shotId===shot.id).reduce((item,job)=>{
        if (job.kind==='shots') return {...item,...pendingGenerationState(job),generationFrame:job.frame};
        if (job.kind==='audio' || job.kind==='video') return {...item,[job.kind]:{...item[job.kind],...pendingGenerationState(job),...(job.kind==='video' ? {source:job.source} : {})}};
        return item;
      },shot)),
      scenes:(p.scenes ?? []).map(scene=>jobs.filter(job=>job.kind==='scenes' && job.shotId===scene.id).reduce((item,job)=>({...item,...pendingGenerationState(job)}),scene)),
    } : p;
    current.current = next;
    setProject(next);
  }, []);
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
    const proposed=fn(current.current);
    const conflict=videoFrameEditConflict(current.current,proposed) || generationDeletionConflict(current.current,proposed);
    if (conflict) { setError(conflict); return; }
    replace(proposed); dirty.current = true; setSaveState('等待保存…');
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
  const generatingFrames = [...(project?.shots ?? []), ...(project?.scenes ?? [])].some(s => s.status === 'generating') || (project?.shots ?? []).some(s=>s.audio.status==='generating');
  const generatingVideos = (project?.shots ?? []).some(s=>s.video.status==='generating');
  const storyboardGenerating = project?.storyboardDraft?.status === 'generating';
  const generating = generatingFrames || generatingVideos || storyboardGenerating;
  const projectId = project?.id;
  useEffect(() => {
    if (!generating || working || !projectId) return;
    // Storyboard LLM calls run 30–60s and wan video tasks run minutes with no intermediate
    // state to show; poll slower than image/audio jobs. Video polls also trigger server-side
    // task queries, so a longer interval keeps provider traffic reasonable.
    const interval = setInterval(() => {
      if (dirty.current || pending.current) return;
      void getProject(projectId).then(r => { if (current.current?.id === projectId && !dirty.current && !pending.current) replace(selectNewerProject(current.current,r.project)); }).catch(e => setError(e.message));
    }, generatingFrames ? 3000 : storyboardGenerating ? 8000 : 10000);
    return () => clearInterval(interval);
  }, [generating, generatingFrames, storyboardGenerating, working, projectId, replace]);
  async function open(id: string) {
    if (await navigation.navigate(id)) await refreshList().catch(e => setError(e.message));
  }
  async function home() {
    const opened = await navigation.navigate(null);
    if (opened) await refreshList().catch(e => setError(e.message));
    return opened;
  }
  async function createAndOpen(path: string, body?: { name: string; style?: string; story?: string; count?: number | null }) {
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
  const create = (name: string, style: string, story = '', count: number | null = null) => createAndOpen('/api/projects', story ? { name, style, story, count: count ?? undefined } : { name, style });
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
  async function generate(shotId: string, count: number, kind: GenerationKind = 'shots', frame: 'start' | 'end' = 'start') {
    const endpoint = kind === 'scenes' ? 'generate-scene' : 'generate';
    const target = kind === 'scenes' ? { sceneId: shotId } : { shotId };
    await submitShotJob(shotId,kind,id=>api<{project:Project}>(`/api/projects/${id}/${endpoint}`,{method:'POST',body:JSON.stringify({...target,count,...(kind==='shots' ? {frame} : {})})}),frame);
    void refreshLibrary();
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
  const generateEndFrame = (shotId: string, count: number) => generate(shotId, count, 'shots', 'end');
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
  async function submitShotJob(shotId:string,kind:GenerationKind|'audio'|'video',call:(id:string)=>Promise<{project:Project}>,frame?:'start'|'end') {
    if (!authenticated || !current.current || isReadOnlyProject(current.current)) return;
    setError('');
    const id=current.current.id;
    const version=navigation.version;
    const jobKey=`${id}:${shotId}:${kind}`;
    if (pendingShotJobs.current.has(jobKey)) return;
    let job:PendingShotJob | null=null;
    const clearJob=()=>{ if (job && pendingShotJobs.current.get(jobKey)===job) pendingShotJobs.current.delete(jobKey); };
    try {
      await flush();
      if (current.current?.id!==id || navigation.version!==version) return;
      const shot=current.current.shots.find(item=>item.id===shotId);
      const state=kind==='shots' ? shot : kind==='scenes' ? current.current.scenes?.find(item=>item.id===shotId) : shot?.[kind];
      if (!state || state.status==='generating' || pendingShotJobs.current.has(jobKey)) return;
      job={projectId:id,shotId,kind,generationId:newId(),startedAt:new Date().toISOString(),
        ...(kind==='shots' ? {frame} : {}),...(kind==='video' ? {source:shotVideoSource(current.current,shot!)} : {})};
      pendingShotJobs.current.set(jobKey,job);
      replace(current.current);
      const result=await call(id);
      clearJob();
      await receiveGenerationAcknowledgement(result.project,version);
      await refreshList();
    } catch (e) {
      clearJob();
      const message=(e as Error).message;
      try {
        if (current.current?.id===id && navigation.version===version) {
          const result=await getProject(id);
          if (current.current?.id===id && navigation.version===version) replace(mergeGenerationAcknowledgement(current.current,result.project,dirty.current || !!pending.current));
        }
      } catch { /* Keep last loaded data visible. */ }
      if (navigation.version===version) setError(message);
    }
  }
  async function generateAudio(shotId:string) {
    await submitShotJob(shotId,'audio',id=>generateShotAudio(id,shotId));
  }
  async function generateVideo(shotId:string) {
    await submitShotJob(shotId,'video',id=>generateShotVideo(id,shotId));
  }
  async function storyboard(story: string, count: number | null): Promise<boolean> {
    if (!authenticated || !current.current || isReadOnlyProject(current.current)) return false;
    setError('');
    const id = current.current.id;
    const version = navigation.version;
    try {
      await flush();
      if (current.current?.id !== id || navigation.version !== version) return false;
      const result = await generateStoryboard(id, { story, count });
      await receiveGenerationAcknowledgement(result.project, version);
      return true;
    } catch (e) {
      const message = (e as Error).message;
      try {
        if (!dirty.current && current.current?.id === id && navigation.version === version) {
          const result = await getProject(id);
          if (!dirty.current && current.current?.id === id && navigation.version === version) replace(result.project);
        }
      } catch { /* Keep last loaded data visible. */ }
      if (navigation.version === version) setError(message);
      return false;
    }
  }
  return { project, projects, library, libraryLoading, loading, busy: isWorkspaceBusy({working,navigating,generating}), readOnly: isReadOnlyProject(project), saveState, error, setError, config, update, open, openSample, copySample, home, create, generate, generateEndFrame, generateScene, generateCharacter, generateAudio, generateVideo, generateStoryboard: storyboard, remove, removeProject, flush, reload, refreshLibrary };
}
