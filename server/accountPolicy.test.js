import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canManageTargetRole,
  canSetUserStatus,
  normalizeUserStatus,
  registrationDefaults,
  shouldAllowLogin
} from './accountPolicy.js';
import { ROLE_COLLECTOR, ROLE_PROJECT_ADMIN, ROLE_SUPER_ADMIN } from './db.js';

test('registration defaults to pending collector account', () => {
  assert.deepEqual(registrationDefaults(), {
    role: ROLE_COLLECTOR,
    status: 'pending'
  });
});

test('pending, rejected, disabled, and deleted users cannot log in', () => {
  assert.equal(shouldAllowLogin({ status: 'active' }), true);
  assert.equal(shouldAllowLogin({ status: 'pending' }), false);
  assert.equal(shouldAllowLogin({ status: 'rejected' }), false);
  assert.equal(shouldAllowLogin({ status: 'disabled' }), false);
  assert.equal(shouldAllowLogin({ status: 'active', deleted_at: '2026-01-01T00:00:00.000Z' }), false);
});

test('legacy users without status are treated as active', () => {
  assert.equal(normalizeUserStatus(null), 'active');
  assert.equal(normalizeUserStatus(undefined), 'active');
});

test('super admin can manage every role, project admin can only manage collectors', () => {
  assert.equal(canManageTargetRole(ROLE_SUPER_ADMIN, ROLE_SUPER_ADMIN), true);
  assert.equal(canManageTargetRole(ROLE_SUPER_ADMIN, ROLE_PROJECT_ADMIN), true);
  assert.equal(canManageTargetRole(ROLE_SUPER_ADMIN, ROLE_COLLECTOR), true);
  assert.equal(canManageTargetRole(ROLE_PROJECT_ADMIN, ROLE_COLLECTOR), true);
  assert.equal(canManageTargetRole(ROLE_PROJECT_ADMIN, ROLE_PROJECT_ADMIN), false);
  assert.equal(canManageTargetRole(ROLE_PROJECT_ADMIN, ROLE_SUPER_ADMIN), false);
  assert.equal(canManageTargetRole(ROLE_COLLECTOR, ROLE_COLLECTOR), false);
});

test('last active super admin cannot be disabled, rejected, or deleted', () => {
  assert.equal(canSetUserStatus({
    actorRole: ROLE_SUPER_ADMIN,
    targetRole: ROLE_SUPER_ADMIN,
    nextStatus: 'disabled',
    activeSuperAdminCount: 1,
    isSelf: false
  }).allowed, false);
  assert.equal(canSetUserStatus({
    actorRole: ROLE_SUPER_ADMIN,
    targetRole: ROLE_SUPER_ADMIN,
    nextStatus: 'active',
    activeSuperAdminCount: 1,
    isSelf: false
  }).allowed, true);
  assert.equal(canSetUserStatus({
    actorRole: ROLE_SUPER_ADMIN,
    targetRole: ROLE_PROJECT_ADMIN,
    nextStatus: 'disabled',
    activeSuperAdminCount: 1,
    isSelf: false
  }).allowed, true);
});
