import test from 'node:test';
import assert from 'node:assert/strict';
import { nextRequiredPhotoTypeForDevice } from './photoTypes.js';

const photoTypes = [
  { deviceType: 'RRU', name: '全景', required: true },
  { deviceType: 'RRU', name: '近景', required: true },
  { deviceType: 'RRU', name: '铭牌', required: true },
  { deviceType: 'RRU', name: '走线', required: true },
  { deviceType: '通用', name: '通用全景', required: true }
];

test('selects first unshot required photo type for the selected device', () => {
  const device = { id: 9, deviceType: 'RRU' };
  const photos = [
    { devicePositionId: 9, photoType: '全景' },
    { devicePositionId: 9, photoType: '近景' },
    { devicePositionId: 8, photoType: '铭牌' }
  ];
  const queue = [
    { metadata: { devicePositionId: 9, photoType: '铭牌' } }
  ];

  assert.equal(nextRequiredPhotoTypeForDevice({ device, photoTypes, photos, queue }), '走线');
});

test('falls back to extra when all required photo types are already captured', () => {
  const device = { id: 9, deviceType: 'RRU' };
  const photos = [
    { devicePositionId: 9, photoType: '全景' },
    { devicePositionId: 9, photoType: '近景' },
    { devicePositionId: 9, photoType: '铭牌' },
    { devicePositionId: 9, photoType: '走线' }
  ];

  assert.equal(nextRequiredPhotoTypeForDevice({ device, photoTypes, photos, queue: [] }), 'extra');
});
