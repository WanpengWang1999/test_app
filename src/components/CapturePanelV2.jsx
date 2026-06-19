import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, assetUrl } from '../services/api.js';
import { addQueuedPhoto } from '../services/localDb.js';
import { isNativeApp, readNativeOriginal, saveNativeOriginal, takeNativePhoto } from '../services/nativeApp.js';
import { analyzeImage, getGps } from '../services/photo.js';
import { displayPhotoType, nextRequiredPhotoTypeForDevice, normalizedDeviceType, photoTypeValue, requiredPhotoTypesForDevice } from '../services/photoTypes.js';
import { useConfirmDialog } from './ConfirmDialog.jsx';

function createClientId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `photo-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function uploadUrl(storedPath) {
  const cleanPath = String(storedPath || '').replace(/\\/g, '/').replace(/^uploads\//, '');
  return assetUrl(encodeURI(`/uploads/${cleanPath}`));
}

function blobUrl(blob) {
  return blob ? URL.createObjectURL(blob) : '';
}

function statusClass({ missingCount, localPending, failed }) {
  if (failed > 0) return 'status-failed';
  if (localPending > 0) return 'status-pending';
  if (missingCount === 0) return 'status-done';
  return 'status-missing';
}

function priorityScore({ missingCount, localPending, failed, reviewStatus }) {
  if (failed > 0) return 0;
  if (localPending > 0) return 1;
  if (reviewStatus && reviewStatus !== 'approved') return 2;
  if (missingCount > 0) return 3;
  return 4;
}

function reviewLabel(status) {
  return status === 'approved' ? '已确认' : '待确认';
}

function SearchInput({ value, onChange, placeholder }) {
  return (
    <div className="search-input">
      <input placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
      {value && <button type="button" className="search-clear" onClick={() => onChange('')}>清空</button>}
    </div>
  );
}

const RETAKE_REASONS = ['模糊', '过暗', '设备不完整', '拍错点位', '其他'];

export default function CapturePanelV2({
  tree,
  session,
  projectId,
  photos,
  queue,
  reload,
  onQueued,
  onPageChange,
  onExitProject,
  backSignal
}) {
  const userId = session?.user?.id || 'anonymous';
  const stateKey = projectId ? `capture-state:${userId}:${projectId}` : '';
  const savedState = useMemo(() => {
    if (!stateKey) return {};
    try {
      return JSON.parse(localStorage.getItem(stateKey) || '{}');
    } catch {
      return {};
    }
  }, [stateKey]);

  const [taskPointId, setTaskPointId] = useState(savedState.taskPointId || '');
  const [devicePositionId, setDevicePositionId] = useState(savedState.devicePositionId || '');
  const [photoType, setPhotoType] = useState(photoTypeValue(savedState.photoType || ''));
  const [taskFilters, setTaskFilters] = useState(savedState.taskFilters || { keyword: '', onlyMissing: false });
  const [deviceFilters, setDeviceFilters] = useState(savedState.deviceFilters || { keyword: '', onlyMissing: true });
  const [showTempTaskForm, setShowTempTaskForm] = useState(false);
  const [showTempDeviceForm, setShowTempDeviceForm] = useState(false);
  const [tempTaskName, setTempTaskName] = useState('');
  const [tempDevice, setTempDevice] = useState({ name: '', code: '', deviceType: '通用' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState(null);
  const [previewPhoto, setPreviewPhoto] = useState(null);
  const [photosOpen, setPhotosOpen] = useState(false);
  const confirmRef = useRef(null);
  const captureTopRef = useRef(null);
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

  const task = useMemo(() => tree?.tasks.find((item) => String(item.id) === String(taskPointId)), [tree, taskPointId]);
  const selectedDevice = useMemo(() => task?.devices.find((item) => String(item.id) === String(devicePositionId)), [task, devicePositionId]);
  const selectedDeviceType = normalizedDeviceType(selectedDevice?.deviceType);
  const photoTypes = useMemo(() => {
    const all = tree?.photoTypes || [];
    const exact = all.filter((type) => normalizedDeviceType(type.deviceType) === selectedDeviceType);
    return exact.length ? exact : all.filter((type) => normalizedDeviceType(type.deviceType) === '通用');
  }, [tree, selectedDeviceType]);

  const selectedDevicePhotos = sortPhotos(photos.filter((photo) => String(photo.devicePositionId) === String(selectedDevice?.id)));
  const selectedLocalPhotos = queue.filter((item) => String(item.metadata?.devicePositionId) === String(selectedDevice?.id));
  const taskLocalQueue = queue.filter((item) => String(item.metadata?.taskPointId) === String(task?.id));
  const taskPhotos = photos.filter((photo) => String(photo.taskPointId) === String(task?.id));
  const canReviewTemporary = session?.user.role !== 'collector';
  const deviceTypeOptions = useMemo(() => [...new Set([
    ...(tree?.tasks || []).flatMap((item) => item.devices.map((device) => normalizedDeviceType(device.deviceType))),
    ...(tree?.photoTypes || []).map((type) => normalizedDeviceType(type.deviceType)),
    'RRU',
    'BBU',
    '天线',
    '通用'
  ])].filter(Boolean), [tree]);

  const similarDevices = useMemo(() => {
    const word = tempDevice.name.trim().toLowerCase();
    if (!word || !task) return [];
    return task.devices.filter((device) => {
      const name = device.name.toLowerCase();
      return name.includes(word) || word.includes(name);
    }).slice(0, 4);
  }, [task, tempDevice.name]);

  const requiredTypes = photoTypes.filter((type) => type.required).map((type) => type.name);
  const capturedTypes = new Set([
    ...selectedDevicePhotos.map((photo) => photo.photoType),
    ...selectedLocalPhotos.map((item) => item.metadata?.photoType)
  ]);
  const missingTypes = requiredTypes.filter((type) => !capturedTypes.has(type));

  function firstPhotoTypeForDevice(device = selectedDevice) {
    return nextRequiredPhotoTypeForDevice({ device, photoTypes: tree?.photoTypes || [], photos, queue });
  }

  function requiredForDevice(device) {
    return requiredPhotoTypesForDevice(device, tree?.photoTypes || []);
  }

  function deviceMissingTypes(device) {
    const remote = photos.filter((photo) => String(photo.devicePositionId) === String(device.id)).map((photo) => photo.photoType);
    const local = queue.filter((item) => String(item.metadata?.devicePositionId) === String(device.id)).map((item) => item.metadata?.photoType);
    return requiredForDevice(device).filter((type) => !remote.includes(type) && !local.includes(type));
  }

  function devicePhotoCounts(device) {
    const synced = photos.filter((photo) => String(photo.devicePositionId) === String(device.id)).length;
    const localPending = queue.filter((item) => String(item.metadata?.devicePositionId) === String(device.id)).length;
    const failed = queue.filter((item) => String(item.metadata?.devicePositionId) === String(device.id) && item.status === 'failed').length;
    return { synced, localPending, failed };
  }

  function taskSummary(nextTask) {
    const total = nextTask.devices.length;
    const completed = nextTask.devices.filter((device) => deviceMissingTypes(device).length === 0).length;
    const localPending = queue.filter((item) => String(item.metadata?.taskPointId) === String(nextTask.id)).length;
    const failed = queue.filter((item) => String(item.metadata?.taskPointId) === String(nextTask.id) && item.status === 'failed').length;
    const synced = photos.filter((photo) => String(photo.taskPointId) === String(nextTask.id)).length;
    return { total, completed, localPending, failed, synced };
  }

  const filteredTasks = (tree?.tasks || []).filter((item) => {
    const keyword = taskFilters.keyword.trim().toLowerCase();
    const text = [item.name, ...item.devices.flatMap((device) => [device.name, device.code || '', device.deviceType || ''])].join(' ').toLowerCase();
    const summary = taskSummary(item);
    return (!keyword || text.includes(keyword)) && (!taskFilters.onlyMissing || summary.completed < summary.total);
  }).sort((a, b) => {
    const aSummary = taskSummary(a);
    const bSummary = taskSummary(b);
    return priorityScore({ missingCount: aSummary.total - aSummary.completed, localPending: aSummary.localPending, failed: aSummary.failed, reviewStatus: a.reviewStatus }) -
      priorityScore({ missingCount: bSummary.total - bSummary.completed, localPending: bSummary.localPending, failed: bSummary.failed, reviewStatus: b.reviewStatus });
  });

  const filteredDevices = (task?.devices || []).filter((device) => {
    const keyword = deviceFilters.keyword.trim().toLowerCase();
    const text = `${device.name} ${device.code || ''} ${device.deviceType} ${deviceMissingTypes(device).map(displayPhotoType).join(' ')}`.toLowerCase();
    const isMissing = deviceMissingTypes(device).length > 0;
    return (!keyword || text.includes(keyword)) && (!deviceFilters.onlyMissing || isMissing);
  }).sort((a, b) => {
    const aMissing = deviceMissingTypes(a).length;
    const bMissing = deviceMissingTypes(b).length;
    const aCounts = devicePhotoCounts(a);
    const bCounts = devicePhotoCounts(b);
    return priorityScore({ missingCount: aMissing, localPending: aCounts.localPending, failed: aCounts.failed, reviewStatus: a.reviewStatus }) -
      priorityScore({ missingCount: bMissing, localPending: bCounts.localPending, failed: bCounts.failed, reviewStatus: b.reviewStatus });
  });

  useEffect(() => {
    if (!stateKey) return;
    localStorage.setItem(stateKey, JSON.stringify({ taskPointId, devicePositionId, photoType, taskFilters, deviceFilters }));
  }, [stateKey, taskPointId, devicePositionId, photoType, taskFilters, deviceFilters]);

  useEffect(() => {
    if (!tree?.tasks.some((item) => String(item.id) === String(taskPointId))) {
      setTaskPointId('');
      setDevicePositionId('');
      setDraft(null);
      setMessage('');
    }
  }, [tree?.id]);

  useEffect(() => {
    if (!selectedDevice) return;
    if (!photoType) setPhotoType(firstPhotoTypeForDevice(selectedDevice));
    if (photoType !== 'extra' && photoTypes.length > 0 && !photoTypes.some((type) => type.name === photoType)) setPhotoType(firstPhotoTypeForDevice(selectedDevice));
  }, [selectedDevice?.id, photoTypes, photoType]);

  useEffect(() => {
    if (!draft) return;
    requestAnimationFrame(() => {
      confirmRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [draft]);

  useEffect(() => {
    if (!tree) return onPageChange?.('projectList');
    if (selectedDevice) return onPageChange?.('deviceCapture');
    if (task) return onPageChange?.('deviceList');
    return onPageChange?.('taskList');
  }, [tree, task?.id, selectedDevice?.id]);

  useEffect(() => {
    if (!backSignal) return;
    handleBack();
  }, [backSignal]);

  function handleBack() {
    if (previewPhoto) return setPreviewPhoto(null);
    if (draft) return setDraft(null);
    if (selectedDevice) return leaveDevice();
    if (task) return leaveTask();
    onExitProject?.();
  }

  function enterTask(nextTask) {
    setTaskPointId(String(nextTask.id));
    setDevicePositionId('');
    setPhotoType('');
    setDraft(null);
    setMessage('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function leaveTask() {
    setTaskPointId('');
    setDevicePositionId('');
    setPhotoType('');
    setDraft(null);
    setMessage('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function enterDevice(device) {
    setDevicePositionId(String(device.id));
    setPhotoType(firstPhotoTypeForDevice(device));
    setDraft(null);
    setMessage('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function leaveDevice() {
    setDevicePositionId('');
    setPhotoType('');
    setDraft(null);
    setMessage('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function selectNextPhotoType() {
    const allTypes = [...photoTypes.map((type) => type.name), 'extra'];
    const index = allTypes.indexOf(photoType);
    setPhotoType(index < 0 ? allTypes[0] : allTypes[Math.min(index + 1, allTypes.length - 1)]);
  }

  async function createTemporaryTask(event) {
    event.preventDefault();
    const name = tempTaskName.trim();
    if (!name || !projectId) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await api(`/api/projects/${projectId}/task-points`, {
        method: 'POST',
        body: JSON.stringify({ name })
      });
      setTempTaskName('');
      setShowTempTaskForm(false);
      setTaskPointId(String(result.taskPoint.id));
      setDevicePositionId('');
      setPhotoType('');
      setMessage(`已新增临时任务点：${result.taskPoint.name}`);
      await reload();
    } catch (err) {
      setMessage(`新增任务点失败：${err.message || err}`);
    } finally {
      setBusy(false);
    }
  }

  async function createTemporaryDevice(event) {
    event.preventDefault();
    if (!task || !projectId) return;
    const name = tempDevice.name.trim();
    const code = tempDevice.code.trim();
    const deviceType = (tempDevice.deviceType || '通用').trim() || '通用';
    if (!name) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await api(`/api/projects/${projectId}/task-points/${task.id}/devices`, {
        method: 'POST',
        body: JSON.stringify({ name, code, deviceType })
      });
      setTempDevice({ name: '', code: '', deviceType: '通用' });
      setShowTempDeviceForm(false);
      setDevicePositionId(String(result.device.id));
      setPhotoType(firstPhotoTypeForDevice(result.device));
      setMessage(`已新增临时设备位：${result.device.name}`);
      await reload();
    } catch (err) {
      setMessage(`新增设备位失败：${err.message || err}`);
    } finally {
      setBusy(false);
    }
  }

  async function approveTemporaryTask(nextTask) {
    await api(`/api/projects/${projectId}/task-points/${nextTask.id}/approve`, { method: 'POST' });
    setMessage(`已确认现场补录任务点：${nextTask.name}`);
    await reload();
  }

  async function approveTemporaryDevice(device) {
    await api(`/api/projects/${projectId}/devices/${device.id}/approve`, { method: 'POST' });
    setMessage(`已确认现场补录设备位：${device.name}`);
    await reload();
  }

  async function preparePhotoFile(file, originalName = file?.name || 'photo.jpg', previewUrl = '') {
    if (!tree || !task || !selectedDevice || !photoType || !file) return;
    setBusy(true);
    setMessage('正在保存原图和采集信息...');
    try {
      const capturedAt = new Date().toISOString();
      const clientId = createClientId();
      const nativeFile = isNativeApp() ? await saveNativeOriginal(file, clientId, originalName) : null;
      const [gps, qualityWarnings] = await Promise.all([getGps(), analyzeImage(file)]);
      setDraft({
        file,
        originalName,
        originalFilePath: nativeFile?.originalFilePath || '',
        originalFileUri: nativeFile?.originalFileUri || '',
        originalMimeType: file.type || 'image/jpeg',
        originalSize: file.size || nativeFile?.originalSize || 0,
        previewUrl: previewUrl || blobUrl(file),
        metadata: {
          clientId,
          projectId: tree.id,
          taskPointId: task.id,
          taskPointName: task.name,
          devicePositionId: selectedDevice.id,
          devicePositionName: selectedDevice.name,
          deviceType: selectedDevice.deviceType,
          projectName: tree.name,
          photoType,
          capturedAt,
          capturedBy: session.user.displayName,
          gps,
          qualityWarnings
        }
      });
      setMessage(isNativeApp() ? '原图已保存到 App 私有目录，请确认后加入同步队列。' : '照片已处理完成，请确认后加入同步队列。');
    } catch (err) {
      setDraft(null);
      setMessage(`照片保存失败：${err.message || err}`);
    } finally {
      setBusy(false);
    }
  }

  async function prepareFiles(files) {
    const selectedFiles = Array.from(files || []);
    if (selectedFiles.length === 0) return;
    await preparePhotoFile(selectedFiles[0]);
  }

  async function takePhotoWithNativeCamera() {
    if (!tree || !task || !selectedDevice || !photoType) return;
    try {
      const photo = await takeNativePhoto();
      await preparePhotoFile(photo.blob, photo.originalName, photo.previewUrl);
    } catch (err) {
      if (/cancel/i.test(String(err?.message || err))) return;
      setMessage(`拍照失败：${err.message || err}`);
    }
  }

  async function confirmDraft() {
    if (!draft) return;
    await addQueuedPhoto({
      metadata: draft.metadata,
      originalBlob: draft.originalFilePath ? null : draft.file,
      originalFilePath: draft.originalFilePath,
      originalFileUri: draft.originalFileUri,
      originalMimeType: draft.originalMimeType,
      originalSize: draft.originalSize,
      originalName: draft.originalName,
      watermarkedName: 'watermarked.jpg'
    });
    setDraft(null);
    setMessage('照片已加入同步队列，并自动切换到下一类型。');
    selectNextPhotoType();
    await onQueued();
  }

  function beginRetake(photo) {
    setPhotoType(photoTypeValue(photo.photoType) || firstPhotoTypeForDevice());
    setPhotosOpen(false);
    setPreviewPhoto(null);
    setMessage(`已删除原照片，请重新拍摄：${displayPhotoType(photo.photoType)}`);
    requestAnimationFrame(() => captureTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  if (!tree) return <EmptyState title="请选择项目" text="从项目首页选择项目后进入任务点采集。" />;

  if (!task) {
    return (
      <div className="view-stack capture-screen">
        <PageHeader title="选择任务点" subtitle={`${tree.name} · 进入任务点后再选择设备位`} onBack={onExitProject} backText="返回项目" />
        <Breadcrumb items={[{ label: tree.name, onClick: onExitProject }, { label: '任务点' }]} />
        <section className="quick-add-box">
          {!showTempTaskForm ? (
            <button type="button" className="ghost quick-add-toggle" onClick={() => setShowTempTaskForm(true)}>+ 临时新增任务点</button>
          ) : (
            <form className="panel-subform temporary-form compact-panel" onSubmit={createTemporaryTask}>
              <div className="section-head compact-section-head">
                <h3>临时新增任务点</h3>
                <button type="button" className="ghost" onClick={() => setShowTempTaskForm(false)}>收起</button>
              </div>
              <div className="inline-form">
                <input placeholder="任务点名称" value={tempTaskName} onChange={(event) => setTempTaskName(event.target.value)} />
                <button type="submit" disabled={busy || !tempTaskName.trim()}>新增</button>
              </div>
            </form>
          )}
          {message && <p className="hint">{message}</p>}
        </section>
        <div className="filter-row compact-filter">
          <SearchInput placeholder="搜索任务点、设备位、编号或设备类型" value={taskFilters.keyword} onChange={(keyword) => setTaskFilters({ ...taskFilters, keyword })} />
          <label className="checkbox"><input type="checkbox" checked={taskFilters.onlyMissing} onChange={(event) => setTaskFilters({ ...taskFilters, onlyMissing: event.target.checked })} />只看未完成</label>
        </div>
        <p className="hint">显示 {filteredTasks.length}/{tree.tasks.length} 个任务点</p>
        <div className="compact-list">
          {filteredTasks.map((item) => {
            const summary = taskSummary(item);
            const missing = summary.total - summary.completed;
            return (
              <article key={item.id} role="button" tabIndex={0} className={`compact-list-item ${statusClass({ missingCount: missing, localPending: summary.localPending, failed: summary.failed })}`} onClick={() => enterTask(item)} onKeyDown={(event) => { if (event.key === 'Enter') enterTask(item); }}>
                <span className="item-main">
                  <strong>{item.name}</strong>
                  <small>{item.isTemporary ? `现场补录 · ${reviewLabel(item.reviewStatus)}` : 'Excel 原始任务点'}</small>
                </span>
                <span className="item-meta">
                  <strong>{summary.completed}/{summary.total}</strong>
                  <small>同步 {summary.synced} · 待传 {summary.localPending} · 失败 {summary.failed}</small>
                </span>
                {canReviewTemporary && item.isTemporary && item.reviewStatus !== 'approved' && <span className="inline-actions"><button type="button" className="ghost compact-action" onClick={(event) => { event.stopPropagation(); approveTemporaryTask(item); }}>确认补录</button></span>}
              </article>
            );
          })}
        </div>
        {filteredTasks.length === 0 && <EmptyState title="没有匹配的任务点" text="调整搜索条件后再查看。" />}
        {confirmDialog}
      </div>
    );
  }

  if (!selectedDevice) {
    return (
      <div className="view-stack capture-screen">
        <PageHeader title={task.name} subtitle={`已同步 ${taskPhotos.length} 张 · 本地待同步 ${taskLocalQueue.length} 张`} onBack={leaveTask} backText="返回任务点" />
        <Breadcrumb items={[{ label: tree.name, onClick: leaveTask }, { label: task.name }, { label: '设备位' }]} />
        <section className="quick-add-box">
          {!showTempDeviceForm ? (
            <button type="button" className="ghost quick-add-toggle" onClick={() => setShowTempDeviceForm(true)}>+ 临时新增设备位</button>
          ) : (
            <form className="panel-subform temporary-form compact-panel" onSubmit={createTemporaryDevice}>
              <div className="section-head compact-section-head">
                <h3>临时新增设备位</h3>
                <button type="button" className="ghost" onClick={() => setShowTempDeviceForm(false)}>收起</button>
              </div>
              <div className="field-grid">
                <label>设备位名称<input placeholder="例如：9号楼RRU" value={tempDevice.name} onChange={(event) => setTempDevice({ ...tempDevice, name: event.target.value })} /></label>
                <label>设备编号<input placeholder="可选" value={tempDevice.code} onChange={(event) => setTempDevice({ ...tempDevice, code: event.target.value })} /></label>
                <label>设备类型<input placeholder="例如：RRU、BBU、天线、通用" value={tempDevice.deviceType} onChange={(event) => setTempDevice({ ...tempDevice, deviceType: event.target.value })} /></label>
              </div>
              <div className="quick-type-row">
                {deviceTypeOptions.map((type) => <button key={type} type="button" className={tempDevice.deviceType === type ? 'chip active-chip' : 'chip'} onClick={() => setTempDevice({ ...tempDevice, deviceType: type })}>{type}</button>)}
              </div>
              {similarDevices.length > 0 && <div className="warning-list">{similarDevices.map((device) => <span key={device.id}>可能重复：{device.name} · {device.deviceType}</span>)}</div>}
              <button type="submit" disabled={busy || !tempDevice.name.trim()}>新增并进入拍照</button>
            </form>
          )}
          {message && <p className="hint">{message}</p>}
        </section>
        <div className="filter-row compact-filter">
          <SearchInput placeholder="搜索设备位、编号、类型或缺失项" value={deviceFilters.keyword} onChange={(keyword) => setDeviceFilters({ ...deviceFilters, keyword })} />
          <label className="checkbox"><input type="checkbox" checked={deviceFilters.onlyMissing} onChange={(event) => setDeviceFilters({ ...deviceFilters, onlyMissing: event.target.checked })} />只看未完成</label>
        </div>
        <p className="hint">显示 {filteredDevices.length}/{task.devices.length} 个设备位</p>
        <div className="compact-list">
          {filteredDevices.map((device) => {
            const missing = deviceMissingTypes(device);
            const counts = devicePhotoCounts(device);
            const required = requiredForDevice(device);
            return (
              <article key={device.id} role="button" tabIndex={0} className={`compact-list-item ${statusClass({ missingCount: missing.length, localPending: counts.localPending, failed: counts.failed })}`} onClick={() => enterDevice(device)} onKeyDown={(event) => { if (event.key === 'Enter') enterDevice(device); }}>
                <span className="item-main">
                  <strong>{device.name}</strong>
                  <small>{device.deviceType} · {missing.length ? `缺：${missing.map(displayPhotoType).join('、')}` : '已完成必拍'}</small>
                </span>
                <span className="item-meta">
                  <strong>{missing.length ? `${required.length - missing.length}/${required.length}` : '完成'}</strong>
                  <small>同步 {counts.synced} · 待传 {counts.localPending} · 失败 {counts.failed}</small>
                </span>
                {canReviewTemporary && device.isTemporary && device.reviewStatus !== 'approved' && <span className="inline-actions"><button type="button" className="ghost compact-action" onClick={(event) => { event.stopPropagation(); approveTemporaryDevice(device); }}>确认补录</button></span>}
              </article>
            );
          })}
        </div>
        {filteredDevices.length === 0 && <EmptyState title="没有匹配的设备位" text="调整搜索条件后再查看。" />}
        {confirmDialog}
      </div>
    );
  }

  return (
    <div className="view-stack capture-screen capture-device-screen" ref={captureTopRef}>
      <PageHeader title={selectedDevice.name} subtitle={`${tree.name} / ${task.name} / ${selectedDevice.deviceType}`} onBack={leaveDevice} backText="返回设备" />
      <Breadcrumb items={[{ label: tree.name, onClick: leaveTask }, { label: task.name, onClick: leaveDevice }, { label: selectedDevice.name }]} />
      <div className="device-capture-summary">
        <div><strong>{selectedDevicePhotos.length}</strong><span>已同步照片</span></div>
        <div><strong>{selectedLocalPhotos.length}</strong><span>本地待同步</span></div>
        <div><strong>{missingTypes.length}</strong><span>缺失必拍</span></div>
      </div>
      <div className={missingTypes.length === 0 ? 'missing-box done' : 'missing-box'}>
        当前设备类型：{selectedDeviceType}；{missingTypes.length === 0 ? '必拍项已完成，后续可继续拍额外照片。' : `还缺：${missingTypes.map(displayPhotoType).join('、')}`}
      </div>
      <label className="photo-type-field">照片类型
        <select value={photoType} onChange={(event) => setPhotoType(event.target.value)}>
          {photoTypes.map((type) => <option key={type.id} value={type.name}>{type.name}{type.required ? '（必拍）' : ''}</option>)}
          <option value="extra">额外拍摄照片</option>
        </select>
      </label>
      <button type="button" className="ghost next-type-button big-action secondary-main" onClick={selectNextPhotoType}>下一类型</button>
      {draft && <PhotoConfirm ref={confirmRef} draft={draft} onCancel={() => setDraft(null)} onConfirm={confirmDraft} />}
      {message && <p className="hint">{message}</p>}
      {isNativeApp() ? (
        <button type="button" className={draft ? 'camera-button hidden-while-confirming big-action' : 'camera-button big-action'} disabled={busy} onClick={takePhotoWithNativeCamera}>{busy ? '处理中...' : '拍摄照片'}</button>
      ) : (
        <label className={draft ? 'camera-button hidden-while-confirming big-action' : 'camera-button big-action'}>
          <input type="file" accept="image/*" capture="environment" disabled={busy} onChange={async (event) => { await prepareFiles(event.target.files); event.currentTarget.value = ''; }} />
          {busy ? '处理中...' : '拍摄 / 选择照片'}
        </label>
      )}
      <section className="fold-section">
        <div className="section-head">
          <div>
            <h3>本设备照片</h3>
            <p className="hint">默认折叠，避免拍照时误触照片操作。</p>
          </div>
          <button type="button" className="ghost" onClick={() => setPhotosOpen(!photosOpen)}>{photosOpen ? '收起' : `查看 ${selectedLocalPhotos.length + selectedDevicePhotos.length} 张`}</button>
        </div>
        {photosOpen && <DevicePhotoReview projectId={projectId} device={selectedDevice} localPhotos={selectedLocalPhotos} photos={selectedDevicePhotos} session={session} onPreview={setPreviewPhoto} reload={reload} confirm={confirm} onRetake={beginRetake} />}
      </section>
      {previewPhoto && <PhotoPreviewModal photo={previewPhoto} onClose={() => setPreviewPhoto(null)} />}
      {confirmDialog}
    </div>
  );
}

function Breadcrumb({ items }) {
  return (
    <nav className="breadcrumb" aria-label="当前位置">
      {items.map((item, index) => (
        <React.Fragment key={`${item.label}-${index}`}>
          {index > 0 && <span>/</span>}
          {item.onClick ? <button type="button" className="breadcrumb-link" onClick={item.onClick}>{item.label}</button> : <strong>{item.label}</strong>}
        </React.Fragment>
      ))}
    </nav>
  );
}

function PageHeader({ title, subtitle, onBack, backText }) {
  return (
    <div className="capture-detail-head compact-head">
      <button type="button" className="ghost" onClick={onBack}>{backText}</button>
      <div>
        <h2>{title}</h2>
        <p className="hint">{subtitle}</p>
      </div>
    </div>
  );
}

const PhotoConfirm = React.forwardRef(function PhotoConfirm({ draft, onCancel, onConfirm }, ref) {
  return (
    <section className="confirm-box photo-confirm-focus" ref={ref}>
      <div className="section-head">
        <div>
          <h3>确认照片</h3>
          <p className="hint">{draft.metadata.taskPointName} · {draft.metadata.devicePositionName} · {displayPhotoType(draft.metadata.photoType)}</p>
        </div>
      </div>
      <img src={draft.previewUrl} alt="待确认照片" />
      {draft.metadata.qualityWarnings.length > 0 && <div className="warning-list">{draft.metadata.qualityWarnings.map((item) => <span key={item}>{item}</span>)}</div>}
      <div className="confirm-actions">
        <button type="button" className="ghost retake-button" onClick={onCancel}>取消重拍</button>
        <button type="button" className="big-action confirm-button" onClick={onConfirm}>确认加入同步队列</button>
      </div>
    </section>
  );
});

function DevicePhotoReview({ projectId, device, localPhotos, photos, session, onPreview, reload, confirm, onRetake }) {
  const [selectedIds, setSelectedIds] = useState([]);
  const [retakeReason, setRetakeReason] = useState(RETAKE_REASONS[0]);
  const selectablePhotos = photos.filter((photo) => session?.user.role !== 'collector' || Number(photo.capturedById) === Number(session?.user.id));
  const allSelected = selectablePhotos.length > 0 && selectablePhotos.every((photo) => selectedIds.includes(photo.id));

  async function deletePhoto(photo) {
    const ok = await confirm({
      title: '删除并重拍',
      message: '照片会进入回收站，可由管理员恢复。确认后会回到当前照片类型。',
      details: [`文件：${photo.fileName}`, `设备：${device.name}`, `类型：${displayPhotoType(photo.photoType)}`, `原因：${retakeReason}`],
      confirmText: '删除并重拍',
      danger: true
    });
    if (!ok) return;
    await api(`/api/projects/${projectId}/photos/${photo.id}`, { method: 'DELETE', body: JSON.stringify({ reason: `删除重拍：${retakeReason}` }) });
    await reload();
    onRetake?.(photo);
  }

  async function deleteSelected() {
    if (selectedIds.length === 0) return;
    const selectedPhotos = selectablePhotos.filter((photo) => selectedIds.includes(photo.id));
    const ok = await confirm({
      title: '批量删除并重拍',
      message: `确认删除选中的 ${selectedIds.length} 张照片？`,
      details: [`设备：${device.name}`, `原因：${retakeReason}`, '照片会进入回收站'],
      confirmText: '批量删除并重拍',
      danger: true
    });
    if (!ok) return;
    await Promise.all(selectedIds.map((id) => api(`/api/projects/${projectId}/photos/${id}`, { method: 'DELETE', body: JSON.stringify({ reason: `批量删除重拍：${retakeReason}` }) })));
    setSelectedIds([]);
    await reload();
    if (selectedPhotos[0]) onRetake?.(selectedPhotos[0]);
  }

  function toggleSelected(id) {
    setSelectedIds((list) => list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
  }

  return (
    <section className="capture-review">
      <div className="section-head">
        <div>
          <h3>照片明细</h3>
          <p className="hint">{device.name} · {device.deviceType}</p>
        </div>
        <span className="count-pill">{localPhotos.length + photos.length} 张</span>
      </div>
      <h4>本地待同步</h4>
      {localPhotos.length === 0 ? <p className="hint">没有本地待同步照片。</p> : <LocalPhotoGrid items={localPhotos} />}
      <div className="section-head photo-management-head">
        <h4>已同步照片</h4>
        {selectablePhotos.length > 0 && (
          <div className="inline-actions photo-danger-actions">
            <select className="reason-select" value={retakeReason} onChange={(event) => setRetakeReason(event.target.value)}>
              {RETAKE_REASONS.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
            </select>
            <button type="button" className="ghost" onClick={() => setSelectedIds(allSelected ? [] : selectablePhotos.map((photo) => photo.id))}>{allSelected ? '取消全选' : '选择可删照片'}</button>
            <button type="button" className="ghost danger" onClick={deleteSelected} disabled={selectedIds.length === 0}>删除选中并重拍</button>
          </div>
        )}
      </div>
      {photos.length === 0 ? (
        <p className="hint">当前设备还没有已同步照片。</p>
      ) : (
        <div className="photo-grid compact">
          {photos.map((photo) => {
            const canDelete = session?.user.role !== 'collector' || Number(photo.capturedById) === Number(session?.user.id);
            return (
              <div key={photo.id} className="photo-card">
                {canDelete && <label className="photo-select"><input type="checkbox" checked={selectedIds.includes(photo.id)} onChange={() => toggleSelected(photo.id)} />选择</label>}
                <button type="button" className="image-button" onClick={() => onPreview(photo)}><img src={uploadUrl(photo.watermarkedPath)} alt={photo.fileName} /></button>
                <strong>{displayPhotoType(photo.photoType)}</strong>
                <small>{photo.fileName}</small>
                {photo.qualityWarnings?.length > 0 && <small className="warning-text">{photo.qualityWarnings.join('、')}</small>}
                <div className="photo-path-actions">
                  <button type="button" className="ghost tiny" onClick={() => onPreview({ ...photo, previewMode: 'watermarked' })}>水印图</button>
                  <button type="button" className="ghost tiny" onClick={() => onPreview({ ...photo, previewMode: 'original' })}>原图</button>
                </div>
                {canDelete && <button type="button" className="ghost danger-soft" onClick={() => deletePhoto(photo)}>删除并重拍</button>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function LocalPhotoGrid({ items }) {
  return (
    <div className="photo-grid compact">
      {items.map((item) => (
        <div key={item.id} className="photo-card local">
          <LocalPhotoImage item={item} alt="本地待同步照片" />
          <strong>{displayPhotoType(item.metadata?.photoType)}</strong>
          <small>{item.metadata?.devicePositionName}</small>
          <small>{item.status === 'failed' ? `失败：${item.lastError}` : item.status === 'syncing' ? '同步中' : '本地待同步'}</small>
        </div>
      ))}
    </div>
  );
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

  useEffect(() => {
    return () => {
      if (src?.startsWith('blob:')) URL.revokeObjectURL(src);
    };
  }, [src]);

  return src ? <img src={src} alt={alt} loading="lazy" /> : <div className="photo-placeholder">本地照片</div>;
}

function EmptyState({ title, text }) {
  return <div className="empty-state"><h2>{title}</h2><p>{text}</p></div>;
}

function PhotoPreviewModal({ photo, onClose }) {
  const [mode, setMode] = useState(photo.previewMode || 'watermarked');
  const imagePath = mode === 'original' ? photo.originalPath : photo.watermarkedPath;
  const missingText = mode === 'original' ? '这张照片没有原图路径，可能是旧数据或文件已被清理。' : '这张照片没有水印图路径，可能是旧数据或文件已被清理。';
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="photo-modal" onClick={(event) => event.stopPropagation()}>
        <div className="section-head">
          <div>
            <h3>{photo.devicePositionName}</h3>
            <p className="hint">{photo.deviceType} · {displayPhotoType(photo.photoType)} · {photo.capturedBy}</p>
          </div>
          <button type="button" className="ghost" onClick={onClose}>关闭</button>
        </div>
        <div className="inline-actions">
          <button type="button" className={mode === 'watermarked' ? 'active' : 'ghost'} disabled={!photo.watermarkedPath} onClick={() => setMode('watermarked')}>查看水印图</button>
          <button type="button" className={mode === 'original' ? 'active' : 'ghost'} disabled={!photo.originalPath} onClick={() => setMode('original')}>查看原图</button>
        </div>
        {imagePath ? <img src={uploadUrl(imagePath)} alt={photo.fileName} /> : <div className="photo-placeholder large">{missingText}</div>}
        <p className="hint">{imagePath || missingText}</p>
      </div>
    </div>
  );
}

function sortPhotos(list) {
  return [...list].sort((a, b) => {
    const seqA = Number(a.sequence || 0);
    const seqB = Number(b.sequence || 0);
    if (seqA !== seqB) return seqB - seqA;
    return new Date(b.capturedAt || 0) - new Date(a.capturedAt || 0);
  });
}
