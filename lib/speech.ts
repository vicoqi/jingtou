import type { VoiceGender } from './types.ts';

export const AZURE_VOICES = {
  female: 'zh-CN-XiaoxiaoNeural',
  male: 'zh-CN-YunxiNeural',
} as const satisfies Record<VoiceGender,string>;

const MAX_TEXT_LENGTH = 1_000;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

function escapeXml(value:string):string {
  return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
}

export function buildSpeechSsml(text:string,gender:VoiceGender):string {
  const cleaned=text.trim();
  if (!cleaned) throw new Error('Speech text is required');
  if (cleaned.length > MAX_TEXT_LENGTH) throw new Error(`Speech text must be ${MAX_TEXT_LENGTH} characters or fewer`);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><voice name="${AZURE_VOICES[gender]}">${escapeXml(cleaned)}</voice></speak>`;
}

function chunkName(bytes:Uint8Array,offset:number):string {
  return String.fromCharCode(bytes[offset],bytes[offset + 1],bytes[offset + 2],bytes[offset + 3]);
}

export function detectWavDuration(bytes:Uint8Array):number {
  if (bytes.byteLength < 12 || chunkName(bytes,0) !== 'RIFF' || chunkName(bytes,8) !== 'WAVE') throw new Error('Invalid WAV response');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let byteRate:number | null=null;
  let dataSize:number | null=null;
  for (let offset=12;offset + 8 <= bytes.byteLength;) {
    const name=chunkName(bytes,offset);
    const size=view.getUint32(offset + 4,true);
    const dataOffset=offset + 8;
    if (dataOffset + size > bytes.byteLength) throw new Error('Invalid WAV response');
    if (name === 'fmt ') {
      if (size < 16) throw new Error('Invalid WAV response');
      byteRate=view.getUint32(dataOffset + 8,true);
    } else if (name === 'data') {
      dataSize=size;
    }
    offset=dataOffset + size + (size % 2);
  }
  if (!byteRate || dataSize === null || dataSize <= 0) throw new Error('Invalid WAV response');
  const duration=dataSize / byteRate;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid WAV response');
  return duration;
}

type SpeechOptions = {
  key:string;
  region:string;
  gender:VoiceGender;
  text:string;
  fetcher?:typeof fetch;
};

export async function requestAzureSpeech(options:SpeechOptions):Promise<{bytes:Uint8Array;mime:'audio/wav';duration:number}> {
  const region=options.region.trim();
  if (!/^[a-z0-9-]+$/.test(region)) throw new Error('Invalid Azure Speech region');
  if (!options.key) throw new Error('Azure Speech key is required');
  const response=await (options.fetcher ?? fetch)(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,{
    method:'POST',
    headers:{
      'Ocp-Apim-Subscription-Key':options.key,
      'Content-Type':'application/ssml+xml',
      'X-Microsoft-OutputFormat':'riff-24khz-16bit-mono-pcm',
      'User-Agent':'JingtouStudio',
    },
    body:buildSpeechSsml(options.text,options.gender),
    signal:AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Speech provider failed (${response.status})`);
  const declaredSize=Number(response.headers.get('content-length') || 0);
  if (declaredSize > MAX_AUDIO_BYTES) throw new Error('Speech provider response is too large');
  const bytes=new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error('Speech provider response is too large');
  return {bytes,mime:'audio/wav',duration:detectWavDuration(bytes)};
}
