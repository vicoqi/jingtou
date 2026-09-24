import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const host = h.get('host') || 'localhost:3000';
  const origin = `${host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https'}://${host}`;
  return {
    title: '镜头 JINGTOU · 动漫短剧创作工作台',
    description: '让故事，一帧帧发生。建立角色、编排分镜、挑选画面，预览属于你的动漫短剧。',
    metadataBase: new URL(origin),
    openGraph: { title: '镜头 · 让故事，一帧帧发生。', description: '从角色设定到分镜预览，你的动漫短剧创作工作台。', images: [`${origin}/og.png`], locale: 'zh_CN', type: 'website' },
    twitter: { card: 'summary_large_image', title: '镜头 JINGTOU STUDIO', images: [`${origin}/og.png`] },
  };
}
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
