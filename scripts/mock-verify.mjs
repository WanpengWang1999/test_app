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
    { 项目: projectName, 任务点: 'A区基站', 设备位: '机柜01-BBU01', 设备类型: 'BBU', 设备编号: 'A-BBU-001' },
    { 项目: projectName, 任务点: 'A区基站', 设备位: '机柜01-BBU02', 设备类型: 'BBU', 设备编号: 'A-BBU-002' }
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), '设备位');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function importForm(excel) {
  const form = new FormData();
  form.append('file', fileBlob(excel, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'mock.xlsx');
  form.append('fields', JSON.stringify({ project: '项目', taskPoint: '任务点', devicePosition: '设备位', deviceType: '设备类型', deviceCode: '设备编号' }));
  return form;
}

async function uploadPhoto({ token, tree, task, device, photoType }) {
  const form = new FormData();
  form.append('original', fileBlob(png, 'image/png'), 'mock.png');
  form.append('watermarked', fileBlob(png, 'image/png'), 'mock-watermarked.jpg');
  form.append('metadata', JSON.stringify({
    clientId: crypto.randomUUID(),
    projectId: tree.id,
    taskPointId: task.id,
    devicePositionId: device.id,
    photoType,
    capturedAt: new Date().toISOString(),
    qualityWarnings: []
  }));
  return request('/api/photos', { method: 'POST', headers: authHeaders(token), body: form });
}

async function main() {
  const stages = [];
  const superLogin = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: process.env.INITIAL_ADMIN_PHONE || '19720410920', password: process.env.INITIAL_ADMIN_PASSWORD || 'WWP1999' })
  });
  const superToken = superLogin.token;
  stages.push({ stage: '正式管理员登录', result: `${superLogin.user.phone || superLogin.user.username} / ${superLogin.user.role}` });

  const pendingPhone = `139${stamp.slice(-8)}`;
  await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: pendingPhone, displayName: `注册采集员${stamp}`, company: '测试单位', password: 'collector123' })
  });
  await expectFail('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: pendingPhone, password: 'collector123' })
  }, 403);
  const usersBeforeApproval = await request('/api/users', { headers: authHeaders(superToken) });
  const pendingUser = usersBeforeApproval.users.find((user) => user.phone === pendingPhone);
  if (!pendingUser || pendingUser.status !== 'pending' || pendingUser.role !== 'collector') throw new Error('Registered user was not pending collector');
  await request(`/api/users/${pendingUser.id}/status`, { method: 'PATCH', headers: jsonHeaders(superToken), body: JSON.stringify({ status: 'active' }) });
  const collectorLogin = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: pendingPhone, password: 'collector123' })
  });
  stages.push({ stage: '注册审批', result: '手机号注册后待审批，审批通过后可登录' });

  const projectAdminPhone = `138${stamp.slice(-8)}`;
  await request('/api/users', {
    method: 'POST',
    headers: jsonHeaders(superToken),
    body: JSON.stringify({ phone: projectAdminPhone, password: 'project123', displayName: `项目管理员${stamp}`, company: '测试单位', role: 'project_admin' })
  });
  const projectAdminLogin = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: projectAdminPhone, password: 'project123' })
  });
  const projectAdminToken = projectAdminLogin.token;
  await expectFail('/api/users', {
    method: 'POST',
    headers: jsonHeaders(projectAdminToken),
    body: JSON.stringify({ phone: `137${stamp.slice(-8)}`, password: 'project123', displayName: '越权项目管理员', company: '测试单位', role: 'project_admin' })
  }, 403);
  stages.push({ stage: '账号等级', result: '完全管理员可创建项目管理员，项目管理员不能创建管理员类账号' });

  const adminProject = await request('/api/projects', { method: 'POST', headers: jsonHeaders(superToken), body: JSON.stringify({ name: `权限验证项目-${stamp}` }) });
  await request(`/api/projects/${adminProject.id}`, { method: 'PATCH', headers: jsonHeaders(projectAdminToken), body: JSON.stringify({ name: `${adminProject.name}-项目管理员可管理` }) });
  stages.push({ stage: '项目管理员权限', result: '项目管理员可管理全部项目' });

  const projectName = `命名验证项目-${stamp}`;
  const imported = await request('/api/projects/import-excel', { method: 'POST', headers: authHeaders(projectAdminToken), body: importForm(makeExcel(projectName)) });
  const tree = await request(`/api/projects/${imported.project.id}/tree`, { headers: authHeaders(collectorLogin.token) });
  const task = tree.tasks[0];
  const device = task.devices[0];
  const photoType = tree.photoTypes.find((type) => type.deviceType === device.deviceType)?.name || '全景';
  const first = await uploadPhoto({ token: collectorLogin.token, tree, task, device, photoType });
  const second = await uploadPhoto({ token: collectorLogin.token, tree, task, device, photoType });
  const expectedPrefix = `${projectName}-${task.name}-${device.name}-${photoType}-`;
  if (!first.fileName.startsWith(expectedPrefix) || !first.fileName.endsWith('01.jpg')) throw new Error(`Unexpected first filename: ${first.fileName}`);
  if (!second.fileName.startsWith(expectedPrefix) || !second.fileName.endsWith('02.jpg')) throw new Error(`Unexpected second filename: ${second.fileName}`);
  stages.push({ stage: '照片命名', result: `${first.fileName}，${second.fileName}` });

  await request(`/api/projects/${tree.id}/photos/${second.id}`, { method: 'DELETE', headers: jsonHeaders(collectorLogin.token), body: JSON.stringify({ reason: '验证删除重拍' }) });
  const recycle = await request(`/api/projects/${tree.id}/recycle-bin`, { headers: authHeaders(projectAdminToken) });
  if (!recycle.photos.some((photo) => photo.id === second.id)) throw new Error('Deleted photo not found in recycle bin');
  stages.push({ stage: '回收站', result: '采集员可删除自己照片进入回收站，管理员可查看' });

  await expectFail('/api/projects', { method: 'POST', headers: jsonHeaders(collectorLogin.token), body: JSON.stringify({ name: `采集员越权项目-${stamp}` }) }, 403);
  await expectFail(`/api/projects/${tree.id}/export-check`, { headers: authHeaders(collectorLogin.token) }, 403);
  stages.push({ stage: '采集员权限', result: '采集员不能新建项目，也不能访问导出检查' });

  const health = await request('/api/admin/health', { headers: authHeaders(superToken) });
  if (health.status !== 'ok') throw new Error(`Unexpected health status: ${health.status}`);
  stages.push({ stage: '健康检查', result: `健康状态 ${health.status}` });

  console.log(JSON.stringify({ projectId: tree.id, projectName, stages }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
