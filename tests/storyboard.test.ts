import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STORYBOARD_MODEL, STORYBOARD_LLM_BASE_URL, buildStoryboardMessages, parseStoryboardPayload, requestStoryboard } from '../lib/storyboard.ts';

const validPayload = () => ({
  characters: [{ name: '林夏', description: '深蓝短发、珊瑚发带、米白上衣的少女。' }],
  shots: [
    { title: '重逢', scene: '海边车站', description: '夕阳下的车站全景，林夏站在站台远望。', dialogue: '你来了。', duration: 2, speaker: '林夏', characters: ['林夏'] },
    { title: '沉默', scene: '海边车站', description: '陈屿的特写，微风拂过。', dialogue: '', duration: 30, speaker: null, characters: ['陈屿'] },
  ],
});

const chatResponse = (content: string) => Response.json({ choices: [{ message: { role: 'assistant', content } }] });

test('storyboard request targets compatible-mode with json_object and model override', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await requestStoryboard({
    key: 'dashscope-secret',
    model: 'qwen-plus',
    story: '林夏在车站等到了陈屿。',
    requestedCount: 6,
    fetcher: async (url, init) => {
      calls.push({ url: String(url), init });
      return chatResponse(JSON.stringify(validPayload()));
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${STORYBOARD_LLM_BASE_URL}/chat/completions`);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.model, 'qwen-plus');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].role, 'user');
  assert.match(body.messages[1].content, /6/);
  assert.match(body.messages[1].content, /林夏在车站等到了陈屿。/);
  assert.equal(new Headers(calls[0].init?.headers).get('Authorization'), 'Bearer dashscope-secret');
  assert.equal(result.shots.length, 2);
});

test('storyboard defaults to qwen-max and rejects missing credentials', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  await requestStoryboard({ key: 'k', story: '故事', requestedCount: null, fetcher: async (url, init) => { calls.push({ url: String(url), init }); return chatResponse(JSON.stringify(validPayload())); } });
  assert.equal(JSON.parse(String(calls[0].init?.body)).model, DEFAULT_STORYBOARD_MODEL);
  await assert.rejects(requestStoryboard({ key: '', story: '故事', requestedCount: null }), /API key/i);
  await assert.rejects(requestStoryboard({ key: 'k', story: '  ', requestedCount: null }), /故事/);
  await assert.rejects(requestStoryboard({ key: 'k', story: '故事', requestedCount: 3 }), /镜头数/);
});

test('parser clamps fields, collects missing characters, and corrects duration by dialogue length', () => {
  const payload = {
    characters: [{ name: '林夏', description: '深蓝短发少女' }],
    shots: [
      { title: '  长标题 '.repeat(100).slice(0, 200), scene: '场景', description: '描述', dialogue: '这'.repeat(40), duration: 2, speaker: '林夏', characters: ['林夏'], extra: 'ignored' },
      { title: '新人物', scene: '场景', description: '描述', dialogue: '', duration: 999, speaker: null, characters: ['陈屿'] },
    ],
  };
  const parsed = parseStoryboardPayload(payload);
  assert.equal(parsed.shots[0].title.length, 120);
  assert.equal(parsed.shots[0].duration, 10, '40 字对白至少 10 秒');
  assert.equal(parsed.shots[1].duration, 60, 'AI 建议值 clamp 到 60');
  assert.ok(parsed.characters.some(c => c.name === '陈屿' && c.description === ''), '未识别人物补充空描述');
});

test('parser extracts JSON from fenced or noisy content and rejects empty shot lists', () => {
  const fenced = parseStoryboardPayload('前置说明\n```json\n' + JSON.stringify(validPayload()) + '\n```\n后置说明');
  assert.equal(fenced.shots.length, 2);
  assert.throws(() => parseStoryboardPayload({ characters: [], shots: [] }), /未拆出任何镜头/);
  assert.throws(() => parseStoryboardPayload('not json at all'), /格式异常/);
  const zeroed = parseStoryboardPayload({ characters: [], shots: [{ title: 't', scene: 's', description: 'd', dialogue: '', duration: 0, speaker: null, characters: [] }] });
  assert.equal(zeroed.shots[0].duration, 1, '非法时长在解析阶段 clamp 容错，严格校验在 validateProject');
});

test('provider surfaces HTTP failures without leaking credentials', async () => {
  await assert.rejects(
    requestStoryboard({ key: 'dashscope-secret', story: '故事', requestedCount: null, fetcher: async () => new Response('boom', { status: 500 }) }),
    error => error instanceof Error && /500/.test(error.message) && !error.message.includes('dashscope-secret'),
  );
});
