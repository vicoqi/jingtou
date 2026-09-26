import test from 'node:test';
import assert from 'node:assert/strict';
import { AZURE_VOICES, buildSpeechSsml, detectWavDuration, requestAzureSpeech } from '../lib/speech.ts';

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

test('Azure request maps female and male voices and escapes dialogue', async () => {
  let body = '';
  const result = await requestAzureSpeech({
    key:'key',region:'eastasia',gender:'female',text:'你 & 我 <一起>',
    fetcher:async (url,init) => {
      assert.equal(String(url),'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1');
      assert.equal(new Headers(init?.headers).get('Ocp-Apim-Subscription-Key'),'key');
      assert.equal(new Headers(init?.headers).get('X-Microsoft-OutputFormat'),'riff-24khz-16bit-mono-pcm');
      body=String(init?.body);
      return new Response(wavFixture(),{headers:{'content-type':'audio/wav'}});
    },
  });
  assert.match(body,new RegExp(AZURE_VOICES.female));
  assert.match(body,/你 &amp; 我 &lt;一起&gt;/);
  assert.equal(result.duration,1);
  assert.equal(result.mime,'audio/wav');

  assert.match(buildSpeechSsml('测试','male'),new RegExp(AZURE_VOICES.male));
});

test('WAV duration parser rejects malformed and truncated files', () => {
  assert.equal(detectWavDuration(wavFixture(24_000,0.5)),0.5);
  assert.throws(() => detectWavDuration(new TextEncoder().encode('not a wav')),/WAV/i);
});

test('Azure errors expose status without leaking credentials or response body', async () => {
  await assert.rejects(
    requestAzureSpeech({key:'secret',region:'eastasia',gender:'male',text:'测试',fetcher:async()=>new Response('credential detail',{status:401})}),
    error => error instanceof Error && error.message === 'Speech provider failed (401)' && !error.message.includes('secret') && !error.message.includes('credential detail'),
  );
  await assert.rejects(
    requestAzureSpeech({key:'secret',region:'https://evil.example',gender:'female',text:'测试'}),
    /region/i,
  );
});
