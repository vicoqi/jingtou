import type { Project, Shot } from './types.ts';

export type ImageBytes = { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' | 'image/webp' };
export type ReferenceBytes = ImageBytes & { name: string };
type AspectRatio = Project['aspectRatio'];

function is97Api(baseUrl: string): boolean {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  return hostname === '97api.com' || hostname.endsWith('.97api.com');
}

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
    characters.length
      ? 'Create one polished static frame for a short drama. Keep the people consistent with the provided character reference images. No speech bubbles, subtitles, watermarks, or text.'
      : 'Create one polished static frame for a short drama. No speech bubbles, subtitles, watermarks, or text.',
    `Visual style: ${project.style || 'anime illustration'}.`,
    `Shot: ${shot.title}. Scene: ${shot.scene}. Action and composition: ${shot.description}.`,
    characters.length ? `Characters (reference images follow in the same order): ${characters.join('; ')}.` : 'No named characters.',
  ].join('\n');
}

export async function requestImageEdits(options: { key: string; model: string; baseUrl: string; prompt: string; count: number; aspectRatio: AspectRatio; images: ReferenceBytes[]; fetcher?: typeof fetch }): Promise<ImageBytes[]> {
  const { key, model, baseUrl, prompt, count, images, fetcher = fetch } = options;
  if (!key || !model || !Number.isInteger(count) || count < 1 || count > 4 || !images.length) throw new Error('Invalid image edit request');
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/localhost(?::\d+)?(?:\/|$)/.test(baseUrl)) throw new Error('Image provider URL must be HTTPS');
  for (const image of images) if (detectImageMime(image.bytes) !== image.mime) throw new Error('Invalid reference image bytes');
  return Promise.all(Array.from({length:count},async () => {
    const form = new FormData();
    form.set('model', model);
    form.set('prompt', prompt);
    form.set('n', '1');
    form.set('response_format', 'b64_json');
    for (const image of images) form.append('image', new Blob([new Uint8Array(image.bytes)], { type: image.mime }), image.name);
    const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/images/edits`, { method:'POST', headers:{ Authorization:`Bearer ${key}` }, body:form, signal:AbortSignal.timeout(300_000) });
    return (await parseImageResponse(response,1,fetcher))[0];
  }));
}

export async function requestImageGeneration(options: { key: string; model: string; baseUrl: string; prompt: string; count: number; aspectRatio: AspectRatio; fetcher?: typeof fetch }): Promise<ImageBytes[]> {
  const {key,model,baseUrl,prompt,count,fetcher=fetch}=options;
  if (!key || !model || !Number.isInteger(count) || count<1 || count>4) throw new Error('Invalid image generation request');
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/localhost(?::\d+)?(?:\/|$)/.test(baseUrl)) throw new Error('Image provider URL must be HTTPS');
  return Promise.all(Array.from({length:count},async () => {
    const providerFields = is97Api(baseUrl)
      ? { size:'1254x1254', quality:'high', output_format:'webp', response_format:'url' }
      : { response_format:'b64_json' };
    const response=await fetcher(`${baseUrl.replace(/\/$/, '')}/images/generations`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model,prompt,n:1,...providerFields}),signal:AbortSignal.timeout(300_000)});
    return (await parseImageResponse(response,1,fetcher,is97Api(baseUrl)))[0];
  }));
}

function externalImageUrl(value:string):URL | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[')) return null;
  return url;
}

async function parseImageResponse(response:Response,count:number,fetcher:typeof fetch,allowExternalImageUrl=false):Promise<ImageBytes[]> {
  if (!response.ok) {
    const raw = await response.text().catch(()=>'');
    let detail = '';
    if (raw && response.headers.get('content-type')?.includes('json')) {
      try {
        const body: unknown = JSON.parse(raw);
        if (body && typeof body === 'object') {
          const error = 'error' in body ? body.error : undefined;
          if (typeof error === 'string') detail = error;
          else if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') detail = error.message;
          else if ('message' in body && typeof body.message === 'string') detail = body.message;
        }
      } catch { /* Keep the status-only fallback for malformed responses. */ }
    }
    detail = detail.replace(/[\r\n\t]+/g,' ').trim().slice(0,400);
    throw new Error(`Image provider failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data) || body.data.length !== count) throw new Error('Image provider returned no valid images');
  return Promise.all(body.data.map(async (item: unknown) => {
    let bytes: Uint8Array;
    if (item && typeof item === 'object' && 'b64_json' in item && typeof item.b64_json === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json)) {
      bytes = Uint8Array.from(atob(item.b64_json), c => c.charCodeAt(0));
    } else if (allowExternalImageUrl && item && typeof item === 'object' && 'url' in item && typeof item.url === 'string') {
      const url = externalImageUrl(item.url);
      if (!url) throw new Error('Image provider returned an invalid image URL');
      const imageResponse = await fetcher(url,{headers:{accept:'image/*'},signal:AbortSignal.timeout(60_000)});
      const length = Number(imageResponse.headers.get('content-length') || 0);
      if (!imageResponse.ok || length > 20 * 1024 * 1024) throw new Error('Image provider returned an unavailable image');
      bytes = new Uint8Array(await imageResponse.arrayBuffer());
    } else {
      throw new Error('Image provider returned an invalid image');
    }
    const mime = detectImageMime(bytes);
    if (!mime || bytes.length > 20 * 1024 * 1024) throw new Error('Image provider returned an invalid image');
    return { bytes, mime };
  }));
}
