import { newShot } from './domain.ts';
import type { Project } from './types.ts';

export function createProject(name: string, demo = false): Project {
  const now = new Date().toISOString();
  const project: Project = { id: crypto.randomUUID(), name: name.trim(), description: '', aspectRatio: '16:9', style: '国风动漫，电影感光影', characters: [], shots: [], revision: 1, createdAt: now, updatedAt: now };
  if (!demo) return project;
  project.name = '夏日来信 · 样例';
  project.description = '三张示例素材编排为十二个分镜，共六十秒，用于体验流程。';
  project.characters = [
    { id:'sample-character-1', name:'林夏', description:'深蓝色短发，米白上衣，青绿色裙子，珊瑚色发带。活泼而真诚。', references:[{id:'sample-ref-1', name:'林夏参考图', url:'/samples/linxia.png'}] },
    { id:'sample-character-2', name:'陈屿', description:'棕色短发，米白衬衫，深蓝色背包。安静温柔。', references:[{id:'sample-ref-2', name:'陈屿参考图', url:'/samples/chenyu.png'}] },
  ];
  const scenes = [
    ['夏日来信','海边小镇','林夏在窗边读到一封多年未寄出的信。','原来你一直记得。'],
    ['旧车票','林夏的房间','信封里滑出一张去海边车站的旧车票。','那天，我们说好会再见。'],
    ['奔向车站','小镇街道','林夏系好珊瑚色发带，迎着海风出门。','这一次，我不会迟到。'],
    ['海边列车','海岸铁道','列车沿着湛蓝海岸驶向小站。','快到了。'],
    ['熟悉的站台','海边车站','空旷站台上，夏日光影落在长椅上。','这里一点也没变。'],
    ['背影','站台尽头','林夏看见一个背着深蓝色背包的熟悉背影。','陈屿？'],
    ['回头','海边车站','陈屿转身，两人隔着站台相望。','林夏，是你吗？'],
    ['迟到的问候','站台长椅','两人并肩坐下，终于说出多年未讲的话。','好久不见。'],
    ['那封信','站台长椅','林夏把信交给陈屿，纸角被海风轻轻吹起。','我现在才收到。'],
    ['海风的回答','站台边缘','陈屿笑着指向远处的海面。','没关系，我也刚到。'],
    ['再次同行','通往海边的小路','两人走下站台，影子在夕阳里靠近。','一起去看海吧。'],
    ['夏日未完','海边沙滩','林夏与陈屿面向大海，海浪映着暖色天光。','这一次，故事继续。'],
  ];
  const sampleImages = ['/samples/summer.png','/samples/linxia.png','/samples/chenyu.png'];
  project.shots = scenes.map(([title,scene,description,dialogue],i) => {
    const images = i === 0 ? sampleImages : [sampleImages[(i - 1) % sampleImages.length]];
    const candidates = images.map((url,j) => ({id:`sample-candidate-${i+1}-${j+1}`,url,createdAt:now,prompt:'样例素材',batchId:'sample',source:'sample' as const}));
    return {...newShot(),id:`sample-shot-${i+1}`,title,scene,description,dialogue,characterIds:['sample-character-1','sample-character-2'],candidates,selectedCandidateId:candidates[0].id};
  });
  return project;
}
