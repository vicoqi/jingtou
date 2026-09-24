import type { Project, ProjectSummary, ReferenceImage } from './types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: init?.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init?.headers } });
  const data = await response.json().catch(() => ({ error: '服务暂时不可用，请稍后重试。' }));
  if (!response.ok) throw new ApiError(data.error || '操作失败，请重试。', response.status);
  return data;
}

export const listProjects = () => api<{ projects: ProjectSummary[] }>('/api/projects');
export const getProject = (id: string) => api<{ project: Project }>(`/api/projects/${id}`);
export const saveProject = (project: Project) => api<{ project: Project }>(`/api/projects/${project.id}`, { method: 'PUT', body: JSON.stringify({ project }) });
export async function uploadImage(file: File) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
  if (file.size > 10 * 1024 * 1024) throw new Error('单张图片不能超过 10 MB。');
  const body = new FormData(); body.append('file', file);
  return (await api<{ image: ReferenceImage }>('/api/upload', { method: 'POST', body })).image;
}
