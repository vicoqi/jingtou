'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, LoaderCircle, LockKeyhole, Mail } from 'lucide-react';
import { api, setClientUser } from '../lib/client';
import { isPublicStudioLocation } from '../lib/navigation';
import type { AuthUser } from '../lib/types';
import { Studio } from './Studio';
import { Modal } from './Modal';

export function AuthGate() {
  const [user,setUser]=useState<AuthUser | null>(null);
  const [checking,setChecking]=useState(true);
  const [loadError,setLoadError]=useState('');
  const [notice,setNotice]=useState('');
  const [authMode,setAuthMode]=useState<'login' | 'register' | null>(null);
  const [authBusy,setAuthBusy]=useState(false);
  const destination=useRef<string | null>(null);
  const requestVersion=useRef(0);
  const channel=useRef<BroadcastChannel | null>(null);
  const applyUser=useCallback((next:AuthUser | null)=>{
    setClientUser(next); setUser(next); setChecking(false); setLoadError('');
    if (next) setAuthMode(null);
  },[]);
  const openAuth=useCallback((mode:'login' | 'register'='login',returnTo?:string)=>{
    destination.current=returnTo ?? null;
    setAuthMode(mode);
  },[]);
  const refresh=useCallback(async ()=>{
    const version=++requestVersion.current;
    try {
      const result=await api<{user:AuthUser | null}>('/api/auth/me');
      if (version===requestVersion.current) applyUser(result.user);
    } catch {
      if (version===requestVersion.current) {
        // A temporary network failure must not discard an open, unsaved work.
        setChecking(false);
        setLoadError('暂时无法连接工作台，请检查服务后重试。');
      }
    }
  },[applyUser]);
  useEffect(()=>{
    const initial=window.setTimeout(()=>{void refresh();},0);
    const invalidate=()=>{requestVersion.current++;};
    const expired=()=>{
      requestVersion.current++; applyUser(null); setNotice('登录已过期或账号已切换，请重新登录。');
      setAuthMode('login');
    };
    const changed=()=>{
      setClientUser(null); setUser(null); setChecking(true); void refresh();
    };
    const focus=()=>{ void refresh(); };
    const visible=()=>{ if (document.visibilityState==='visible') void refresh(); };
    const pageshow=(event:PageTransitionEvent)=>{ if (event.persisted) changed(); };
    if (typeof BroadcastChannel!=='undefined') {
      channel.current=new BroadcastChannel('jingtou-auth');
      channel.current.onmessage=changed;
    }
    window.addEventListener('jingtou:unauthorized',expired);
    window.addEventListener('focus',focus);
    window.addEventListener('pageshow',pageshow);
    document.addEventListener('visibilitychange',visible);
    return ()=>{
      window.clearTimeout(initial); invalidate(); channel.current?.close(); channel.current=null;
      window.removeEventListener('jingtou:unauthorized',expired);
      window.removeEventListener('focus',focus);
      window.removeEventListener('pageshow',pageshow);
      document.removeEventListener('visibilitychange',visible);
    };
  },[applyUser,refresh]);
  const authenticated=(next:AuthUser)=>{
    if (destination.current) window.history.replaceState(window.history.state,'',destination.current);
    destination.current=null;
    requestVersion.current++; setNotice(''); applyUser(next); channel.current?.postMessage('changed');
  };
  const logout=async ()=>{
    await api('/api/auth/logout',{method:'POST'});
    requestVersion.current++;
    window.history.replaceState(window.history.state,'','/');
    setNotice(''); applyUser(null); channel.current?.postMessage('changed');
  };
  const closeAuth=()=>{
    if (authBusy) return;
    setAuthMode(null); destination.current=null; setNotice('');
    if (!isPublicStudioLocation(window.location.href)) {
      window.history.replaceState(window.history.state,'','/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  };
  return <>
    <Studio key={user?.id ?? 'guest'} user={user} onLogout={logout} onLogin={openAuth} authLoading={checking} />
    {!user && authMode && <Modal title={authMode==='register' ? '创建你的账号' : '登录镜头工作台'} onClose={closeAuth}>
      <AuthForm mode={authMode} onModeChange={setAuthMode} onAuthenticated={authenticated} onSubmittingChange={setAuthBusy} notice={notice || loadError} />
    </Modal>}
  </>;
}

function AuthForm({mode,onModeChange,onAuthenticated,onSubmittingChange,notice}:{mode:'login' | 'register';onModeChange:(mode:'login' | 'register')=>void;onAuthenticated:(user:AuthUser)=>void;onSubmittingChange:(busy:boolean)=>void;notice:string}) {
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [confirmation,setConfirmation]=useState('');
  const [submitting,setSubmitting]=useState(false);
  const [error,setError]=useState('');
  const registering=mode==='register';
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    if (registering && password!==confirmation) { setError('两次输入的密码不一致。'); return; }
    setSubmitting(true); onSubmittingChange(true); setError('');
    try {
      const result=await api<{user:AuthUser}>(`/api/auth/${mode}`,{method:'POST',body:JSON.stringify({email:email.trim(),password})});
      onAuthenticated(result.user);
    } catch (e) { setError(e instanceof Error ? e.message : '暂时无法登录，请重试。'); }
    finally { setSubmitting(false); onSubmittingChange(false); }
  }
  return <div className="auth-dialog-content">
        <p className="auth-intro">{registering ? '注册后即可开始创作，暂不需要邮箱验证。' : '登录后，保存和继续制作你的作品。'}</p>
        <div className="auth-mode" aria-label="选择登录或注册"><button type="button" aria-pressed={!registering} className={!registering ? 'selected' : ''} disabled={submitting} onClick={()=>{onModeChange('login');setError('');setConfirmation('');}}>登录</button><button type="button" aria-pressed={registering} className={registering ? 'selected' : ''} disabled={submitting} onClick={()=>{onModeChange('register');setError('');}}>注册</button></div>
        <form className="modal-form auth-form" onSubmit={event=>void submit(event)}>
          <label htmlFor="auth-email"><span><Mail size={15} />邮箱地址</span><input id="auth-email" name="email" type="email" autoComplete="username" required maxLength={254} value={email} disabled={submitting} onChange={event=>setEmail(event.target.value)} placeholder="you@example.com" autoFocus /></label>
          <label htmlFor="auth-password"><span><LockKeyhole size={15} />密码</span><input id="auth-password" name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} required minLength={8} maxLength={128} value={password} disabled={submitting} onChange={event=>setPassword(event.target.value)} placeholder="8–128 个字符" /></label>
          {registering && <label htmlFor="auth-confirm">确认密码<input id="auth-confirm" name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={confirmation} disabled={submitting} onChange={event=>setConfirmation(event.target.value)} placeholder="再次输入密码" /></label>}
          {error ? <p className="auth-message auth-error" role="alert">{error}</p> : notice ? <p className="auth-message" role="status">{notice}</p> : null}
          <button className="button primary auth-submit" type="submit" disabled={submitting}>{submitting ? <><LoaderCircle size={17} className="spin" />{registering ? '正在创建账号…' : '正在登录…'}</> : <>{registering ? '注册并开始创作' : '登录工作台'}<ArrowRight size={17} /></>}</button>
        </form>
        <p className="auth-privacy"><LockKeyhole size={13} />作品、角色与场景保存在你的账号下</p>
  </div>;
}
