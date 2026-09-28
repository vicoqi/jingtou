import type { AuthUser, Project, ProjectSummary, ReferenceImage, ResourceLibrary } from './types';

export type WorkspaceConfig = { configured:boolean; model:string; speech:{configured:boolean;id:'qwen';provider:string;model:string;voices:{female:string;male:string}} };
export const EMPTY_WORKSPACE_CONFIG:WorkspaceConfig = { configured:false, model:'', speech:{configured:false,id:'qwen',provider:'阿里云百炼',model:'qwen3-tts-instruct-flash',voices:{female:'女声',male:'男声'}} };

let currentUserId:string | null=null;
export function setClientUser(user:AuthUser | null):void { currentUserId=user?.id ?? null; }

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const requestUserId=currentUserId;
  const authRequest=url.startsWith('/api/auth/');
  const headers=new Headers(init?.headers);
  if (!(init?.body instanceof FormData)) headers.set('Content-Type','application/json');
  if (requestUserId) headers.set('X-Jingtou-User',requestUserId);
  const response = await fetch(url, { ...init, headers, credentials:'same-origin', cache:'no-store' });
  const data = await response.json().catch(() => ({ error: '服务暂时不可用，请稍后重试。' }));
  if (!authRequest && requestUserId!==currentUserId) throw new ApiError('账号已切换，请重试。',409);
  if (response.status===401 && (!authRequest || url==='/api/auth/logout') && requestUserId===currentUserId && typeof window!=='undefined') window.dispatchEvent(new Event('jingtou:unauthorized'));
  if (!response.ok) throw new ApiError(data.error || '操作失败，请重试。', response.status);
  return data;
}

export const listProjects = () => api<{ projects: ProjectSummary[] }>('/api/projects');
export const getResourceLibrary = () => api<ResourceLibrary>('/api/library');
export async function loadWorkspace(authenticated:boolean):Promise<[{projects:ProjectSummary[]},WorkspaceConfig,ResourceLibrary]> {
  if (!authenticated) return [{projects:[]},structuredClone(EMPTY_WORKSPACE_CONFIG),{characters:[],scenes:[]}];
  return Promise.all([listProjects(),api<WorkspaceConfig>('/api/config'),getResourceLibrary()]);
}
export const getProject = (id: string) => api<{ project: Project }>(`/api/projects/${id}`);
export const saveProject = (project: Project) => api<{ project: Project }>(`/api/projects/${project.id}`, { method: 'PUT', body: JSON.stringify({ project }) });
export const generateCharacterImages = (projectId:string,input:{name:string;description:string;count:number}) => api<{images:ReferenceImage[]}>(`/api/projects/${projectId}/generate-character`,{method:'POST',body:JSON.stringify(input)});
export const generateShotAudio = (projectId:string,shotId:string) => api<{project:Project}>(`/api/projects/${projectId}/generate-audio`,{method:'POST',body:JSON.stringify({shotId})});
export async function uploadImage(file: File) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
  if (file.size > 10 * 1024 * 1024) throw new Error('单张图片不能超过 10 MB。');
  const body = new FormData(); body.append('file', file);
  return (await api<{ image: ReferenceImage }>('/api/upload', { method: 'POST', body })).image;
}
