export function displayPhotoType(type) {
  return type === 'extra' || type === '额外拍摄照片' ? '额外拍摄照片' : type;
}

export function photoTypeValue(type) {
  return type === '额外拍摄照片' ? 'extra' : type;
}

export function normalizedDeviceType(type) {
  return type || '通用';
}

export function requiredPhotoTypesForDevice(device, photoTypes = []) {
  const deviceType = normalizedDeviceType(device?.deviceType);
  const exact = photoTypes
    .filter((type) => type.required && normalizedDeviceType(type.deviceType) === deviceType)
    .map((type) => type.name);
  const common = photoTypes
    .filter((type) => type.required && normalizedDeviceType(type.deviceType) === '通用')
    .map((type) => type.name);
  return exact.length ? exact : common;
}

export function nextRequiredPhotoTypeForDevice({ device, photoTypes = [], photos = [], queue = [] }) {
  if (!device) return 'extra';
  const requiredTypes = requiredPhotoTypesForDevice(device, photoTypes);
  const captured = new Set([
    ...photos
      .filter((photo) => String(photo.devicePositionId) === String(device.id))
      .map((photo) => displayPhotoType(photo.photoType)),
    ...queue
      .filter((item) => String(item.metadata?.devicePositionId) === String(device.id))
      .map((item) => displayPhotoType(item.metadata?.photoType))
  ]);
  return requiredTypes.find((type) => !captured.has(displayPhotoType(type))) || 'extra';
}
