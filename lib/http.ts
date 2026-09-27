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
