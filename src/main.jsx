import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { api, apiUrl, assetUrl, getApiBaseUrl, getSavedServerConfig, setApiBaseUrl, setAuthToken, wsUrl } from './services/api.js';
import { getCachedProjects, getCachedTree, getQueuedPhotos, putCachedProjects, putCachedTree, removeQueuedPhoto, updateQueuedPhoto } from './services/localDb.js';
import { exitNativeApp, isNativeApp, isNativeOnline, onNativeAppForeground, onNativeBackButton, onNativeNetworkRestored, readNativeOriginal, removeNativeOriginal } from './services/nativeApp.js';
import { fileToWatermarkedBlob } from './services/photo.js';
import CapturePanelV2 from './components/CapturePanelV2.jsx';
import { useConfirmDialog } from './components/ConfirmDialog.jsx';

const DEFAULT_LOGIN = { username: 'admin', password: 'admin123' };
const ROLE_LABELS = { super_admin: '完全管理员', project_admin: '项目管理员', collector: '采集员' };
const VIEW_LABELS = { projects: '项目', capture: '采集', sync: '同步', progress: '进度', manage: '管理', upload: '导入', export: '导出', accounts: '账号', health: '健康', diagnostics: '诊断', more: '更多' };

function uploadUrl(storedPath) {
  const cleanPath = String(storedPath || '').replace(/\\/g, '/').replace(/^uploads\//, '');
  return assetUrl(encodeURI(`/uploads/${cleanPath}`));
}

function blobUrl(blob) {
  return blob ? URL.createObjectURL(blob) : '';
}

function displayPhotoType(type) {
  return type === 'extra' ? '额外拍摄照片' : type;
}

function roleAllowedViews(role) {
  if (role === 'super_admin') return ['projects', 'capture', 'sync', 'progress', 'manage', 'upload', 'export', 'accounts', 'health', 'diagnostics', 'more'];
  if (role === 'project_admin') return ['projects', 'capture', 'sync', 'progress', 'manage', 'upload', 'export', 'accounts', 'diagnostics', 'more'];
  return ['projects', 'capture', 'sync', 'progress', 'diagnostics', 'more'];
}

function diagnoseSyncError(error) {
  const message = String(error?.message || error || '');
  if (!navigator.onLine) return '网络已断开，恢复联网后可重试。';
  if (/401|未登录|登录已过期/i.test(message)) return '登录已过期，请重新登录后重试。';
  if (/403|权限/i.test(message)) return '当前账号没有该项目或照片的上传权限。';
  if (/413|file too large|文件过大|too large/i.test(message)) return '照片文件过大，请删除本地队列照片后重新拍摄。';
  if (/水印|canvas|timeout|超时/i.test(message)) return '生成水印或上传超时，请在同步中心单张重试。';
  if (/failed to fetch|network|load failed/i.test(message)) return '无法连接后端服务，请检查电脑服务、局域网和防火墙。';
  return message || '同步失败，请稍后重试。';
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function includesKeyword(values, keyword) {
  const word = keyword.trim().toLowerCase();
  if (!word) return true;
  return values.filter(Boolean).join(' ').toLowerCase().includes(word);
}

function sortPhotosDesc(list) {
  return [...list].sort((a, b) => {
    const seqA = Number(a.sequence || 0);
    const seqB = Number(b.sequence || 0);
    if (seqA !== seqB) return seqB - seqA;
    return new Date(b.capturedAt || 0) - new Date(a.capturedAt || 0);
  });
}

function cleanupLegacyAppCache() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => {
        registrations
          .filter((registration) => registration.scope.startsWith(window.location.origin))
          .forEach((registration) => registration.unregister());
      })
      .catch(() => {});
  }
  if ('caches' in window) {
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('telecom-photo-acceptance')).map((key) => caches.delete(key))))
      .catch(() => {});
  }
}

function progressStatusClass({ missingCount, localPending, failed }) {
  if (failed > 0) return 'status-failed';
  if (localPending > 0) return 'status-pending';
  if (missingCount === 0) return 'status-done';
  return 'status-missing';
}

function progressPriority({ missingCount, localPending, failed, reviewStatus }) {
  if (failed > 0) return 0;
  if (localPending > 0) return 1;
  if (reviewStatus && reviewStatus !== 'approved') return 2;
  if (missingCount > 0) return 3;
  return 4;
}

function readCaptureState(projectId, userId) {
  if (!projectId) return {};
  try {
    const scopedKey = userId ? `capture-state:${userId}:${projectId}` : '';
    return JSON.parse((scopedKey ? localStorage.getItem(scopedKey) : '') || '{}');
  } catch {
    return {};
  }
}

