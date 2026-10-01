export class ApiError extends Error {
  status:number;
  constructor(status:number,message:string) { super(message); this.status=status; }
}
export function fail(status:number,message:string):never { throw new ApiError(status,message); }
export function json(data:unknown,status=200):Response {
  return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
}
export async function bodyJson(request:Request,limit=2_000_000):Promise<Record<string,unknown>> {
  if (Number(request.headers.get('content-length') || 0)>limit) fail(413,'请求内容过大。');
  const raw=await request.text();
  if (raw.length>limit) fail(413,'请求内容过大。');
  let value:unknown;
  try { value=JSON.parse(raw); } catch { return fail(400,'Invalid JSON'); }
  if (!value || typeof value!=='object' || Array.isArray(value)) fail(400,'Expected a JSON object');
  return value as Record<string,unknown>;
}
function forwardedValue(value:string | null):string {
  return value?.split(',')[0].trim() ?? '';
}
export function requestOrigin(request:Request,trustProxy=false):string {
  const direct=new URL(request.url).origin;
  if (!trustProxy) return direct;
  const protocol=forwardedValue(request.headers.get('x-forwarded-proto'));
  const host=forwardedValue(request.headers.get('x-forwarded-host'));
  if (!['http','https'].includes(protocol) || !host) return direct;
  try { return new URL(`${protocol}://${host}`).origin; }
  catch { return direct; }
}
export function checkRequestOrigin(request:Request,trustProxy=false):void {
  if (['GET','HEAD','OPTIONS'].includes(request.method)) return;
  const origin=request.headers.get('origin');
  if ((origin && origin!==requestOrigin(request,trustProxy)) || request.headers.get('sec-fetch-site')==='cross-site') {
    fail(403,'请求来源不匹配，请从本站页面操作。');
  }
}

// Shared SSRF floor for provider-supplied download URLs: public https hosts only —
// no localhost-ish names, IP literals, credentials, or non-default ports.
export function publicHttpsUrl(value: unknown, label: string): URL {
  if (typeof value !== 'string') throw new Error(`${label} returned an invalid URL`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} returned an invalid URL`); }
  const hostname = url.hostname.toLowerCase();
  const localhostish = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal');
  const ipLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[');
  if (url.protocol !== 'https:' || localhostish || ipLiteral || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error(`${label} returned an invalid URL (${url.protocol}//${hostname || 'empty'})`);
  }
  return url;
}
