const DB_NAME = 'telecom-photo-acceptance';
const DB_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('queuedPhotos')) db.createObjectStore('queuedPhotos', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('projectTrees')) db.createObjectStore('projectTrees', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function tx(storeName, mode, callback) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const result = callback(store);
    transaction.oncomplete = () => resolve(result?.result ?? result);
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function addQueuedPhoto(photo) {
  const now = new Date().toISOString();
  return tx('queuedPhotos', 'readwrite', (store) =>
    store.add({ ...photo, status: photo.status || 'pending', retryCount: photo.retryCount || 0, lastError: photo.lastError || '', createdAt: photo.createdAt || now, updatedAt: now })
  );
}

export async function getQueuedPhotos() {
  return tx('queuedPhotos', 'readonly', (store) => store.getAll());
}

export async function updateQueuedPhoto(id, patch) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('queuedPhotos', 'readwrite');
    const store = transaction.objectStore('queuedPhotos');
    const getRequest = store.get(id);
    getRequest.onsuccess = () => {
      const item = getRequest.result;
      if (!item) return;
      store.put({ ...item, ...patch, updatedAt: new Date().toISOString() });
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function removeQueuedPhoto(id) {
  return tx('queuedPhotos', 'readwrite', (store) => store.delete(id));
}

export async function putCachedTree(tree) {
  if (!tree) return;
  return tx('projectTrees', 'readwrite', (store) => store.put(tree));
}

export async function getCachedTree(id) {
  return tx('projectTrees', 'readonly', (store) => store.get(id));
}

export async function putCachedProjects(projects) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('projects', 'readwrite');
    const store = transaction.objectStore('projects');
    projects.forEach((project) => store.put(project));
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function getCachedProjects() {
  return tx('projects', 'readonly', (store) => store.getAll());
}