function formatBytes(value = 0) {
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

function App() {
  const [session, setSession] = useState(() => {
    const saved = localStorage.getItem('session');
    return saved ? JSON.parse(saved) : null;
  });
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(() => localStorage.getItem('last-active-project-id') || '');
  const [activeView, setActiveView] = useState('projects');
  const [manageProjectId, setManageProjectId] = useState('');
  const [capturePage, setCapturePage] = useState('projectList');
  const [captureBackSignal, setCaptureBackSignal] = useState(0);
  const [tree, setTree] = useState(null);
  const [progress, setProgress] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [queue, setQueue] = useState([]);
  const [syncingIds, setSyncingIds] = useState([]);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [syncPaused, setSyncPaused] = useState(() => localStorage.getItem('sync-paused') === '1');
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showInstallTip, setShowInstallTip] = useState(() => localStorage.getItem('pwa-install-tip-hidden') !== '1');
  const [notice, setNotice] = useState('');
  const lastBackAtRef = React.useRef(0);
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

  const role = session?.user?.role;
  const isSuperAdmin = role === 'super_admin';
  const canManageProjects = isSuperAdmin || role === 'project_admin';
  const allowedViews = roleAllowedViews(role);
  const bottomViews = ['projects', 'sync', 'more'];

  useEffect(() => {
    if (session?.token) setAuthToken(session.token);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    refreshProjects();
    refreshQueue();
  }, [session]);

  useEffect(() => {
    if (!session || !activeProjectId) {
      setTree(null);
      setProgress(null);
      setPhotos([]);
      return;
    }
    loadProject(activeProjectId);
  }, [session, activeProjectId]);

  useEffect(() => {
    if (!session) return;
    let socket;
    try {
      socket = new WebSocket(wsUrl('/ws'));
      socket.onmessage = () => {
        refreshProjects();
        if (activeProjectId) loadProject(activeProjectId);
      };
    } catch {
      socket = null;
    }
    return () => socket?.close();
  }, [session, activeProjectId]);

  useEffect(() => {
    if (!session) return;
    const runSync = () => syncQueue();
    window.addEventListener('online', runSync);
    const removeNetworkListener = onNativeNetworkRestored(runSync);
    const timer = setInterval(runSync, 8000);
    runSync();
    return () => {
      window.removeEventListener('online', runSync);
      removeNetworkListener();
      clearInterval(timer);
    };
  }, [session, activeProjectId, syncPaused]);

  useEffect(() => {
    if (!session) return;
    const onActive = () => {
      refreshProjects();
      refreshQueue();
      if (activeProjectId) loadProject(activeProjectId);
      syncQueue();
    };
    return onNativeAppForeground(onActive);
  }, [session, activeProjectId, syncPaused]);

  useEffect(() => {
    if (activeProjectId) localStorage.setItem('last-active-project-id', activeProjectId);
  }, [activeProjectId]);

  useEffect(() => {
    if (!allowedViews.includes(activeView)) setActiveView('projects');
  }, [allowedViews.join('|'), activeView]);

  useEffect(() => {
    if (!session) return;
    return onNativeBackButton(handleNativeBack);
  }, [session, activeView, capturePage]);

  useEffect(() => {
    cleanupLegacyAppCache();
    function onBeforeInstallPrompt(event) {
      event.preventDefault();
      setInstallPrompt(event);
      setShowInstallTip(localStorage.getItem('pwa-install-tip-hidden') !== '1');
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  }, []);

  async function refreshProjects() {
    try {
      const data = await api('/api/projects');
      setProjects(data.projects);
      await putCachedProjects(data.projects);
      if (activeProjectId && !data.projects.some((project) => String(project.id) === String(activeProjectId)) && data.projects[0]) setActiveProjectId(String(data.projects[0].id));
      if (!activeProjectId && data.projects[0]) setActiveProjectId(String(data.projects[0].id));
    } catch {
      const cached = await getCachedProjects();
      setProjects(cached);
      if (!activeProjectId && cached[0]) setActiveProjectId(String(cached[0].id));
      setNotice('当前离线，使用本地缓存继续采集。');
    }
  }

  async function loadProject(projectId) {
    try {
      const [nextTree, nextProgress, nextPhotos] = await Promise.all([
        api(`/api/projects/${projectId}/tree`),
        api(`/api/projects/${projectId}/progress`),
        api(`/api/projects/${projectId}/photos`)
      ]);
      setTree(nextTree);
      setProgress(nextProgress);
      setPhotos(nextPhotos.photos);
      await putCachedTree(nextTree);
    } catch (err) {
      const cached = await getCachedTree(Number(projectId));
      setTree(cached);
      setProgress(null);
      setNotice(`项目数据加载失败，已尝试使用离线缓存：${err.message}`);
    }
  }

  async function refreshQueue() {
    setQueue(await getQueuedPhotos());
  }

  async function uploadQueuedPhoto(item) {
    const metadata = item.metadata || {};
    const normalizedMetadata = { ...metadata, photoType: displayPhotoType(metadata.photoType) };
    const capturedAt = metadata.capturedAt || new Date().toISOString();
    const gpsText = metadata.gps ? `${metadata.gps.lat.toFixed(6)}, ${metadata.gps.lng.toFixed(6)}` : '';
    const watermarkText = [
      normalizedMetadata.projectName,
      normalizedMetadata.taskPointName,
      normalizedMetadata.devicePositionName,
      normalizedMetadata.photoType,
      new Date(capturedAt).toLocaleString(),
      normalizedMetadata.capturedBy || session.user.displayName,
      gpsText
    ].filter(Boolean);
    const originalBlob = await readNativeOriginal(item);
    const watermarkedBlob = item.watermarkedBlob || await withTimeout(fileToWatermarkedBlob(originalBlob, watermarkText), 50000, '生成水印照片超时，请在同步中心重试。');
    const form = new FormData();
    form.append('original', originalBlob, item.originalName || 'photo.jpg');
    form.append('watermarked', watermarkedBlob, item.watermarkedName || 'watermarked.jpg');
    form.append('metadata', JSON.stringify(normalizedMetadata));
    return withTimeout(api('/api/photos', { method: 'POST', body: form }), 90000, '上传照片超时，请检查网络后重试。');
  }

  async function syncQueue(ids = null) {
    if (!session || !(await isNativeOnline())) return;
    if (syncPaused && !ids) return;
    const queued = await getQueuedPhotos();
    const targets = ids ? queued.filter((item) => ids.includes(item.id)) : queued;
    for (let index = 0; index < targets.length; index += 1) {
      const item = targets[index];
      try {
        setUploadProgress({ current: index + 1, total: targets.length, device: item.metadata?.devicePositionName, photoType: displayPhotoType(item.metadata?.photoType) });
        setSyncingIds((list) => [...new Set([...list, item.id])]);
        await updateQueuedPhoto(item.id, { status: 'syncing', lastError: '' });
        await uploadQueuedPhoto(item);
        await removeNativeOriginal(item);
        await removeQueuedPhoto(item.id);
      } catch (err) {
        const reason = diagnoseSyncError(err);
        await updateQueuedPhoto(item.id, { status: 'failed', retryCount: (item.retryCount || 0) + 1, lastError: reason });
        setNotice(`有照片同步失败：${reason}`);
        break;
      } finally {
        setSyncingIds((list) => list.filter((id) => id !== item.id));
        setUploadProgress(null);
      }
    }
    await refreshQueue();
    if (activeProjectId) await loadProject(activeProjectId);
  }

  async function installPwa() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    setInstallPrompt(null);
    setShowInstallTip(false);
    localStorage.setItem('pwa-install-tip-hidden', '1');
  }

  function enterProject(projectId, view = 'capture') {
    setActiveProjectId(String(projectId));
    setManageProjectId(view === 'manage' ? String(projectId) : '');
    setActiveView(view);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function leaveProject() {
    setActiveView('projects');
    setCapturePage('projectList');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleNativeBack() {
    if (activeView === 'capture') {
      setCaptureBackSignal((value) => value + 1);
      return;
    }
    if (activeView !== 'projects') {
      setActiveView('projects');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const now = Date.now();
    if (now - lastBackAtRef.current < 1800) {
      exitNativeApp();
      return;
    }
    lastBackAtRef.current = now;
    setNotice('再按一次返回键退出 App。');
  }

  function handleLogin(nextSession) {
    setSession(nextSession);
    setAuthToken(nextSession.token);
    localStorage.setItem('session', JSON.stringify(nextSession));
    setActiveView('projects');
  }

  function logout() {
    localStorage.removeItem('session');
    setSession(null);
    setProjects([]);
    setTree(null);
    setProgress(null);
    setPhotos([]);
    setQueue([]);
    setActiveProjectId('');
    setActiveView('projects');
  }

  if (!session) return <Login onLogin={handleLogin} />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>工程照片采集</h1>
          <p>{session.user.displayName} · {ROLE_LABELS[role] || role}</p>
        </div>
        <button className="ghost" onClick={logout}>退出</button>
      </header>
      {notice && <button className="notice" onClick={() => setNotice('')}>{notice}</button>}
      {uploadProgress && <div className="notice sync-progress">正在同步 {uploadProgress.current}/{uploadProgress.total}：{uploadProgress.device} · {uploadProgress.photoType}</div>}
      {showInstallTip && installPrompt && (
        <section className="install-tip">
          <div><strong>可安装到手机桌面</strong><span>安装后可像 App 一样打开，适合现场采集。</span></div>
          <div className="inline-actions">
            <button type="button" onClick={installPwa}>安装</button>
            <button type="button" className="ghost" onClick={() => { setShowInstallTip(false); localStorage.setItem('pwa-install-tip-hidden', '1'); }}>不再提示</button>
          </div>
        </section>
      )}
      <main className="workspace">
        <nav className="feature-nav" aria-label="功能导航">
          {bottomViews.map((view) => <button key={view} type="button" className={activeView === view ? 'active' : ''} onClick={() => setActiveView(view)}>{VIEW_LABELS[view]}</button>)}
        </nav>
        <section className="panel feature-panel">
          {activeView === 'projects' && <ProjectHome projects={projects} activeProjectId={activeProjectId} progress={progress} queue={queue} session={session} canManageProjects={canManageProjects} enterProject={enterProject} />}
          {activeView === 'capture' && <CapturePanelV2 tree={tree} session={session} projectId={activeProjectId} photos={photos} queue={queue} reload={() => activeProjectId && loadProject(activeProjectId)} onQueued={async () => { await refreshQueue(); await syncQueue(); }} onPageChange={setCapturePage} onExitProject={leaveProject} backSignal={captureBackSignal} />}
          {activeView === 'sync' && <SyncCenter queue={queue} photos={photos} tree={tree} syncingIds={syncingIds} refreshQueue={refreshQueue} retry={(ids) => syncQueue(ids)} syncPaused={syncPaused} setSyncPaused={setSyncPaused} confirm={confirm} />}
          {activeView === 'progress' && <ProgressPanel progress={progress} queue={queue} projectId={activeProjectId} photos={photos} session={session} reload={() => activeProjectId && loadProject(activeProjectId)} confirm={confirm} />}
          {activeView === 'manage' && canManageProjects && <ProjectManagePanel projects={projects} activeProjectId={activeProjectId} manageProjectId={manageProjectId} clearManageProjectId={() => setManageProjectId('')} setActiveProjectId={setActiveProjectId} setActiveView={setActiveView} refreshProjects={refreshProjects} loadProject={loadProject} isSuperAdmin={isSuperAdmin} confirm={confirm} />}
          {activeView === 'upload' && canManageProjects && <UploadPanel activeProjectId={activeProjectId} setActiveProjectId={setActiveProjectId} refreshProjects={refreshProjects} tree={tree} reload={() => activeProjectId && loadProject(activeProjectId)} isSuperAdmin={isSuperAdmin} token={session.token} confirm={confirm} />}
          {activeView === 'export' && canManageProjects && <ExportPanel progress={progress} projectId={activeProjectId} token={session.token} tree={tree} queue={queue} confirm={confirm} />}
          {activeView === 'accounts' && canManageProjects && <AccountPanel session={session} isSuperAdmin={isSuperAdmin} confirm={confirm} />}
          {activeView === 'health' && isSuperAdmin && <HealthPanel queue={queue} token={session.token} confirm={confirm} />}
          {activeView === 'diagnostics' && <DiagnosticsPanel queue={queue} token={session.token} />}
          {activeView === 'more' && <MorePanel canManageProjects={canManageProjects} isSuperAdmin={isSuperAdmin} token={session.token} setActiveView={setActiveView} logout={logout} />}
        </section>
      </main>
      <nav className="bottom-nav" aria-label="手机导航">
        {bottomViews.map((view) => <button key={view} type="button" className={activeView === view ? 'active' : ''} onClick={() => setActiveView(view)}>{VIEW_LABELS[view]}</button>)}
      </nav>
      {confirmDialog}
    </div>
  );
}

function Login({ onLogin }) {
  const [form, setForm] = useState(DEFAULT_LOGIN);
  const [serverUrl, setServerUrl] = useState(() => getSavedServerConfig().apiBaseUrl || getApiBaseUrl());
  const [showServerConfig, setShowServerConfig] = useState(() => isNativeApp() || !getApiBaseUrl());
  const [serverMessage, setServerMessage] = useState('');
  const [error, setError] = useState('');
  function saveServerUrl() {
    const clean = serverUrl.trim();
    if (isNativeApp() && !clean) {
      setServerMessage('Android App 需要填写服务器地址。云端测试请填写 https://你的域名；局域网测试可填写 http://电脑IP:3001。');
      return false;
    }
    if (clean && !/^https?:\/\//i.test(clean)) {
      setServerMessage('服务器地址必须以 http:// 或 https:// 开头。');
      return false;
    }
    setApiBaseUrl(clean);
    setServerMessage(clean ? `已保存服务器地址：${clean}` : '已清空服务器地址，网页端会使用当前云端站点同源接口。');
    return true;
  }
  async function testServer() {
    setError('');
    setServerMessage('正在测试连接...');
    if (!saveServerUrl()) return;
    try {
      await api('/api/public/health');
      setServerMessage('服务器连接正常。');
    } catch (err) {
      setServerMessage(`连接失败：${err.message}`);
    }
  }
  async function submit(event) {
    event.preventDefault();
    setError('');
    if (!saveServerUrl()) return;
    try {
      onLogin(await api('/api/auth/login', { method: 'POST', body: JSON.stringify(form) }));
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <main className="login">
      <form onSubmit={submit} className="login-form">
        <h1>通信工程照片采集</h1>
        <section className="server-config">
          <div className="section-head">
            <div>
              <strong>服务器地址</strong>
              <p className="hint">{isNativeApp() ? 'Android App 云端测试填写 https://你的域名。' : '网页端部署到云端后可留空，自动使用当前域名。'}</p>
            </div>
            <button type="button" className="ghost" onClick={() => setShowServerConfig(!showServerConfig)}>{showServerConfig ? '收起' : '设置'}</button>
          </div>
          {showServerConfig && (
            <div className="server-config-body">
              <input placeholder={isNativeApp() ? '例如：https://photo.example.com' : '留空使用当前网页域名'} value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} />
              <div className="inline-actions">
                <button type="button" className="ghost" onClick={saveServerUrl}>保存地址</button>
                <button type="button" className="ghost" onClick={testServer}>测试连接</button>
              </div>
              {serverMessage && <p className="hint">{serverMessage}</p>}
            </div>
          )}
        </section>
        <label>用户名<input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></label>
        <label>密码<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
        {error && <p className="error">{error}</p>}
        <button type="submit">登录</button>
        <p className="hint">演示账号：admin/admin123，projectadmin/project123，collector/collector123</p>
      </form>
    </main>
  );
}

function ProjectSelector({ projects, activeProjectId, setActiveProjectId }) {
  return (
    <label className="project-selector">当前项目
      <select value={activeProjectId} onChange={(event) => setActiveProjectId(event.target.value)}>
        <option value="">选择项目</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}{project.archivedAt ? '（已归档）' : ''} · {project.taskCount}任务点 · {project.deviceCount}设备位</option>)}
      </select>
    </label>
  );
}

function SearchBox({ value, onChange, placeholder }) {
  return <div className="search-input"><input placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />{value && <button type="button" className="search-clear" onClick={() => onChange('')}>清空</button>}</div>;
}

