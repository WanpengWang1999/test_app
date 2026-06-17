import { ROLE_COLLECTOR, ROLE_PROJECT_ADMIN, ROLE_SUPER_ADMIN } from './db.js';

export const USER_STATUS_PENDING = 'pending';
export const USER_STATUS_ACTIVE = 'active';
export const USER_STATUS_REJECTED = 'rejected';
export const USER_STATUS_DISABLED = 'disabled';
export const USER_STATUSES = [USER_STATUS_PENDING, USER_STATUS_ACTIVE, USER_STATUS_REJECTED, USER_STATUS_DISABLED];

export function normalizeUserStatus(status) {
  return USER_STATUSES.includes(status) ? status : USER_STATUS_ACTIVE;
}

export function registrationDefaults() {
  return {
    role: ROLE_COLLECTOR,
    status: USER_STATUS_PENDING
  };
}

export function shouldAllowLogin(user) {
  return Boolean(user) && !user.deleted_at && !user.deletedAt && normalizeUserStatus(user.status) === USER_STATUS_ACTIVE;
}

export function canManageTargetRole(actorRole, targetRole) {
  if (actorRole === ROLE_SUPER_ADMIN) return [ROLE_SUPER_ADMIN, ROLE_PROJECT_ADMIN, ROLE_COLLECTOR].includes(targetRole);
  if (actorRole === ROLE_PROJECT_ADMIN) return targetRole === ROLE_COLLECTOR;
  return false;
}

export function canSetUserStatus({ actorRole, targetRole, nextStatus, activeSuperAdminCount }) {
  if (!USER_STATUSES.includes(nextStatus)) return { allowed: false, error: '账号状态无效' };
  if (!canManageTargetRole(actorRole, targetRole)) return { allowed: false, error: '无权管理该账号' };
  if (targetRole === ROLE_SUPER_ADMIN && nextStatus !== USER_STATUS_ACTIVE && Number(activeSuperAdminCount) <= 1) {
    return { allowed: false, error: '至少需要保留一个已启用的完全管理员账号' };
  }
  return { allowed: true };
}
