import crypto from 'node:crypto';
import XLSX from 'xlsx';

const API = process.env.API_URL || 'http://localhost:3001';
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

async function request(pathname, options = {}) {
  const response = await fetch(`${API}${pathname}`, options);
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.arrayBuffer();
  if (!response.ok) {
    const message = body?.error || response.statusText;
    throw new Error(`${options.method || 'GET'} ${pathname} -> ${response.status} ${message}`);
  }
  return body;
}

async function expectFail(pathname, options, status) {
  const response = await fetch(`${API}${pathname}`, options);
  if (response.status !== status) {
    const text = await response.text();
    throw new Error(`Expected ${status} from ${options.method || 'GET'} ${pathname}, got ${response.status}: ${text}`);
  }
}

const jsonHeaders = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });
const fileBlob = (buffer, type) => new Blob([buffer], { type });

function makeExcel(projectName) {
  const rows = [
    { 项目: projectName, 任务点: 'A区基站', 设备位: '机柜01-BBU01', 设备类型: 'BBU', 编号: 'A-BBU-001' },
    { 项目: projectName, 任务点: 'A区基站', 设备位: '机柜01-BBU02', 设备类型: 'BBU', 编号: 'A-BBU-002' }
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), '设备位');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function importForm(excel) {
  const form = new FormData();
  form.append('file', fileBlob(excel, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'mock.xlsx');
  form.append('fields', JSON.stringify({ project: '项目', taskPoint: '任务点', devicePosition: '设备位', deviceType: '设备类型', deviceCode: '编号' }));
  return form;
}

async function uploadPhoto({ token, tree, task, device, photoType }) {
  const form = new FormData();
  form.append('original', fileBlob(png, 'image/png'), 'mock.png');
  form.append('watermarked', fileBlob(png, 'image/png'), 'mock-watermarked.jpg');
  form.append('metadata', JSON.stringify({ clientId: crypto.randomUUID(), projectId: tree.id, taskPointId: task.id, devicePositionId: device.id, photoType, capturedAt: new Date().toISOString(), qualityWarnings: [] }));
  return request('/api/photos', { method: 'POST', headers: authHeaders(token), body: form });
}

async function main() {
  const stages = [];
  const superLogin = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  const projectAdminLogin = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'projectadmin', password: 'project123' }) });
  const collectorLogin = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'collector', password: 'collector123' }) });
  stages.push({ stage: '登录与角色', result: `admin=${superLogin.user.role}, projectadmin=${projectAdminLogin.user.role}, collector=${collectorLogin.user.role}` });

  const superToken = superLogin.token;
  const projectAdminToken = projectAdminLogin.token;
  const collectorToken = collectorLogin.token;

  const adminProject = await request('/api/projects', { method: 'POST', headers: jsonHeaders(superToken), body: JSON.stringify({ name: `权限验证-完全管理员项目-${stamp}` }) });
  await expectFail(`/api/projects/${adminProject.id}`, { method: 'PATCH', headers: jsonHeaders(projectAdminToken), body: JSON.stringify({ name: `${adminProject.name}-未授权改名` }) }, 403);
  stages.push({ stage: '未授权项目拦截', result: '项目管理员访问未授权项目管理接口返回 403' });

  const users = await request('/api/users', { headers: authHeaders(superToken) });
  const projectAdminUser = users.users.find((user) => user.username === 'projectadmin');
  await request(`/api/projects/${adminProject.id}/members`, { method: 'POST', headers: jsonHeaders(superToken), body: JSON.stringify({ userId: projectAdminUser.id }) });
  await request(`/api/projects/${adminProject.id}`, { method: 'PATCH', headers: jsonHeaders(projectAdminToken), body: JSON.stringify({ name: `${adminProject.name}-已授权` }) });
  stages.push({ stage: '项目授权', result: '完全管理员授权后，项目管理员可管理该项目' });

  const newCollectorName = `collector_${stamp}`;
  await request('/api/users', { method: 'POST', headers: jsonHeaders(projectAdminToken), body: JSON.stringify({ username: newCollectorName, password: 'collector123', displayName: `采集员${stamp}`, role: 'collector' }) });
  await expectFail('/api/users', { method: 'POST', headers: jsonHeaders(projectAdminToken), body: JSON.stringify({ username: `pa_${stamp}`, password: 'project123', displayName: '越权项目管理员', role: 'project_admin' }) }, 403);
  stages.push({ stage: '账号管理', result: '项目管理员可创建采集员，不能创建管理员类账号' });

  const projectName = `命名验证项目-${stamp}`;
  const imported = await request('/api/projects/import-excel', { method: 'POST', headers: authHeaders(projectAdminToken), body: importForm(makeExcel(projectName)) });
  const tree = await request(`/api/projects/${imported.project.id}/tree`, { headers: authHeaders(collectorToken) });
  const task = tree.tasks[0];
  const device = task.devices[0];
  const photoType = tree.photoTypes.find((type) => type.deviceType === device.deviceType)?.name || '全景';
  const first = await uploadPhoto({ token: collectorToken, tree, task, device, photoType });
  const second = await uploadPhoto({ token: collectorToken, tree, task, device, photoType });
  const expectedPrefix = `${projectName}-${task.name}-${device.name}-${photoType}-`;
  if (!first.fileName.startsWith(expectedPrefix) || !first.fileName.endsWith('01.jpg')) throw new Error(`Unexpected first filename: ${first.fileName}`);
  if (!second.fileName.startsWith(expectedPrefix) || !second.fileName.endsWith('02.jpg')) throw new Error(`Unexpected second filename: ${second.fileName}`);
  stages.push({ stage: '照片命名', result: `${first.fileName}；${second.fileName}` });

  const secondCollectorLogin = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: newCollectorName, password: 'collector123' }) });
  const third = await uploadPhoto({ token: secondCollectorLogin.token, tree, task, device, photoType });
  await expectFail(`/api/projects/${tree.id}/photos/${third.id}`, { method: 'DELETE', headers: authHeaders(collectorToken) }, 403);
  await request(`/api/projects/${tree.id}/photos/${third.id}`, { method: 'DELETE', headers: jsonHeaders(secondCollectorLogin.token), body: JSON.stringify({ reason: '验证删除' }) });
  const recycle = await request(`/api/projects/${tree.id}/recycle-bin`, { headers: authHeaders(projectAdminToken) });
  if (!recycle.photos.some((photo) => photo.id === third.id)) throw new Error('Deleted photo not found in recycle bin');
  await request(`/api/projects/${tree.id}/photos/${third.id}/restore`, { method: 'POST', headers: authHeaders(projectAdminToken) });
  const recycleAfterRestore = await request(`/api/projects/${tree.id}/recycle-bin`, { headers: authHeaders(projectAdminToken) });
  if (recycleAfterRestore.photos.some((photo) => photo.id === third.id)) throw new Error('Restored photo still in recycle bin');
  stages.push({ stage: '回收站', result: '采集员删除自己照片进入回收站，管理员可恢复' });

  await expectFail('/api/projects', { method: 'POST', headers: jsonHeaders(collectorToken), body: JSON.stringify({ name: `采集员越权项目-${stamp}` }) }, 403);
  await expectFail(`/api/projects/${tree.id}/export-check`, { headers: authHeaders(collectorToken) }, 403);
  stages.push({ stage: '采集员管理权限', result: '采集员不能新建项目，也不能访问导出检查' });

  const photos = await request(`/api/projects/${tree.id}/photos`, { headers: authHeaders(projectAdminToken) });
  const orderOk = photos.photos.every((photo, index, list) => index === 0 || list[index - 1].sequence >= photo.sequence);
  if (!orderOk) throw new Error('Photo list is not ordered by sequence descending');
  stages.push({ stage: '照片列表倒序', result: `照片列表按编号倒序返回，共 ${photos.photos.length} 张` });

  const health = await request('/api/admin/health', { headers: authHeaders(superToken) });
  if (health.status !== 'ok') throw new Error(`Unexpected health status: ${health.status}`);
  const backupBuffer = Buffer.from(await request(`/api/admin/backup?token=${superToken}`));
  if (backupBuffer.length <= 0) throw new Error('Backup zip is empty');
  stages.push({ stage: '健康与备份', result: `健康状态 ${health.status}，备份大小 ${Math.round(backupBuffer.length / 1024)} KB` });

  console.log(JSON.stringify({ projectId: tree.id, projectName, stages }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