function ProjectHome({ projects, activeProjectId, progress, queue, session, canManageProjects, enterProject }) {
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const activeProgress = progress?.project && String(progress.project.id) === String(activeProjectId) ? progress : null;
  const projectQueueCount = (projectId) => queue.filter((item) => String(item.metadata?.projectId) === String(projectId)).length;
  const projectFailedCount = (projectId) => queue.filter((item) => String(item.metadata?.projectId) === String(projectId) && item.status === 'failed').length;
  const lastProject = projects.find((project) => {
    const state = readCaptureState(project.id, session?.user?.id);
    return state.taskPointId || state.devicePositionId;
  });
  const temporaryPending = activeProgress
    ? (activeProgress.tasks || []).reduce((sum, task) => {
      const taskPending = task.isTemporary && task.reviewStatus !== 'approved' ? 1 : 0;
      const devicePending = (task.devices || []).filter((device) => device.isTemporary && device.reviewStatus !== 'approved').length;
      return sum + taskPending + devicePending;
    }, 0)
    : 0;
  return (
    <div className="view-stack">
      {lastProject && (
        <button type="button" className="resume-card" onClick={() => enterProject(lastProject.id, 'capture')}>
          <strong>继续上次采集</strong>
          <span>{lastProject.name}</span>
        </button>
      )}
      {projects.length === 0 ? (
        <EmptyState title="暂无项目" text={canManageProjects ? '可到更多页面导入 Excel 或新建项目。' : '请联系管理员导入项目后再采集。'} />
      ) : (
        <div className="project-grid mobile-project-grid">
          {projects.map((project) => {
            const isActive = String(project.id) === String(activeProjectId);
            const isSelected = String(project.id) === String(selectedProjectId);
            const pending = projectQueueCount(project.id);
            const failed = projectFailedCount(project.id);
            const completed = isActive && activeProgress ? activeProgress.completedDevices : null;
            const total = isActive && activeProgress ? activeProgress.totalDevices : project.deviceCount;
            const unfinished = typeof completed === 'number' && typeof total === 'number' ? Math.max(total - completed, 0) : null;
            return (
              <article key={project.id} className={`${isActive ? 'project-card active' : 'project-card'} ${isSelected ? 'expanded' : 'compact-project-card'}`} onClick={() => setSelectedProjectId(isSelected ? '' : String(project.id))}>
                <div className="project-card-summary">
                  <div>
                    <h3>{project.name}{project.archivedAt && <span className="status-badge">已归档</span>}</h3>
                    <p>{project.taskCount} 任务点 · {project.deviceCount} 设备位</p>
                  </div>
                  <button type="button" className="ghost compact-select-button" onClick={(event) => { event.stopPropagation(); setSelectedProjectId(isSelected ? '' : String(project.id)); }}>{isSelected ? '收起' : '选择'}</button>
                </div>
                {isSelected && (
                  <>
                    <div className="project-stats">
                      <span>完成 {completed ?? '-'}/{total ?? '-'}</span>
                      <span>待同步 {pending} 张</span>
                    </div>
                    <div className="project-shortcuts" aria-label="项目状态入口">
                      <button type="button" className="status-button" onClick={(event) => { event.stopPropagation(); enterProject(project.id, 'progress'); }}><strong>{unfinished ?? '-'}</strong><span>未完成</span></button>
                      <button type="button" className="status-button" onClick={(event) => { event.stopPropagation(); enterProject(project.id, 'sync'); }}><strong>{pending}</strong><span>待同步</span></button>
                      <button type="button" className="status-button" onClick={(event) => { event.stopPropagation(); enterProject(project.id, 'sync'); }}><strong>{failed}</strong><span>同步失败</span></button>
                      <button type="button" className="status-button" onClick={(event) => { event.stopPropagation(); enterProject(project.id, 'export'); }} disabled={!canManageProjects}><strong>{isActive ? temporaryPending : '-'}</strong><span>待确认补录</span></button>
                    </div>
                    <div className="project-actions">
                      <button type="button" onClick={(event) => { event.stopPropagation(); enterProject(project.id, 'capture'); }}>进入采集</button>
                      <button type="button" className="ghost" onClick={(event) => { event.stopPropagation(); enterProject(project.id, 'progress'); }}>查看进度</button>
                      {canManageProjects && <button type="button" className="ghost" onClick={(event) => { event.stopPropagation(); enterProject(project.id, 'manage'); }}>管理详情</button>}
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MorePanel({ canManageProjects, isSuperAdmin, token, setActiveView, logout }) {
  const apkUrl = apiUrl(`/api/app/apk?token=${encodeURIComponent(token)}`);
  return (
    <div className="view-stack">
      <div className="section-head">
        <div>
          <h2>更多</h2>
          <p className="hint">账号权限、管理入口和常用工具集中在这里。</p>
        </div>
      </div>
      <div className="more-grid">
        <button type="button" className="menu-card" onClick={() => setActiveView('diagnostics')}><strong>连接诊断</strong><span>服务器、登录、网络和本地队列</span></button>
        {canManageProjects && <button type="button" className="menu-card" onClick={() => setActiveView('manage')}><strong>项目管理</strong><span>新建、改名和维护项目</span></button>}
        {canManageProjects && <button type="button" className="menu-card" onClick={() => setActiveView('upload')}><strong>导入 Excel</strong><span>上传设备位清单和模板</span></button>}
        {canManageProjects && <button type="button" className="menu-card" onClick={() => setActiveView('export')}><strong>导出成果</strong><span>导出照片、清单和 ZIP</span></button>}
        {canManageProjects && <button type="button" className="menu-card" onClick={() => setActiveView('accounts')}><strong>账号管理</strong><span>创建、查看和删除账号</span></button>}
        {isSuperAdmin && <button type="button" className="menu-card" onClick={() => setActiveView('health')}><strong>健康与备份</strong><span>查看后端状态和备份</span></button>}
        <a className="menu-card" href={apkUrl}><strong>下载 APK</strong><span>局域网内部测试安装包</span></a>
      </div>
      <button type="button" className="ghost danger" onClick={logout}>退出登录</button>
    </div>
  );
}

function SummaryStats({ progress, queue }) {
  return <div className="stat-row"><div><strong>{progress?.completedDevices ?? 0}</strong><span>已完成设备</span></div><div><strong>{progress?.totalDevices ?? 0}</strong><span>总设备</span></div><div><strong>{queue.length}</strong><span>待同步照片</span></div></div>;
}

function LocalPhotoGrid({ items }) {
  return <div className="photo-grid compact">{items.map((item) => <div key={item.id} className="photo-card local"><LocalPhotoImage item={item} alt="本地待同步" /><strong>{displayPhotoType(item.metadata?.photoType)}</strong><small>{item.metadata?.devicePositionName}</small><small>{item.status === 'failed' ? `失败：${item.lastError}` : item.status === 'syncing' ? '同步中' : '本地待同步'}</small></div>)}</div>;
}

function LocalPhotoImage({ item, alt }) {
  const [src, setSrc] = useState(() => blobUrl(item.watermarkedBlob || item.originalBlob));
  useEffect(() => {
    let active = true;
    let nextUrl = '';
    async function load() {
      if (item.watermarkedBlob || item.originalBlob) return;
      try {
        const blob = await readNativeOriginal(item);
        nextUrl = blobUrl(blob);
        if (active) setSrc(nextUrl);
      } catch {
        if (active) setSrc('');
      }
    }
    load();
    return () => {
      active = false;
      if (nextUrl) URL.revokeObjectURL(nextUrl);
    };
  }, [item.id, item.originalFilePath]);
  return src ? <img src={src} alt={alt} /> : <div className="photo-placeholder">本地照片</div>;
}

function SyncCenter({ queue, photos, tree, syncingIds, refreshQueue, retry, syncPaused, setSyncPaused, confirm }) {
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [keyword, setKeyword] = useState('');
  const localBytes = queue.reduce((sum, item) => sum + (item.originalBlob?.size || item.originalSize || 0) + (item.watermarkedBlob?.size || 0), 0);
  const localSizeText = localBytes > 1024 * 1024 ? `${(localBytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(localBytes / 1024)} KB`;
  const projects = useMemo(() => {
    const map = new Map();
    if (tree?.id) map.set(String(tree.id), { id: tree.id, name: tree.name || '当前项目' });
    queue.forEach((item) => {
      const id = String(item.metadata?.projectId || '');
      if (id && !map.has(id)) map.set(id, { id: item.metadata.projectId, name: item.metadata.projectName || '未命名项目' });
    });
    photos.forEach((photo) => {
      const id = String(photo.projectId || tree?.id || '');
      if (id && !map.has(id)) map.set(id, { id: photo.projectId || tree?.id, name: photo.projectName || tree?.name || '未命名项目' });
    });
    return [...map.values()];
  }, [tree, queue, photos]);
  const tasks = useMemo(() => {
    const map = new Map();
    (tree?.tasks || []).forEach((task) => map.set(String(task.id), { id: task.id, name: task.name, projectId: tree.id, projectName: tree.name }));
    queue.forEach((item) => {
      const id = String(item.metadata?.taskPointId || '');
      if (id && !map.has(id)) map.set(id, { id: item.metadata.taskPointId, name: item.metadata.taskPointName || '未命名任务点', projectId: item.metadata.projectId, projectName: item.metadata.projectName });
    });
    photos.forEach((photo) => {
      const id = String(photo.taskPointId || '');
      if (id && !map.has(id)) map.set(id, { id: photo.taskPointId, name: photo.taskPointName || '未命名任务点', projectId: photo.projectId || tree?.id, projectName: photo.projectName || tree?.name });
    });
    return [...map.values()];
  }, [tree, queue, photos]);
  const localForProject = (id) => queue.filter((item) => String(item.metadata?.projectId) === String(id));
  const syncedForProject = (id) => sortPhotosDesc(photos.filter((photo) => String(photo.projectId || tree?.id) === String(id)));
  const localForTask = (id) => queue.filter((item) => String(item.metadata?.taskPointId) === String(id));
  const syncedForTask = (id) => sortPhotosDesc(photos.filter((photo) => String(photo.taskPointId) === String(id)));
  const selectedProject = projects.find((project) => String(project.id) === String(selectedProjectId));
  const selectedTask = tasks.find((task) => String(task.id) === String(selectedTaskId));
  const visibleProjects = projects.filter((project) => includesKeyword([
    project.name,
    ...localForProject(project.id).flatMap((item) => [item.metadata?.taskPointName, item.metadata?.devicePositionName, displayPhotoType(item.metadata?.photoType), item.lastError])
  ], keyword));
  const tasksForSelectedProject = selectedProject ? tasks.filter((task) => String(task.projectId) === String(selectedProject.id)) : [];
  const visibleTasks = tasksForSelectedProject.filter((task) => includesKeyword([task.name, ...localForTask(task.id).flatMap((item) => [item.metadata?.devicePositionName, displayPhotoType(item.metadata?.photoType), item.lastError])], keyword));
  const failureGroups = groupSyncFailures(queue);

  async function removeLocal(id) {
    const item = queue.find((entry) => entry.id === id);
    const ok = await confirm({
      title: '删除本地待同步照片',
      message: '删除后这张照片不会上传到服务器。',
      details: [
        item?.metadata?.taskPointName ? `任务点：${item.metadata.taskPointName}` : '',
        item?.metadata?.devicePositionName ? `设备位：${item.metadata.devicePositionName}` : '',
        item?.metadata?.photoType ? `照片类型：${displayPhotoType(item.metadata.photoType)}` : ''
      ].filter(Boolean),
      confirmText: '删除本地照片',
      danger: true
    });
    if (!ok) return;
    if (item) await removeNativeOriginal(item);
    await removeQueuedPhoto(id);
    await refreshQueue();
  }

  function togglePause() {
    const next = !syncPaused;
    setSyncPaused(next);
    localStorage.setItem('sync-paused', next ? '1' : '0');
  }

  if (!selectedProject) {
    return (
      <div className="view-stack">
        <div className="section-head"><div><h2>同步中心</h2><p className="hint">先按项目查看同步情况，进入项目后再查看任务点和照片明细。</p></div><div className="inline-actions"><button type="button" className="ghost" onClick={togglePause}>{syncPaused ? '继续自动同步' : '暂停自动同步'}</button><button type="button" onClick={() => retry(queue.map((item) => item.id))} disabled={queue.length === 0}>全部重试</button></div></div>
        <SearchBox placeholder="搜索项目、任务点、设备位、照片类型或失败原因" value={keyword} onChange={setKeyword} />
        <div className="stat-row"><div><strong>{projects.length}</strong><span>项目</span></div><div><strong>{queue.length}</strong><span>本地待同步</span></div><div><strong>{queue.filter((item) => item.status === 'failed').length}</strong><span>同步失败</span></div><div><strong>{localSizeText}</strong><span>本机占用</span></div></div>
        {syncPaused && <p className="warning-text">自动同步已暂停，手动点击重试仍会上传选中的照片。</p>}
        <FailureSummary groups={failureGroups} />
        {visibleProjects.length === 0 ? <EmptyState title="没有匹配的项目" text="调整搜索条件后再查看同步状态。" /> : <div className="compact-list">{visibleProjects.map((project) => {
          const local = localForProject(project.id);
          const synced = syncedForProject(project.id);
          const failed = local.filter((item) => item.status === 'failed').length;
          const syncing = local.filter((item) => syncingIds.includes(item.id) || item.status === 'syncing').length;
          return <button key={project.id} type="button" className={`compact-list-item ${progressStatusClass({ missingCount: 0, localPending: local.length, failed })}`} onClick={() => { setSelectedProjectId(String(project.id)); setKeyword(''); }}><span className="item-main"><strong>{project.name}</strong><small>待同步 {local.length} · 失败 {failed} · 同步中 {syncing}</small></span><span className="item-meta"><strong>{local.length}</strong><small>已同步 {synced.length} 张</small></span></button>;
        })}</div>}
      </div>
    );
  }

  if (!selectedTask) {
    const selectedLocal = localForProject(selectedProject.id);
    const selectedSynced = syncedForProject(selectedProject.id);
    return (
      <div className="view-stack">
        <div className="capture-detail-head"><button type="button" className="ghost" onClick={() => { setSelectedProjectId(''); setSelectedTaskId(''); setKeyword(''); }}>返回项目</button><div><h2>{selectedProject.name}</h2><p className="hint">本地待同步 {selectedLocal.length} 张 · 已同步 {selectedSynced.length} 张</p></div></div>
        <SearchBox placeholder="搜索任务点、设备位、照片类型或失败原因" value={keyword} onChange={setKeyword} />
        <div className="compact-list">{visibleTasks.map((task) => {
          const local = localForTask(task.id);
          const synced = syncedForTask(task.id);
          const failed = local.filter((item) => item.status === 'failed').length;
          const syncing = local.filter((item) => syncingIds.includes(item.id) || item.status === 'syncing').length;
          return <button key={task.id} type="button" className={`compact-list-item ${progressStatusClass({ missingCount: 0, localPending: local.length, failed })}`} onClick={() => { setSelectedTaskId(String(task.id)); setKeyword(''); }}><span className="item-main"><strong>{task.name}</strong><small>待同步 {local.length} · 失败 {failed} · 同步中 {syncing}</small></span><span className="item-meta"><strong>{local.length}</strong><small>已同步 {synced.length} 张</small></span></button>;
        })}</div>
        {visibleTasks.length === 0 && <EmptyState title="没有匹配的任务点" text="调整搜索条件后再查看同步状态。" />}
      </div>
    );
  }

  const selectedLocal = localForTask(selectedTask.id);
  const selectedSynced = syncedForTask(selectedTask.id);
  return (
    <div className="view-stack">
      <div className="capture-detail-head"><button type="button" className="ghost" onClick={() => { setSelectedTaskId(''); setKeyword(''); }}>返回任务点</button><div><h2>{selectedTask.name}</h2><p className="hint">{selectedProject.name} · 本地待同步 {selectedLocal.length} 张 · 已同步 {selectedSynced.length} 张</p></div></div>
      <div className="section-head"><h3>本地待同步照片</h3><button type="button" className="ghost" onClick={() => retry(selectedLocal.map((item) => item.id))} disabled={selectedLocal.length === 0}>重试本任务点</button></div>
      {selectedLocal.length === 0 ? <p className="hint">这个任务点没有本地待同步照片。</p> : <div className="queue-cards">{selectedLocal.map((item) => <article key={item.id} className="queue-card"><LocalPhotoImage item={item} alt="待同步照片" /><div><strong>{item.metadata?.devicePositionName || '未命名设备'}</strong><p>{item.metadata?.deviceType} · {displayPhotoType(item.metadata?.photoType)}</p><small>{new Date(item.metadata?.capturedAt || Date.now()).toLocaleString()}</small><small>状态：{syncingIds.includes(item.id) ? '同步中' : item.status === 'failed' ? '失败' : '待同步'}</small>{item.lastError && <small className="error">{item.lastError}</small>}</div><div className="queue-actions"><button type="button" className="ghost" onClick={() => retry([item.id])}>重试</button><button type="button" className="ghost danger" onClick={() => removeLocal(item.id)}>删除本地</button></div></article>)}</div>}
      <h3>已同步照片</h3>
      {selectedSynced.length === 0 ? <p className="hint">这个任务点还没有已同步照片。</p> : <div className="photo-grid compact">{selectedSynced.map((photo) => <div key={photo.id} className="photo-card"><img src={uploadUrl(photo.watermarkedPath)} alt={photo.fileName} /><strong>{photo.devicePositionName}</strong><span>{photo.deviceType} · {displayPhotoType(photo.photoType)}</span><small>{photo.fileName}</small></div>)}</div>}
    </div>
  );
}

function groupSyncFailures(queue) {
  const groups = new Map();
  queue.filter((item) => item.status === 'failed').forEach((item) => {
    const error = String(item.lastError || '未知错误');
    let key = '其他错误';
    let advice = '查看失败详情，重试仍失败时请联系管理员。';
    if (/fetch|network|failed to fetch|连接|timeout|econn|离线/i.test(error)) {
      key = '服务器连接失败';
      advice = '检查手机网络、服务器地址、电脑后端服务和 Windows 防火墙。';
    } else if (/file|blob|not found|读取|私有目录|missing/i.test(error)) {
      key = '本地照片文件异常';
      advice = '照片原图可能被清理，建议删除本地队列后重拍。';
    } else if (/403|401|权限|登录|token/i.test(error)) {
      key = '登录或权限异常';
      advice = '重新登录后重试；采集员只能处理自己有权限的照片。';
    } else if (/水印|canvas|decode|image|图片|生成/i.test(error)) {
      key = '水印或图片处理失败';
      advice = '先重试；仍失败时删除本地队列后重新拍摄。';
    }
    if (!groups.has(key)) groups.set(key, { key, advice, items: [] });
    groups.get(key).items.push(item);
  });
  return [...groups.values()];
}

function FailureSummary({ groups }) {
  if (!groups.length) return null;
  return (
    <section className="failure-summary">
      <h3>同步失败原因</h3>
      {groups.map((group) => (
        <div key={group.key} className="failure-group">
          <strong>{group.key} · {group.items.length} 张</strong>
          <span>{group.advice}</span>
        </div>
      ))}
    </section>
  );
}

function PhotoPreviewModal({ photo, onClose }) {
  const [mode, setMode] = useState(photo.previewMode || 'watermarked');
  const imagePath = mode === 'original' ? photo.originalPath : photo.watermarkedPath;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="photo-modal" onClick={(event) => event.stopPropagation()}>
        <div className="section-head">
          <div>
            <h3>{photo.devicePositionName || photo.fileName}</h3>
            <p className="hint">{photo.deviceType ? `${photo.deviceType} · ` : ''}{displayPhotoType(photo.photoType)}{photo.capturedBy ? ` · ${photo.capturedBy}` : ''}</p>
          </div>
          <button type="button" className="ghost" onClick={onClose}>关闭</button>
        </div>
        <div className="inline-actions">
          <button type="button" className={mode === 'watermarked' ? 'active' : 'ghost'} onClick={() => setMode('watermarked')}>查看水印图</button>
          <button type="button" className={mode === 'original' ? 'active' : 'ghost'} onClick={() => setMode('original')}>查看原图</button>
        </div>
        <img src={uploadUrl(imagePath)} alt={photo.fileName} />
        <p className="hint">{imagePath}</p>
      </div>
    </div>
  );
}

function ProgressPanel({ progress, queue, projectId, photos, session, reload, confirm }) {
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [projectKeyword, setProjectKeyword] = useState('');
  const [deviceKeyword, setDeviceKeyword] = useState('');
  const [photoKeyword, setPhotoKeyword] = useState('');
  const [previewPhoto, setPreviewPhoto] = useState(null);
  if (!progress) return <EmptyState title="暂无进度" text="选择项目并联网后可查看采集进度。" />;
  const selectedTask = progress.tasks.find((task) => String(task.id) === String(selectedTaskId));
  const selectedDevice = selectedTask?.devices.find((device) => String(device.id) === String(selectedDeviceId));
  const localForTask = (id) => queue.filter((item) => String(item.metadata?.taskPointId) === String(id));
  const localForDevice = (id) => queue.filter((item) => String(item.metadata?.devicePositionId) === String(id));
  const syncedForTask = (id) => sortPhotosDesc(photos.filter((photo) => String(photo.taskPointId) === String(id)));
  const syncedForDevice = (id) => sortPhotosDesc(photos.filter((photo) => String(photo.devicePositionId) === String(id)));
  async function deletePhoto(photo) {
    const ok = await confirm({
      title: '删除并重拍',
      message: '照片会进入回收站，可由管理员恢复。',
      details: [`文件：${photo.fileName}`, `设备：${photo.devicePositionName}`, `类型：${displayPhotoType(photo.photoType)}`],
      confirmText: '删除并重拍',
      danger: true
    });
    if (!ok) return;
    await api(`/api/projects/${projectId}/photos/${photo.id}`, { method: 'DELETE', body: JSON.stringify({ reason: '删除重拍' }) });
    await reload();
  }

  if (selectedTask && selectedDevice) {
    const local = localForDevice(selectedDevice.id);
    const synced = syncedForDevice(selectedDevice.id);
    const visibleLocal = local.filter((item) => includesKeyword([item.metadata?.devicePositionName, displayPhotoType(item.metadata?.photoType), item.status, item.lastError], photoKeyword));
    const visibleSynced = synced.filter((photo) => includesKeyword([photo.devicePositionName, photo.deviceType, displayPhotoType(photo.photoType), photo.fileName, photo.capturedBy], photoKeyword));
    return <div className="view-stack"><div className="capture-detail-head"><button type="button" className="ghost" onClick={() => setSelectedDeviceId('')}>返回设备列表</button><div><h2>{selectedDevice.name}</h2><p className="hint">{selectedTask.name} · {selectedDevice.deviceType}</p></div></div><div className="stat-row"><div><strong>{synced.length}</strong><span>已同步照片</span></div><div><strong>{local.length}</strong><span>本地待同步</span></div><div><strong>{selectedDevice.missingRequired.length}</strong><span>缺失必拍</span></div></div>{selectedDevice.missingRequired.length > 0 && <div className="missing-box">缺少：{selectedDevice.missingRequired.map(displayPhotoType).join('、')}</div>}<SearchBox placeholder="搜索照片类型、文件名或采集人" value={photoKeyword} onChange={setPhotoKeyword} /><h3>本地待同步</h3>{visibleLocal.length === 0 ? <p className="hint">没有匹配的本地待同步照片。</p> : <LocalPhotoGrid items={visibleLocal} />}<h3>已同步照片</h3>{visibleSynced.length === 0 ? <p className="hint">没有匹配的已同步照片。</p> : <div className="photo-grid compact">{visibleSynced.map((photo) => { const canDelete = session?.user.role !== 'collector' || Number(photo.capturedById) === Number(session?.user.id); return <div key={photo.id} className="photo-card"><button type="button" className="image-button" onClick={() => setPreviewPhoto(photo)}><img src={uploadUrl(photo.watermarkedPath)} alt={photo.fileName} /></button><strong>{displayPhotoType(photo.photoType)}</strong><small>{photo.fileName}</small>{photo.qualityWarnings?.length > 0 && <small className="warning-text">{photo.qualityWarnings.join('、')}</small>}<div className="photo-path-actions"><button type="button" className="ghost tiny" onClick={() => setPreviewPhoto({ ...photo, previewMode: 'watermarked' })}>水印图</button><button type="button" className="ghost tiny" onClick={() => setPreviewPhoto({ ...photo, previewMode: 'original' })}>原图</button></div>{canDelete && <button type="button" className="ghost" onClick={() => deletePhoto(photo)}>删除并重拍</button>}</div>; })}</div>}{previewPhoto && <PhotoPreviewModal photo={previewPhoto} onClose={() => setPreviewPhoto(null)} />}</div>;
  }
  if (selectedTask) {
    const visibleDevices = selectedTask.devices.filter((device) => includesKeyword([device.name, device.code, device.deviceType, ...(device.missingRequired || []).map(displayPhotoType)], deviceKeyword)).sort((a, b) => {
      const aLocal = localForDevice(a.id);
      const bLocal = localForDevice(b.id);
      return progressPriority({ missingCount: a.missingRequired.length, localPending: aLocal.length, failed: aLocal.filter((item) => item.status === 'failed').length, reviewStatus: a.reviewStatus }) -
        progressPriority({ missingCount: b.missingRequired.length, localPending: bLocal.length, failed: bLocal.filter((item) => item.status === 'failed').length, reviewStatus: b.reviewStatus });
    });
    return <div className="view-stack"><div className="capture-detail-head"><button type="button" className="ghost" onClick={() => { setSelectedTaskId(''); setSelectedDeviceId(''); }}>返回项目总进度</button><div><h2>{selectedTask.name}</h2><p className="hint">设备完成 {selectedTask.completedDevices}/{selectedTask.totalDevices}</p></div></div><div className="stat-row"><div><strong>{selectedTask.completedDevices}</strong><span>已完成设备</span></div><div><strong>{selectedTask.totalDevices}</strong><span>总设备</span></div><div><strong>{localForTask(selectedTask.id).length}</strong><span>待同步照片</span></div></div><SearchBox placeholder="搜索设备位、编号、设备类型或缺失项" value={deviceKeyword} onChange={setDeviceKeyword} /><div className="task-point-grid">{visibleDevices.map((device) => { const local = localForDevice(device.id); const synced = syncedForDevice(device.id); return <button key={device.id} type="button" className={`task-point-card device-point-card ${progressStatusClass({ missingCount: device.missingRequired.length, localPending: local.length, failed: local.filter((item) => item.status === 'failed').length })}`} onClick={() => setSelectedDeviceId(String(device.id))}><span>{device.name}</span><strong>{device.completed ? '完成' : `${device.missingRequired.length}缺`}</strong><small>{device.deviceType} · 已同步 {synced.length} 张 · 待同步 {local.length} 张</small><small>{device.completed ? '已完成必拍' : `缺少：${device.missingRequired.map(displayPhotoType).join('、') || '照片'}`}</small></button>; })}</div>{visibleDevices.length === 0 && <EmptyState title="没有匹配的设备" text="调整搜索条件后再查看设备进度。" />}</div>;
  }
  const visibleTasks = progress.tasks.filter((task) => includesKeyword([task.name, ...task.devices.flatMap((device) => [device.name, device.code, device.deviceType, ...(device.missingRequired || []).map(displayPhotoType)])], projectKeyword)).sort((a, b) => {
    const aLocal = localForTask(a.id);
    const bLocal = localForTask(b.id);
    return progressPriority({ missingCount: a.totalDevices - a.completedDevices, localPending: aLocal.length, failed: aLocal.filter((item) => item.status === 'failed').length, reviewStatus: a.reviewStatus }) -
      progressPriority({ missingCount: b.totalDevices - b.completedDevices, localPending: bLocal.length, failed: bLocal.filter((item) => item.status === 'failed').length, reviewStatus: b.reviewStatus });
  });
  return <div className="view-stack"><div className="section-head"><div><h2>采集进度</h2><p className="hint">{progress.project.name}</p></div></div><SummaryStats progress={progress} queue={queue} /><SearchBox placeholder="搜索任务点、设备位、编号、设备类型或缺失项" value={projectKeyword} onChange={setProjectKeyword} /><div className="task-point-grid">{visibleTasks.map((task) => { const local = localForTask(task.id); const synced = syncedForTask(task.id); return <button key={task.id} type="button" className={`task-point-card ${progressStatusClass({ missingCount: task.totalDevices - task.completedDevices, localPending: local.length, failed: local.filter((item) => item.status === 'failed').length })}`} onClick={() => setSelectedTaskId(String(task.id))}><span>{task.name}</span><strong>{task.completedDevices}/{task.totalDevices}</strong><small>已同步照片 {synced.length} 张 · 待同步 {local.length} 张</small><small>{task.totalDevices - task.completedDevices === 0 ? '全部设备已完成必拍' : `未完成设备 ${task.totalDevices - task.completedDevices} 台`}</small></button>; })}</div>{visibleTasks.length === 0 && <EmptyState title="没有匹配的任务点" text="调整搜索条件后再查看项目进度。" />}</div>;
}

function ProjectManagePanel({ projects, activeProjectId, manageProjectId, clearManageProjectId, setActiveProjectId, setActiveView, refreshProjects, loadProject, isSuperAdmin, confirm }) {
  const [manageMode, setManageMode] = useState('list');
  const [newName, setNewName] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [cleanupMessage, setCleanupMessage] = useState('');
  const activeProject = projects.find((project) => String(project.id) === String(activeProjectId));

  useEffect(() => {
    if (!manageProjectId) return;
    const target = projects.find((project) => String(project.id) === String(manageProjectId));
    if (!target) return;
    setActiveProjectId(String(target.id));
    setRenameValue(target.name);
    setManageMode('detail');
    clearManageProjectId?.();
  }, [manageProjectId, projects]);

  async function createProject(event) {
    event.preventDefault();
    if (!newName.trim()) return;
    const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: newName.trim() }) });
    setNewName('');
    await refreshProjects();
    setActiveProjectId(String(created.id));
  }
  async function renameProject(event) {
    event.preventDefault();
    if (!activeProjectId || !renameValue.trim()) return;
    await api(`/api/projects/${activeProjectId}`, { method: 'PATCH', body: JSON.stringify({ name: renameValue.trim() }) });
    setRenameValue('');
    await refreshProjects();
    await loadProject(activeProjectId);
  }
  async function deleteProject(project) {
    const ok = await confirm({
      title: '删除项目',
      message: `确认删除项目“${project.name}”？`,
      details: ['项目设备位会被删除', '项目照片记录会被删除', '此操作不可在页面直接撤销', `继续前还需要输入项目名：${project.name}`],
      confirmText: '继续删除项目',
      danger: true
    });
    if (!ok) return;
    const typed = window.prompt(`请输入项目名称“${project.name}”确认删除`);
    if (typed !== project.name) return;
    await api(`/api/projects/${project.id}`, { method: 'DELETE' });
    await refreshProjects();
    setActiveProjectId('');
  }
  async function toggleArchive(project) {
    const archived = !project.archivedAt;
    const ok = await confirm({
      title: archived ? '归档项目' : '取消归档项目',
      message: `确认${archived ? '归档' : '取消归档'}项目“${project.name}”？`,
      details: archived ? ['归档后项目仍可查看和导出', '现场采集前请确认是否仍需要开放'] : ['项目会重新显示为可用状态'],
      confirmText: archived ? '归档' : '取消归档'
    });
    if (!ok) return;
    await api(`/api/projects/${project.id}/archive`, { method: 'PATCH', body: JSON.stringify({ archived }) });
    await refreshProjects();
    if (String(project.id) === String(activeProjectId)) await loadProject(activeProjectId);
  }
  async function cleanup(kind) {
    if (!activeProjectId) return;
    const labels = { recycle: '清空回收站照片', photos: '清空项目全部照片', devices: '清空项目任务点和设备位', all: '清空项目全部数据' };
    const ok = await confirm({
      title: '项目数据清理',
      message: `确认${labels[kind]}？`,
      details: ['后端会先生成安全备份', '清理后不可在页面直接撤销', activeProject?.name ? `项目：${activeProject.name}` : '', kind === 'all' && activeProject?.name ? `清空全部数据还需要输入项目名：${activeProject.name}` : ''],
      confirmText: kind === 'all' ? '继续清空全部数据' : labels[kind],
      danger: true
    });
    if (!ok) return;
    if (kind === 'all' && activeProject?.name) {
      const typed = window.prompt(`请输入项目名称“${activeProject.name}”确认清空全部数据`);
      if (typed !== activeProject.name) return;
    }
    setCleanupMessage('正在清理...');
    const result = await api(`/api/projects/${activeProjectId}/cleanup`, { method: 'POST', body: JSON.stringify({ kind }) });
    setCleanupMessage(`清理完成：删除照片 ${result.deletedPhotos || 0} 张，删除任务点 ${result.deletedTasks || 0} 个，安全备份：${result.backupFile || '已生成'}`);
    await refreshProjects();
    await loadProject(activeProjectId);
  }
  if (manageMode === 'cleanup') {
    return (
      <div className="view-stack">
        <div className="capture-detail-head">
          <button type="button" className="ghost" onClick={() => setManageMode(activeProject ? 'detail' : 'list')}>返回项目详情</button>
          <div>
            <h2>项目数据清理</h2>
            <p className="hint">{activeProject?.name || '当前项目'} · 后端会先生成安全备份。</p>
          </div>
        </div>
        <section className="admin-tools danger-zone">
          <p className="hint">清理后不可在页面直接撤销，请只在确认要清理测试数据时使用。</p>
          <div className="cleanup-grid">
            <button type="button" className="ghost" onClick={() => cleanup('recycle')}>清空回收站</button>
            <button type="button" className="ghost" onClick={() => cleanup('photos')}>清空照片</button>
            <button type="button" className="ghost" onClick={() => cleanup('devices')}>清空任务点和设备</button>
            <button type="button" className="ghost danger" onClick={() => cleanup('all')}>清空全部数据</button>
          </div>
          {cleanupMessage && <p className="hint">{cleanupMessage}</p>}
        </section>
      </div>
    );
  }
  if (manageMode === 'detail' && activeProject) {
    return (
      <div className="view-stack">
        <div className="capture-detail-head">
          <button type="button" className="ghost" onClick={() => setManageMode('list')}>返回项目列表</button>
          <div>
            <h2>{activeProject.name}</h2>
            <p className="hint">{activeProject.taskCount} 任务点 · {activeProject.deviceCount} 设备位 · 创建人：{activeProject.createdByName || '未知'}</p>
          </div>
        </div>
        <section className="download-card">
          <h3>基本信息</h3>
          <form className="inline-form" onSubmit={renameProject}>
            <input placeholder="项目新名称" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
            <button type="submit">保存改名</button>
          </form>
          <div className="detail-actions">
            <button type="button" onClick={() => setActiveView('capture')}>进入采集</button>
            <button type="button" className="ghost" onClick={() => setActiveView('upload')}>导入 Excel / 照片类型</button>
            <button type="button" className="ghost" onClick={() => setActiveView('export')}>导出与检查</button>
            <button type="button" className="ghost" onClick={() => toggleArchive(activeProject)}>{activeProject.archivedAt ? '取消归档' : '归档项目'}</button>
            {isSuperAdmin && <button type="button" className="ghost danger" onClick={() => setManageMode('cleanup')}>进入危险操作</button>}
            <button type="button" className="ghost danger" onClick={() => deleteProject(activeProject)}>删除项目</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="view-stack">
      <div className="section-head">
        <div>
          <h2>项目管理</h2>
          <p className="hint">先选择项目，再进入详情维护基础信息、导入导出和数据清理。</p>
        </div>
      </div>
      <form className="inline-form" onSubmit={createProject}>
        <input placeholder="新项目名称" value={newName} onChange={(event) => setNewName(event.target.value)} />
        <button type="submit">新建项目</button>
      </form>
      <div className="project-grid">
        {projects.map((project) => (
          <article key={project.id} className={String(project.id) === String(activeProjectId) ? 'project-card active' : 'project-card'}>
            <h3>{project.name}{project.archivedAt && <span className="status-badge">已归档</span>}</h3>
            <p>{project.taskCount} 任务点 · {project.deviceCount} 设备位</p>
            <p>创建人：{project.createdByName || '未知'}</p>
            <div className="project-actions">
              <button type="button" onClick={() => { setActiveProjectId(String(project.id)); setRenameValue(project.name); setManageMode('detail'); }}>管理详情</button>
              <button type="button" className="ghost" onClick={() => { setActiveProjectId(String(project.id)); setActiveView('capture'); }}>进入采集</button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function UploadPanel({ activeProjectId, setActiveProjectId, refreshProjects, tree, reload, isSuperAdmin, token, confirm }) {
  const [file, setFile] = useState(null);
  const [fields, setFields] = useState({ project: '项目', taskPoint: '任务点', devicePosition: '设备位', deviceCode: '设备编号', deviceType: '设备类型' });
  const [preview, setPreview] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function downloadTemplate() {
    setMessage('正在准备模板...');
    try {
      const response = await fetch(apiUrl('/api/projects/import-template'), { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '模板下载失败');
      const blob = await response.blob();
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({ suggestedName: '设备导入模板.xlsx', types: [{ description: 'Excel 工作簿', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }] });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        setMessage('模板已保存到你选择的位置。');
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = '设备导入模板.xlsx';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage('当前浏览器不支持选择保存路径，已保存到默认下载目录。');
    } catch (err) {
      setMessage(err.name === 'AbortError' ? '已取消保存模板。' : `模板下载失败：${err.message}`);
    }
  }
  async function previewExcel(nextFile = file) {
    if (!nextFile) return;
    setBusy(true);
    setPreview(null);
    setMessage('正在预检查 Excel...');
    try {
      const form = new FormData();
      form.append('file', nextFile);
      form.append('fields', JSON.stringify(fields));
      setPreview(await api('/api/projects/import-preview', { method: 'POST', body: form }));
      setMessage('预检查完成，确认无误后再导入。');
    } catch (err) {
      setMessage(`预检查失败：${err.message}`);
    } finally {
      setBusy(false);
    }
  }
  async function importExcel(event) {
    event.preventDefault();
    if (!file) return;
    if (!preview) {
      const ok = await confirm({
        title: '未预检查直接导入',
        message: '建议先预检查 Excel，避免项目名、任务点或设备位字段映射错误。',
        confirmText: '仍然导入',
        danger: true
      });
      if (!ok) return;
    }
    setBusy(true);
    setMessage('正在导入...');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('fields', JSON.stringify(fields));
      const data = await api('/api/projects/import-excel', { method: 'POST', body: form });
      setMessage(`导入完成：${data.imported} 行，跳过 ${data.skipped} 行。项目名称来自 Excel：${data.project.name}`);
      setActiveProjectId(String(data.project.id));
      setPreview(null);
      await refreshProjects();
      await reload();
    } catch (err) {
      setMessage(`导入失败：${err.message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="view-stack">
      <div className="section-head">
        <div>
          <h2>Excel 导入</h2>
          <p className="hint">项目名称从 Excel 项目列读取。建议先预检查，再确认导入。</p>
        </div>
        <button type="button" className="button-link" onClick={downloadTemplate}>下载输入模板</button>
      </div>
      <form className="panel-subform" onSubmit={importExcel}>
        <input type="file" accept=".xlsx,.xls,.csv" onChange={async (event) => { const nextFile = event.target.files?.[0] || null; setFile(nextFile); setPreview(null); if (nextFile) await previewExcel(nextFile); }} />
        <div className="field-grid">
          <label>项目列<input value={fields.project} onChange={(event) => setFields({ ...fields, project: event.target.value })} /></label>
          <label>任务点列<input value={fields.taskPoint} onChange={(event) => setFields({ ...fields, taskPoint: event.target.value })} /></label>
          <label>设备位列<input value={fields.devicePosition} onChange={(event) => setFields({ ...fields, devicePosition: event.target.value })} /></label>
          <label>设备编号列<input value={fields.deviceCode} onChange={(event) => setFields({ ...fields, deviceCode: event.target.value })} /></label>
          <label>设备类型列<input value={fields.deviceType} onChange={(event) => setFields({ ...fields, deviceType: event.target.value })} /></label>
        </div>
        <div className="inline-actions">
          <button type="button" className="ghost" onClick={() => previewExcel()} disabled={!file || busy}>重新预检查</button>
          <button type="submit" disabled={!file || busy}>确认导入 Excel</button>
        </div>
        {message && <p className="hint">{message}</p>}
      </form>
      {preview && <ImportPreview preview={preview} />}
      {tree && <PhotoTypeManager projectId={activeProjectId} tree={tree} reload={reload} />}
      {isSuperAdmin && <TemplateManager />}
    </div>
  );
}

function ImportPreview({ preview }) {
  const missingTemplateTypes = (preview.templateMatches || []).filter((item) => !item.photoTypes?.length).map((item) => item.deviceType);
  return (
    <section className="download-card import-preview">
      <h3>导入预检查</h3>
      <div className="check-grid">
        <div><strong>{preview.projectName || '未识别'}</strong><span>将导入项目</span></div>
        <div><strong>{preview.existingProject ? '追加' : '新建'}</strong><span>项目处理</span></div>
        <div><strong>{preview.taskPointCount}</strong><span>任务点</span></div>
        <div><strong>{preview.deviceCount}</strong><span>设备位</span></div>
        <div><strong>{preview.duplicateCount}</strong><span>重复项</span></div>
        <div><strong>{preview.errorCount}</strong><span>错误行</span></div>
      </div>
      {preview.projectNames?.length > 1 && <PreviewBlock title="多个项目名" items={[`文件中存在多个项目名：${preview.projectNames.join('、')}`]} />}
      <PreviewBlock title="设备类型与必拍模板" items={(preview.templateMatches || []).map((item) => `${item.deviceType}：${item.photoTypes?.length ? item.photoTypes.map((type) => `${type.name}${type.required ? '（必拍）' : ''}`).join('、') : '未配置模板，将使用通用配置或后续手动补充'}`)} />
      {missingTemplateTypes.length > 0 && <PreviewBlock title="设备类型缺少模板" items={missingTemplateTypes.map((type) => `${type} 未配置专用必拍模板`)} danger />}
      {preview.duplicateCount > 0 && <PreviewBlock title="重复设备位" items={preview.duplicates} danger />}
      {preview.errorCount > 0 && <PreviewBlock title="空字段或错误行" items={preview.errors} danger />}
    </section>
  );
}

function PreviewBlock({ title, items = [], danger = false }) {
  if (!items.length) return null;
  return (
    <div className={danger ? 'warning-list preview-block' : 'preview-block'}>
      <strong>{title}</strong>
      {items.slice(0, 12).map((item) => <span key={item}>{item}</span>)}
      {items.length > 12 && <span>仅显示前 12 条，其余导入时会继续检查。</span>}
    </div>
  );
}

function TemplateManager() {
  const [templates, setTemplates] = useState([]);
  const [form, setForm] = useState({ deviceType: '', name: '', required: true });
  async function load() { const data = await api('/api/templates'); setTemplates(data.templates); }
  useEffect(() => { load(); }, []);
  async function addTemplate(event) {
    event.preventDefault();
    await api('/api/templates', { method: 'POST', body: JSON.stringify(form) });
    setForm({ deviceType: '', name: '', required: true });
    await load();
  }
  async function deleteTemplate(id) {
    await api(`/api/templates/${id}`, { method: 'DELETE' });
    await load();
  }
  const groups = [...new Set(templates.map((item) => item.deviceType))].map((deviceType) => ({ deviceType, templates: templates.filter((item) => item.deviceType === deviceType) }));
  return <section className="admin-tools"><h3>设备类型模板</h3><div className="type-groups">{groups.map((group) => <div key={group.deviceType} className="type-group"><h4>{group.deviceType}</h4><div className="chips">{group.templates.map((item) => <span key={item.id} className={item.required ? 'chip required removable' : 'chip removable'}>{item.name}{item.required ? ' 必拍' : ' 可选'}<button type="button" className="chip-delete" onClick={() => deleteTemplate(item.id)}>删除</button></span>)}</div></div>)}</div><form className="inline-form photo-type-form" onSubmit={addTemplate}><input placeholder="设备类型" value={form.deviceType} onChange={(event) => setForm({ ...form, deviceType: event.target.value })} /><input placeholder="照片类型" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /><label className="checkbox"><input type="checkbox" checked={form.required} onChange={(event) => setForm({ ...form, required: event.target.checked })} />必拍</label><button type="submit">添加模板</button></form></section>;
}

function PhotoTypeManager({ projectId, tree, reload }) {
  const [selectedDeviceType, setSelectedDeviceType] = useState('通用');
  const [typeName, setTypeName] = useState('');
  const [typeRequired, setTypeRequired] = useState(true);
  const deviceTypes = useMemo(() => [...new Set([...(tree?.tasks || []).flatMap((task) => task.devices.map((device) => device.deviceType || '通用')), ...(tree?.photoTypes || []).map((type) => type.deviceType || '通用'), '通用'])], [tree]);
  useEffect(() => { if (!deviceTypes.includes(selectedDeviceType)) setSelectedDeviceType(deviceTypes[0] || '通用'); }, [deviceTypes.join('|')]);
  async function addPhotoType(event) {
    event.preventDefault();
    if (!typeName.trim()) return;
    await api(`/api/projects/${projectId}/photo-types`, { method: 'POST', body: JSON.stringify({ name: typeName, deviceType: selectedDeviceType, required: typeRequired }) });
    setTypeName('');
    await reload();
  }
  async function deletePhotoType(typeId) {
    await api(`/api/projects/${projectId}/photo-types/${typeId}`, { method: 'DELETE' });
    await reload();
  }
  return <section className="admin-tools"><h3>项目照片类型</h3><div className="type-groups">{deviceTypes.map((deviceType) => <div key={deviceType} className="type-group"><h4>{deviceType}</h4><div className="chips">{(tree?.photoTypes || []).filter((type) => (type.deviceType || '通用') === deviceType).map((type) => <span key={type.id} className={type.required ? 'chip required removable' : 'chip removable'}>{type.name}{type.required ? ' 必拍' : ' 可选'}<button type="button" className="chip-delete" onClick={() => deletePhotoType(type.id)}>删除</button></span>)}</div></div>)}</div><form className="inline-form photo-type-form" onSubmit={addPhotoType}><select value={selectedDeviceType} onChange={(event) => setSelectedDeviceType(event.target.value)}>{deviceTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select><input placeholder="照片类型" value={typeName} onChange={(event) => setTypeName(event.target.value)} /><label className="checkbox"><input type="checkbox" checked={typeRequired} onChange={(event) => setTypeRequired(event.target.checked)} />必拍</label><button type="submit">添加</button></form></section>;
}

function ExportPanel({ progress, projectId, token, tree, queue, confirm }) {
  const [report, setReport] = useState(null);
  const [recycle, setRecycle] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(true);
  useEffect(() => {
    if (!projectId) return;
    api(`/api/projects/${projectId}/export-check?pending=${queue.length}`).then(setReport).catch(() => setReport(null));
    api(`/api/projects/${projectId}/recycle-bin`).then(setRecycle).catch(() => setRecycle(null));
  }, [projectId, queue.length]);
  if (!projectId) return <EmptyState title="请选择项目" text="选择项目后导出成果。" />;
  const exportUrl = apiUrl(`/api/projects/${projectId}/export?token=${encodeURIComponent(token)}`);
  return <div className="view-stack"><div className="section-head"><div><h2>成果导出</h2><p className="hint">导出前先核对缺拍、未同步、回收站、现场补录和质量异常。</p></div><a className="button-link" href={exportUrl}>下载项目 ZIP</a></div><div className="download-card"><h3>{tree?.name || progress?.project?.name || '当前项目'}</h3><SummaryStats progress={progress} queue={queue} />{report && <div className="check-grid"><div><strong>{report.missingDevices.length}</strong><span>缺拍设备</span></div><div><strong>{report.qualityWarnings.length}</strong><span>质量提醒</span></div><div><strong>{queue.length}</strong><span>未同步</span></div><div><strong>{report.recycleCount ?? recycle?.photos?.length ?? 0}</strong><span>回收站</span></div><div><strong>{(report.temporaryTaskPoints?.length || 0) + (report.temporaryDevices?.length || 0)}</strong><span>现场补录</span></div><div><strong>{(report.pendingTemporaryTaskPoints?.length || 0) + (report.pendingTemporaryDevices?.length || 0)}</strong><span>待确认补录</span></div></div>}</div><section><div className="section-head"><h3>导出清单预览</h3><button type="button" className="ghost" onClick={() => setPreviewOpen(!previewOpen)}>{previewOpen ? '收起' : '展开'}</button></div>{previewOpen && report && <div className="preview-sections"><PreviewList title="缺拍设备" items={report.missingDevices} render={(item) => `${item.taskPointName}/${item.devicePositionName} 缺：${item.missingRequired.join('、')}`} /><PreviewList title="现场补录任务点" items={report.temporaryTaskPoints} render={(item) => `${item.name} · ${item.reviewStatus === 'approved' ? '已确认' : '待确认'}`} /><PreviewList title="现场补录设备位" items={report.temporaryDevices} render={(item) => `${item.taskPointName}/${item.name} · ${item.deviceType} · ${item.reviewStatus === 'approved' ? '已确认' : '待确认'}`} /><PreviewList title="质量异常照片" items={report.qualityWarnings} render={(item) => `${item.taskPointName}/${item.devicePositionName} ${displayPhotoType(item.photoType)}：${item.qualityWarnings.join('、')}`} /><PreviewList title="GPS 缺失照片" items={report.noGps} render={(item) => `${item.taskPointName}/${item.devicePositionName} ${displayPhotoType(item.photoType)}`} /><PreviewList title="本地未同步" items={queue} render={(item) => `${item.metadata?.taskPointName}/${item.metadata?.devicePositionName} ${displayPhotoType(item.metadata?.photoType)} ${item.status === 'failed' ? `失败：${item.lastError}` : ''}`} /></div>}</section><section><h3>按任务点导出</h3><div className="download-list">{(tree?.tasks || []).map((task) => <a key={task.id} className="ghost-link" href={apiUrl(`/api/projects/${projectId}/tasks/${task.id}/export?token=${encodeURIComponent(token)}`)}>{task.name} ZIP</a>)}</div></section><RecycleBin projectId={projectId} recycle={recycle} reload={() => api(`/api/projects/${projectId}/recycle-bin`).then(setRecycle)} confirm={confirm} /></div>;
}

function PreviewList({ title, items, render }) {
  return <div className="preview-list"><h4>{title} · {items?.length || 0}</h4>{!items?.length ? <p className="hint">无</p> : <ul>{items.slice(0, 20).map((item, index) => <li key={index}>{render(item)}</li>)}</ul>}{items?.length > 20 && <p className="hint">仅显示前 20 条，完整内容会写入导出清单。</p>}</div>;
}

function RecycleBin({ projectId, recycle, reload, confirm }) {
  const [previewPhoto, setPreviewPhoto] = useState(null);
  async function restore(photo) {
    await api(`/api/projects/${projectId}/photos/${photo.id}/restore`, { method: 'POST' });
    await reload();
  }
  async function remove(photo) {
    const ok = await confirm({
      title: '彻底删除照片',
      message: '此操作不可恢复，请确认不再需要这张照片。',
      details: [`文件：${photo.fileName}`, `删除时间：${new Date(photo.deletedAt).toLocaleString()}`],
      confirmText: '彻底删除',
      danger: true
    });
    if (!ok) return;
    await api(`/api/projects/${projectId}/photos/${photo.id}/permanent`, { method: 'DELETE' });
    await reload();
  }
  return <section><h3>回收站</h3><p className="hint">照片保留 {recycle?.retentionDays || 30} 天，可恢复或彻底删除。</p>{!recycle?.photos?.length ? <p className="hint">回收站为空。</p> : <div className="photo-grid compact">{recycle.photos.map((photo) => <div key={photo.id} className="photo-card"><button type="button" className="image-button" onClick={() => setPreviewPhoto(photo)}><img src={uploadUrl(photo.watermarkedPath)} alt={photo.fileName} /></button><strong>{displayPhotoType(photo.photoType)}</strong><small>{photo.fileName}</small><small>删除时间：{new Date(photo.deletedAt).toLocaleString()}</small><div className="photo-path-actions"><button type="button" className="ghost tiny" onClick={() => setPreviewPhoto({ ...photo, previewMode: 'watermarked' })}>水印图</button><button type="button" className="ghost tiny" onClick={() => setPreviewPhoto({ ...photo, previewMode: 'original' })}>原图</button></div><button type="button" onClick={() => restore(photo)}>恢复</button><button type="button" className="ghost danger" onClick={() => remove(photo)}>彻底删除</button></div>)}</div>}{previewPhoto && <PhotoPreviewModal photo={previewPhoto} onClose={() => setPreviewPhoto(null)} />}</section>;
}

function AccountPanel({ session, isSuperAdmin, confirm }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ username: '', password: '', displayName: '', role: 'collector' });
  const [keyword, setKeyword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const roleOptions = isSuperAdmin ? [['super_admin', '完全管理员'], ['project_admin', '项目管理员'], ['collector', '采集员']] : [['collector', '采集员']];
  const filteredUsers = users.filter((user) => `${user.displayName} ${user.username} ${ROLE_LABELS[user.role] || user.role}`.toLowerCase().includes(keyword.trim().toLowerCase()));
  async function loadUsers() { const data = await api('/api/users'); setUsers(data.users); }
  useEffect(() => { loadUsers().catch((err) => setError(err.message)); }, []);
  async function createUser(event) {
    event.preventDefault();
    setMessage('');
    setError('');
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify(form) });
      setMessage(`已创建账号：${form.username}`);
      setForm({ username: '', password: '', displayName: '', role: 'collector' });
      await loadUsers();
    } catch (err) {
      setError(err.message);
    }
  }
  async function deleteUser(user) {
    const ok = await confirm({
      title: '删除账号',
      message: '删除后该账号不能再登录，历史项目和照片记录会保留。',
      details: [`账号：${user.username}`, `姓名：${user.displayName}`, `角色：${ROLE_LABELS[user.role] || user.role}`],
      confirmText: '删除账号',
      danger: true
    });
    if (!ok) return;
    setMessage('');
    setError('');
    try {
      await api(`/api/users/${user.id}`, { method: 'DELETE' });
      setMessage(`已删除账号：${user.username}`);
      await loadUsers();
    } catch (err) {
      setError(err.message);
    }
  }
  function canDeleteUser(user) {
    if (user.deletedAt || user.id === session.user.id) return false;
    if (isSuperAdmin) return true;
    return user.role === 'collector';
  }
  return (
    <div className="view-stack">
      <div className="section-head">
        <div>
          <h2>账号管理</h2>
          <p className="hint">{isSuperAdmin ? '完全管理员可创建和删除三类账号。' : '项目管理员只能创建和删除采集员账号。'}</p>
        </div>
      </div>
      <form className="panel-subform" onSubmit={createUser}>
        <h3>创建账号</h3>
        <div className="field-grid">
          <label>用户名<input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></label>
          <label>显示名称<input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label>
          <label>密码<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
          <label>角色<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>{roleOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        <button type="submit">创建账号</button>
        {message && <p className="hint">{message}</p>}
        {error && <p className="error">{error}</p>}
      </form>
      <section>
        <div className="section-head">
          <h3>账号列表</h3>
          <SearchBox placeholder="搜索账号、姓名或角色" value={keyword} onChange={setKeyword} />
        </div>
        <div className="user-list">
          {filteredUsers.map((user) => (
            <div key={user.id} className={user.deletedAt ? 'user-row disabled' : 'user-row'}>
              <div>
                <strong>{user.displayName}</strong>
                <small>{user.username}</small>
              </div>
              <span>{ROLE_LABELS[user.role] || user.role}</span>
              <span>{user.deletedAt ? `已删除：${new Date(user.deletedAt).toLocaleString()}` : `创建：${new Date(user.createdAt).toLocaleDateString()}`}</span>
              <button type="button" className="ghost danger" disabled={!canDeleteUser(user)} onClick={() => deleteUser(user)}>{user.deletedAt ? '已删除' : user.id === session.user.id ? '当前账号' : '删除'}</button>
            </div>
          ))}
        </div>
        {filteredUsers.length === 0 && <EmptyState title="没有匹配账号" text="调整搜索条件后再查看。" />}
      </section>
    </div>
  );
}

function DiagnosticsPanel({ queue, token }) {
  const [diagnostics, setDiagnostics] = useState(null);
  const [version, setVersion] = useState(null);
  const [error, setError] = useState('');
  async function loadDiagnostics() {
    setError('');
    try {
      const [diagnosticData, versionData] = await Promise.all([
        api('/api/diagnostics'),
        api('/api/admin/version').catch(() => null)
      ]);
      setDiagnostics(diagnosticData);
      setVersion(versionData);
    } catch (err) {
      setError(err.message || '诊断失败');
      setDiagnostics(null);
    }
  }
  useEffect(() => { loadDiagnostics(); }, []);
  const failed = queue.filter((item) => item.status === 'failed').length;
  const apk = version?.apk || diagnostics?.apk;
  return (
    <div className="view-stack">
      <div className="section-head">
        <div>
          <h2>连接诊断</h2>
          <p className="hint">用于检查手机、网页端和后端之间的连接状态。</p>
        </div>
        <button type="button" className="ghost" onClick={loadDiagnostics}>重新检查</button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="check-grid">
        <div><strong>{diagnostics?.status || '未知'}</strong><span>后端连通</span></div>
        <div><strong>{diagnostics?.user ? '已登录' : '未确认'}</strong><span>登录状态</span></div>
        <div><strong>{navigator.onLine ? '在线' : '离线'}</strong><span>浏览器网络</span></div>
        <div><strong>{queue.length}</strong><span>本地队列</span></div>
        <div><strong>{failed}</strong><span>同步失败</span></div>
        <div><strong>{diagnostics?.uploadWritable ? '可写' : '未知'}</strong><span>上传目录</span></div>
      </div>
      <section className="download-card">
        <h3>服务器地址</h3>
        <p>当前前端 API：{getApiBaseUrl() || '同源访问'}</p>
        <p>公网地址：{diagnostics?.publicBaseUrl || '未配置'}</p>
        <p>App 推荐填写：{diagnostics?.suggestedAppUrl || '未检测到'}</p>
        <p>局域网后端：{diagnostics?.lanUrls?.join('，') || '未检测到'}</p>
        <p>数据目录：{diagnostics?.dataDir || '未检测到'}</p>
        <p>上传目录：{diagnostics?.uploadDir || '未检测到'}</p>
      </section>
      <section className="download-card">
        <h3>版本与更新</h3>
        <p>版本：{version?.version || diagnostics?.version || '未知'}</p>
        <p>构建时间：{version?.buildTime || diagnostics?.buildTime || '未知'}</p>
        <p>运行模式：{version?.mode || 'development'}</p>
        <p>APK：{apk?.available ? `${apk.fileName} · ${formatBytes(apk.size)} · ${new Date(apk.updatedAt).toLocaleString()}` : '当前电脑尚未生成 APK'}</p>
        {apk?.available && <a className="button-link" href={apiUrl(`/api/app/apk?token=${encodeURIComponent(token)}`)}>下载当前 APK</a>}
      </section>
    </div>
  );
}

function HealthPanel({ queue, token, confirm }) {
  const [health, setHealth] = useState(null);
  const [version, setVersion] = useState(null);
  const [backups, setBackups] = useState([]);
  const [backupFile, setBackupFile] = useState(null);
  const [restorePhrase, setRestorePhrase] = useState('');
  const [restoreMessage, setRestoreMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function loadHealth() {
    try {
      const [healthData, versionData, backupData] = await Promise.all([
        api('/api/admin/health'),
        api('/api/admin/version'),
        api('/api/admin/backups')
      ]);
      setHealth(healthData);
      setVersion(versionData);
      setBackups(backupData.backups || []);
    } catch (err) {
      setHealth({ status: 'error', error: err.message });
    }
  }
  useEffect(() => { loadHealth(); }, []);
  async function restoreBackup(event) {
    event.preventDefault();
    if (!backupFile) return;
    if (restorePhrase.trim() !== '确认恢复') {
      setRestoreMessage('请输入“确认恢复”后再执行恢复。');
      return;
    }
    const ok = await confirm({
      title: '从备份恢复',
      message: '恢复会覆盖当前数据库和照片目录，系统会先生成当前安全备份。',
      details: [`备份文件：${backupFile.name}`, `文件大小：${formatBytes(backupFile.size)}`, '恢复完成后需要重启后端服务'],
      confirmText: '确认恢复',
      danger: true
    });
    if (!ok) return;
    setBusy(true);
    setRestoreMessage('正在上传并恢复备份...');
    try {
      const form = new FormData();
      form.append('backup', backupFile);
      const result = await api('/api/admin/restore-backup', { method: 'POST', body: form });
      setRestoreMessage(`恢复文件已写入。${result.message || '请重启后端服务使备份生效。'} 安全备份：${result.safetyBackup || '已生成'}`);
    } catch (err) {
      setRestoreMessage(`恢复失败：${err.message}`);
    } finally {
      setBusy(false);
    }
  }
  return <div className="view-stack"><div className="section-head"><div><h2>运行健康</h2><p className="hint">检查后端、数据库、上传目录、磁盘和云端访问地址。</p></div><a className="button-link" href={apiUrl(`/api/admin/backup?token=${encodeURIComponent(token)}`)}>一键备份</a></div>{health && <div className="check-grid"><div><strong>{health.status}</strong><span>后端状态</span></div><div><strong>{health.database ? '正常' : '异常'}</strong><span>数据库</span></div><div><strong>{health.uploadWritable ? '可写' : '不可写'}</strong><span>上传目录</span></div><div><strong>{queue.length}</strong><span>本机待同步</span></div></div>}<section className="download-card"><h3>部署信息</h3><p>版本：{version?.version || '未知'} · 构建时间：{version?.buildTime || '未知'}</p><p>公网地址：{health?.publicBaseUrl || '未配置'}</p><p>App 推荐填写：{health?.suggestedAppUrl || '未检测到'}</p><p>数据目录：{health?.dataDir}</p><p>上传目录：{health?.uploadDir}</p><p>备份目录：{health?.backupDir}</p><p>局域网地址：{health?.lanUrls?.join('，') || '未检测到'}</p><p>磁盘可用：{health?.disk ? `${Math.round(health.disk.availableBytes / 1024 / 1024 / 1024)} GB` : '未检测到'}</p>{version?.apk?.available && <a className="button-link" href={apiUrl(`/api/app/apk?token=${encodeURIComponent(token)}`)}>下载当前 APK</a>}</section><section className="download-card"><div className="section-head"><h3>最近备份</h3><button type="button" className="ghost" onClick={loadHealth}>刷新</button></div>{backups.length === 0 ? <p className="hint">暂无备份文件。</p> : <div className="backup-list">{backups.map((backup) => <div key={backup.fileName} className="backup-row"><strong>{backup.fileName}</strong><span>{formatBytes(backup.size)}</span><span>{new Date(backup.createdAt).toLocaleString()}</span></div>)}</div>}</section><form className="panel-subform" onSubmit={restoreBackup}><h3>从备份恢复</h3><p className="hint">支持本系统一键备份生成的 ZIP。恢复前会自动生成当前安全备份，恢复后请重启后端服务。执行前请输入“确认恢复”。</p><input type="file" accept=".zip,.sqlite,.db" onChange={(event) => setBackupFile(event.target.files?.[0] || null)} /><input placeholder="输入：确认恢复" value={restorePhrase} onChange={(event) => setRestorePhrase(event.target.value)} /><button type="submit" disabled={!backupFile || busy || restorePhrase.trim() !== '确认恢复'}>上传并恢复</button>{restoreMessage && <p className="hint">{restoreMessage}</p>}</form></div>;
}

function EmptyState({ title, text }) {
  return <div className="empty-state"><h2>{title}</h2><p>{text}</p></div>;
}

createRoot(document.getElementById('root')).render(<App />);
