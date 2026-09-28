import type { VoiceGender } from './types.ts';

export const QWEN_VOICES = {
  female: 'Momo',
  male: 'Moon',
} as const satisfies Record<VoiceGender,string>;

export const DEFAULT_QWEN_TTS_MODEL = 'qwen3-tts-instruct-flash';

export type SpeechOutput = {bytes:Uint8Array;mime:'audio/wav';duration:number};
export type SpeechSynthesisInput = {gender:VoiceGender;text:string;instruction?:string;fetcher?:typeof fetch};
export type SpeechProvider = {
  id:'qwen';
  label:string;
  model:string;
  voices:Record<VoiceGender,string>;
  synthesize(input:SpeechSynthesisInput):Promise<SpeechOutput>;
};
export type SpeechProviderConfig = {id:'qwen';key:string;model?:string;voices?:Partial<Record<VoiceGender,string>>};

const MAX_TEXT_LENGTH = 600;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

function validateSpeechText(text:string):string {
  const cleaned=text.trim();
  if (!cleaned) throw new Error('Speech text is required');
  if (cleaned.length > MAX_TEXT_LENGTH) throw new Error(`Speech text must be ${MAX_TEXT_LENGTH} characters or fewer`);
  return cleaned;
}

function chunkName(bytes:Uint8Array,offset:number):string {
  return String.fromCharCode(bytes[offset],bytes[offset + 1],bytes[offset + 2],bytes[offset + 3]);
}

type WavAnalysis = {duration:number;streamingDataSizeOffset:number | null;actualDataSize:number | null};

function analyzeWav(bytes:Uint8Array):WavAnalysis {
  if (bytes.byteLength < 12 || chunkName(bytes,0) !== 'RIFF' || chunkName(bytes,8) !== 'WAVE') throw new Error('Invalid WAV response');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const streamingRiff=view.getUint32(4,true)===0x7fffffbf;
  let byteRate:number | null=null;
  let dataSize:number | null=null;
  let streamingDataSizeOffset:number | null=null;
  for (let offset=12;offset + 8 <= bytes.byteLength;) {
    const name=chunkName(bytes,offset);
    const size=view.getUint32(offset + 4,true);
    const dataOffset=offset + 8;
    const streamingData=name==='data' && streamingRiff && size===0x7fffff9b && dataOffset<bytes.byteLength;
    if (dataOffset + size > bytes.byteLength && !streamingData) throw new Error('Invalid WAV response');
    if (name === 'fmt ') {
      if (size < 16) throw new Error('Invalid WAV response');
      byteRate=view.getUint32(dataOffset + 8,true);
    } else if (name === 'data') {
      dataSize=streamingData ? bytes.byteLength-dataOffset : size;
      if (streamingData) streamingDataSizeOffset=offset + 4;
    }
    if (streamingData) break;
    offset=dataOffset + size + (size % 2);
  }
  if (!byteRate || dataSize === null || dataSize <= 0) throw new Error('Invalid WAV response');
  const duration=dataSize / byteRate;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid WAV response');
  return {duration,streamingDataSizeOffset,actualDataSize:dataSize};
}

export function detectWavDuration(bytes:Uint8Array):number {
  return analyzeWav(bytes).duration;
}

function normalizeWav(bytes:Uint8Array):{bytes:Uint8Array;duration:number} {
  const analysis=analyzeWav(bytes);
  if (analysis.streamingDataSizeOffset===null || analysis.actualDataSize===null) return {bytes,duration:analysis.duration};
  const normalized=bytes.slice();
  const view=new DataView(normalized.buffer,normalized.byteOffset,normalized.byteLength);
  view.setUint32(4,normalized.byteLength-8,true);
  view.setUint32(analysis.streamingDataSizeOffset,analysis.actualDataSize,true);
  return {bytes:normalized,duration:analysis.duration};
}

type QwenSpeechOptions = {
  key:string;
  model?:string;
  voices?:Partial<Record<VoiceGender,string>>;
  gender:VoiceGender;
  text:string;
  instruction?:string;
  fetcher?:typeof fetch;
};

function qwenAudioDownloadUrl(value:unknown):string {
  if (typeof value !== 'string') throw new Error('Speech provider returned an invalid audio URL');
  let url:URL;
  try { url=new URL(value); } catch { throw new Error('Speech provider returned an invalid audio URL'); }
  const trustedHost=/^[a-z0-9][a-z0-9.-]*\.oss-cn-beijing\.aliyuncs\.com$/i.test(url.hostname);
  if (!trustedHost || (url.protocol!=='http:' && url.protocol!=='https:') || url.username || url.password || url.port) {
    throw new Error('Speech provider returned an invalid audio URL');
  }
  url.protocol='https:';
  return url.toString();
}

function checkDeclaredAudioSize(response:Response):void {
  const declaredSize=Number(response.headers.get('content-length') || 0);
  if (declaredSize > MAX_AUDIO_BYTES) throw new Error('Speech provider response is too large');
}

export async function requestQwenSpeech(options:QwenSpeechOptions):Promise<SpeechOutput> {
  if (!options.key) throw new Error('Qwen API key is required');
  const model=options.model?.trim() || DEFAULT_QWEN_TTS_MODEL;
  const voices={...QWEN_VOICES,...options.voices};
  const text=validateSpeechText(options.text);
  const instruction=options.instruction?.trim() || '';
  if (instruction.length > 500) throw new Error('Speech instruction must be 500 characters or fewer');
  if (instruction && !/^qwen3-tts-instruct-flash(?:-|$)/.test(model)) throw new Error('Tone instructions require qwen3-tts-instruct-flash');
  const fetcher=options.fetcher ?? fetch;
  const input = {
    text,
    voice:voices[options.gender],
    language_type:'Chinese',
    ...(instruction ? {instructions:instruction,optimize_instructions:true} : {}),
  };
  const response=await fetcher('https://maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation',{
    method:'POST',
    headers:{Authorization:`Bearer ${options.key}`,'Content-Type':'application/json'},
    body:JSON.stringify({model,input}),
    signal:AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Speech provider failed (${response.status})`);
  let payload:unknown;
  try { payload=await response.json(); } catch { throw new Error('Speech provider returned an invalid response'); }
  const output=typeof payload==='object' && payload!==null && 'output' in payload && typeof payload.output==='object' && payload.output!==null ? payload.output : null;
  const audio=output && 'audio' in output && typeof output.audio==='object' && output.audio!==null ? output.audio : null;
  const audioUrl=qwenAudioDownloadUrl(audio && 'url' in audio ? audio.url : undefined);
  if (!output || !('finish_reason' in output) || output.finish_reason!=='stop') throw new Error('Speech provider returned an incomplete response');

  const audioResponse=await fetcher(audioUrl,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(60_000)});
  if (!audioResponse.ok) throw new Error(`Speech audio download failed (${audioResponse.status})`);
  checkDeclaredAudioSize(audioResponse);
  const bytes=new Uint8Array(await audioResponse.arrayBuffer());
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error('Speech provider response is too large');
  const normalized=normalizeWav(bytes);
  return {bytes:normalized.bytes,mime:'audio/wav',duration:normalized.duration};
}

export function createSpeechProvider(config:SpeechProviderConfig):SpeechProvider {
  if (config.id!=='qwen') throw new Error('Unsupported speech provider');
  const model=config.model?.trim() || DEFAULT_QWEN_TTS_MODEL;
  const voices={...QWEN_VOICES,...config.voices};
  return {
    id:'qwen',label:'阿里云百炼',model,voices,
    synthesize:input=>requestQwenSpeech({...input,key:config.key,model,voices}),
  };
}
