import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QWEN_VOICES,
  createSpeechProvider,
  detectWavDuration,
  requestQwenSpeech,
} from '../lib/speech.ts';

function wavFixture(sampleRate = 24_000, seconds = 1): Uint8Array {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const dataSize = Math.round(byteRate * seconds);
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (offset:number, value:string) => [...value].forEach((char,index) => view.setUint8(offset + index,char.charCodeAt(0)));
  ascii(0,'RIFF'); view.setUint32(4,36 + dataSize,true); ascii(8,'WAVE');
  ascii(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,channels,true);
  view.setUint32(24,sampleRate,true); view.setUint32(28,byteRate,true); view.setUint16(32,channels * bitsPerSample / 8,true); view.setUint16(34,bitsPerSample,true);
  ascii(36,'data'); view.setUint32(40,dataSize,true);
  return bytes;
}

function streamingWavFixture(sampleRate = 24_000, seconds = 1):Uint8Array {
  const bytes=wavFixture(sampleRate,seconds);
  const view=new DataView(bytes.buffer);
  view.setUint32(4,0x7fffffbf,true);
  view.setUint32(40,0x7fffff9b,true);
  return bytes;
}

test('WAV duration parser rejects malformed and truncated files', () => {
  assert.equal(detectWavDuration(wavFixture(24_000,0.5)),0.5);
  assert.equal(detectWavDuration(streamingWavFixture(24_000,0.5)),0.5);
  assert.throws(() => detectWavDuration(new TextEncoder().encode('not a wav')),/WAV/i);
});

test('Qwen request maps voices, downloads audio, and normalizes streaming WAV sizes', async () => {
  const wav=streamingWavFixture(24_000,1.5);
  const calls:Array<{url:string;init?:RequestInit}>=[];
  const result=await requestQwenSpeech({
    key:'dashscope-secret',
    model:'qwen3-tts-instruct-flash',
    voices:QWEN_VOICES,
    gender:'female',
    text:'海风吹过车站。',
    instruction:'温柔地说，语速稍慢，结尾带一点释然。',
    fetcher:async (url,init) => {
      calls.push({url:String(url),init});
      if (calls.length===1) return Response.json({
        request_id:'request-1',
        output:{finish_reason:'stop',audio:{url:'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/generated/test.wav',id:'audio-1',expires_at:1}},
        usage:{input_tokens:5,output_tokens:8,total_tokens:13},
      });
      return new Response(wav.buffer as ArrayBuffer,{headers:{'content-type':'audio/wav'}});
    },
  });

  assert.equal(calls.length,2);
  assert.equal(calls[0].url,'https://maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(new Headers(calls[0].init?.headers).get('Authorization'),'Bearer dashscope-secret');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)),{
    model:'qwen3-tts-instruct-flash',
    input:{text:'海风吹过车站。',voice:QWEN_VOICES.female,language_type:'Chinese',instructions:'温柔地说，语速稍慢，结尾带一点释然。',optimize_instructions:true},
  });
  assert.equal(calls[1].url,'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/generated/test.wav');
  assert.equal(calls[1].init?.redirect,'manual');
  assert.equal(result.duration,1.5);
  assert.equal(result.mime,'audio/wav');
  assert.deepEqual(result.bytes,wavFixture(24_000,1.5));
});

test('speech provider factory exposes the shared interface through Qwen', () => {
  const qwen=createSpeechProvider({id:'qwen',key:'key'});
  assert.equal(qwen.id,'qwen');
  assert.equal(qwen.label,'阿里云百炼');
  assert.equal(qwen.model,'qwen3-tts-instruct-flash');
  assert.deepEqual(qwen.voices,{female:'Momo',male:'Moon'});
  assert.throws(()=>createSpeechProvider({id:'unsupported'} as never),/unsupported speech provider/i);
});

test('Qwen rejects missing credentials and untrusted audio download URLs', async () => {
  await assert.rejects(requestQwenSpeech({key:'',gender:'male',text:'测试'}),/API key/i);
  await assert.rejects(requestQwenSpeech({key:'key',gender:'male',text:'字'.repeat(601)}),/600/);
  await assert.rejects(
    requestQwenSpeech({
      key:'key',gender:'male',text:'测试',
      fetcher:async()=>Response.json({output:{finish_reason:'stop',audio:{url:'https://evil.example/private'}}}),
    }),
    /audio URL/i,
  );
});

test('Qwen rejects tone instructions on a model without instruction control', async () => {
  await assert.rejects(
    requestQwenSpeech({key:'key',model:'qwen3-tts-flash',gender:'female',text:'测试',instruction:'开心地说'}),
    /qwen3-tts-instruct-flash/i,
  );
});

test('Qwen errors expose status without leaking credentials or response body', async () => {
  await assert.rejects(
    requestQwenSpeech({
      key:'dashscope-secret',gender:'male',text:'测试',
      fetcher:async()=>new Response('credential detail',{status:401}),
    }),
    error => error instanceof Error && error.message === 'Speech provider failed (401)' && !error.message.includes('dashscope-secret') && !error.message.includes('credential detail'),
  );
});
