'use client';
import { ArrowRight, Clapperboard, FolderOpen, ImagePlus, LoaderCircle, Mountain, Plus, UserRound, UsersRound } from 'lucide-react';
import type { ResourceLibrary } from '../lib/types';
import type { ProjectSection } from '../lib/navigation';

type LibrarySection = Extract<ProjectSection, 'characters' | 'scenes'>;
type Props = {
  section: LibrarySection;
  library: ResourceLibrary;
  loading: boolean;
  onOpen: (projectId: string, section: LibrarySection) => void;
  onCreate: () => void;
};

const sceneStatus = (status: ResourceLibrary['scenes'][number]['status']) => status === 'generating' ? '生成中' : status === 'failed' ? '生成失败' : '可继续编辑';

export function ResourceLibraries({ section, library, loading, onOpen, onCreate }: Props) {
  const characters = library.characters;
  const scenes = library.scenes;
  const items = section === 'characters' ? characters : scenes;
  const projectCount = new Set(items.map(item => item.projectId)).size;
  return <section className="resource-library-page">
    <div className="section-heading resource-library-heading"><div><span className="eyebrow">{section === 'characters' ? 'GLOBAL CHARACTER LIBRARY' : 'GLOBAL SCENE LIBRARY'}</span><h1>{section === 'characters' ? '角色库' : '场景生成'}</h1><p>{items.length ? `汇总 ${projectCount} 个作品中的 ${items.length} 个${section === 'characters' ? '角色' : '场景'}，进入所属作品后可继续编辑。` : `这里会展示所有作品中的${section === 'characters' ? '角色' : '场景'}。`}</p></div><button className="button primary" onClick={onCreate}><Plus size={17} />新建作品</button></div>
    {loading ? <div className="resource-library-state"><LoaderCircle className="spin" size={28} /><strong>正在整理所有作品</strong></div> : items.length === 0 ? <div className="resource-library-state"><span className="resource-library-state-icon">{section === 'characters' ? <UsersRound size={34} /> : <Mountain size={34} />}</span><strong>还没有可展示的{section === 'characters' ? '角色' : '场景'}</strong><p>先创建作品，再在作品编辑页中添加{section === 'characters' ? '角色设定' : '场景'}。</p><button className="button primary" onClick={onCreate}><Plus size={16} />创建第一个作品</button></div> : section === 'characters' ? <div className="resource-library-grid">{characters.map((character,index) => <button className="resource-library-card" key={`${character.projectId}:${character.id}`} onClick={() => onOpen(character.projectId,'characters')} aria-label={`打开${character.projectName}中的角色${character.name}`}>
      <span className={`resource-library-cover resource-character-cover portrait-${index % 2}`}>{character.references[0] ? <img src={character.references[0].url} alt="" loading="lazy" /> : <UserRound size={52} strokeWidth={1} />}<span className="resource-project-label"><FolderOpen size={11} />{character.projectName}</span></span>
      <span className="resource-library-info"><span className="resource-title"><strong>{character.name}</strong><span>{character.references.length} 张参考图</span></span><span className="resource-description">{character.description || '尚未填写外观描述'}</span><span className="resource-library-footer"><span><Clapperboard size={13} />出场于 {character.shotCount} 个镜头</span><em>进入角色设定<ArrowRight size={14} /></em></span></span>
    </button>)}</div> : <div className="resource-library-grid">{scenes.map(scene => <button className="resource-library-card" key={`${scene.projectId}:${scene.id}`} onClick={() => onOpen(scene.projectId,'scenes')} aria-label={`打开${scene.projectName}中的场景${scene.name}`}>
      <span className="resource-library-cover resource-scene-cover">{scene.previewUrl ? <img src={scene.previewUrl} alt="" loading="lazy" /> : <ImagePlus size={38} strokeWidth={1} />}<span className="resource-project-label"><FolderOpen size={11} />{scene.projectName}</span></span>
      <span className="resource-library-info"><span className="resource-title"><strong>{scene.name}</strong><span>{sceneStatus(scene.status)}</span></span><span className="resource-description">{scene.description || '尚未填写场景描述'}</span><span className="resource-style">{scene.style || '沿用作品画风'}</span><span className="resource-library-footer"><span>{scene.candidateCount} 张候选图 · {scene.shotCount} 个镜头</span><em>进入场景编辑<ArrowRight size={14} /></em></span></span>
    </button>)}</div>}
  </section>;
}
