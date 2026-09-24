import type { Project, Shot } from './types.ts';

export type ImageBytes = { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' | 'image/webp' };
export type ReferenceBytes = ImageBytes & { name: string };

export function detectImageMime(bytes: Uint8Array): ImageBytes['mime'] | null {
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n)) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP') return 'image/webp';
  return null;
}

export function buildShotPrompt(project: Project, shot: Shot): string {
  let referenceIndex = 1;
  const characters = shot.characterIds.map(id => {
    const character = project.characters.find(c => c.id === id);
    if (!character) throw new Error('Unknown character');
    if (!character.references.length) throw new Error(`Character ${character.name} needs a reference image`);
    const first = referenceIndex;
    referenceIndex += character.references.length;
    const range = first === referenceIndex - 1 ? `reference image ${first}` : `reference images ${first}–${referenceIndex - 1}`;
    return `${character.name}: ${character.description} (${range})`;
  });
  return [
    'Create one polished static frame for a Chinese animated short drama. Keep the people consistent with the provided character reference images. No speech bubbles, subtitles, watermarks, or text.',
    `Aspect ratio: ${project.aspectRatio}. Visual style: ${project.style || 'anime illustration'}.`,
    `Shot: ${shot.title}. Scene: ${shot.scene}. Action and composition: ${shot.description}.`,
    characters.length ? `Characters (reference images follow in the same order): ${characters.join('; ')}.` : 'No named characters.',
  ].join('\n');
}

export async function requestImageEdits(options: { key: string; model: string; baseUrl: string; prompt: string; count: number; images: ReferenceBytes[]; fetcher?: typeof fetch }): Promise<ImageBytes[]> {
  const { key, model, baseUrl, prompt, count, images, fetcher = fetch } = options;
  if (!key || !model || !Number.isInteger(count) || count < 1 || count > 4 || !images.length) throw new Error('Invalid image edit request');
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/localhost(?::\d+)?(?:\/|$)/.test(baseUrl)) throw new Error('Image provider URL must be HTTPS');
  const form = new FormData();
  form.set('model', model);
  form.set('prompt', prompt);
  form.set('n', String(count));
  for (const image of images) {
    if (detectImageMime(image.bytes) !== image.mime) throw new Error('Invalid reference image bytes');
    form.append('image[]', new Blob([new Uint8Array(image.bytes)], { type: image.mime }), image.name);
  }
  const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/images/edits`, { method:'POST', headers:{ Authorization:`Bearer ${key}` }, body:form, signal:AbortSignal.timeout(240_000) });
  return parseImageResponse(response,count);
}

export async function requestImageGeneration(options: { key: string; model: string; baseUrl: string; prompt: string; count: number; fetcher?: typeof fetch }): Promise<ImageBytes[]> {
  const {key,model,baseUrl,prompt,count,fetcher=fetch}=options;
  if (!key || !model || !Number.isInteger(count) || count<1 || count>4) throw new Error('Invalid image generation request');
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/localhost(?::\d+)?(?:\/|$)/.test(baseUrl)) throw new Error('Image provider URL must be HTTPS');
  const response=await fetcher(`${baseUrl.replace(/\/$/, '')}/images/generations`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model,prompt,n:count}),signal:AbortSignal.timeout(240_000)});
  return parseImageResponse(response,count);
}

async function parseImageResponse(response:Response,count:number):Promise<ImageBytes[]> {
  if (!response.ok) throw new Error(`Image provider failed (${response.status})`);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data) || body.data.length !== count) throw new Error('Image provider returned no valid images');
  return body.data.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('b64_json' in item) || typeof item.b64_json !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json)) throw new Error('Image provider returned an invalid image');
    const bytes = Uint8Array.from(atob(item.b64_json), c => c.charCodeAt(0));
    const mime = detectImageMime(bytes);
    if (!mime || bytes.length > 20 * 1024 * 1024) throw new Error('Image provider returned an invalid image');
    return { bytes, mime };
  });
}
