const DB_NAME = 'squadchat-offline-v1';
const DB_VERSION = 1;
const RECENT_PHOTO_SEND_MS = 10 * 60 * 1000;

export type OfflineQueueItem = {
  id: string;
  user_id: string;
  conversation_id: string;
  kind: 'text' | 'photos';
  content?: string;
  files?: Array<{ blob: Blob; name: string; type: string }>;
  created_at: string;
};

function openOfflineDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Offline storage could not be opened.'));
  });
}

async function offlineStore<T>(storeName: 'cache' | 'queue', mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    let result: T;
    let requestFailed = false;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => {
      requestFailed = true;
      reject(request.error || new Error('Offline storage request failed.'));
    };
    transaction.oncomplete = () => {
      db.close();
      if (!requestFailed) resolve(result!);
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error || new Error('Offline storage transaction was not saved.'));
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error('Offline storage transaction failed.'));
    };
  });
}

export async function saveOfflineChatList(userId: string, chats: unknown[]) {
  await offlineStore('cache', 'readwrite', store => store.put({ key: 'chats:' + userId, value: chats, saved_at: Date.now() }));
}

export async function getOfflineChatList<T>(userId: string): Promise<T[] | null> {
  const row = await offlineStore<any>('cache', 'readonly', store => store.get('chats:' + userId));
  return Array.isArray(row?.value) ? row.value as T[] : null;
}

export async function saveOfflineMessages(userId: string, conversationId: string, messages: unknown[]) {
  await offlineStore('cache', 'readwrite', store => store.put({ key: 'messages:' + userId + ':' + conversationId, value: messages.slice(-200), saved_at: Date.now() }));
}

export async function upsertOfflineMessage(userId: string, conversationId: string, message: any) {
  const key = 'messages:' + userId + ':' + conversationId;
  const row = await offlineStore<any>('cache', 'readonly', store => store.get(key));
  const messages = Array.isArray(row?.value) ? row.value.slice() : [];
  const index = messages.findIndex((entry: any) => entry?.id === message?.id);
  if (index >= 0) messages[index] = message;
  else messages.push(message);
  messages.sort((a: any, b: any) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());
  await saveOfflineMessages(userId, conversationId, messages.slice(-200));
}

export async function getOfflineMessages<T>(userId: string, conversationId: string): Promise<T[] | null> {
  const row = await offlineStore<any>('cache', 'readonly', store => store.get('messages:' + userId + ':' + conversationId));
  return Array.isArray(row?.value) ? row.value as T[] : null;
}

export async function saveOfflinePhoto(userId: string, url: string, blob: Blob) {
  await offlineStore('cache', 'readwrite', store => store.put({ key: 'photo:' + userId + ':' + url, value: blob, saved_at: Date.now() }));
  const rows = await offlineStore<any[]>('cache', 'readonly', store => store.getAll());
  const prefix = 'photo:' + userId + ':';
  const photos = (rows || []).filter(row => typeof row.key === 'string' && row.key.startsWith(prefix)).sort((a, b) => (a.saved_at || 0) - (b.saved_at || 0));
  const excess = photos.length - 120;
  if (excess > 0) {
    for (const row of photos.slice(0, excess)) {
      await offlineStore('cache', 'readwrite', store => store.delete(row.key));
    }
  }
}

export async function getOfflinePhoto(userId: string, url: string): Promise<Blob | null> {
  const row = await offlineStore<any>('cache', 'readonly', store => store.get('photo:' + userId + ':' + url));
  return row?.value instanceof Blob ? row.value as Blob : null;
}

async function blobFingerprint(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < bytes.length; index++) {
    first = Math.imul(first ^ bytes[index], 0x01000193);
    second = Math.imul(second ^ bytes[index], 0x85ebca6b);
  }
  return blob.size + ':' + blob.type + ':' + (first >>> 0).toString(16) + (second >>> 0).toString(16);
}

async function photoAlbumFingerprint(files: Array<{ blob: Blob }>): Promise<string> {
  const parts = await Promise.all(files.map(file => blobFingerprint(file.blob)));
  return parts.sort().join('|');
}

function photoSendKey(userId: string, conversationId: string, fingerprint: string) {
  return 'photo-send:' + userId + ':' + conversationId + ':' + fingerprint;
}

export async function hasPendingPhotoAlbum(userId: string, conversationId: string, files: Blob[]): Promise<boolean> {
  const fingerprint = await photoAlbumFingerprint(files.map(blob => ({ blob })));
  const recent = await offlineStore<any>('cache', 'readonly', store => store.get(photoSendKey(userId, conversationId, fingerprint)));
  if (recent?.saved_at && Date.now() - recent.saved_at < RECENT_PHOTO_SEND_MS) return true;
  const queued = await getOfflineQueue();
  for (const item of queued) {
    if (item.user_id !== userId || item.conversation_id !== conversationId || item.kind !== 'photos' || !item.files?.length || item.files.length !== files.length) continue;
    if (await photoAlbumFingerprint(item.files) === fingerprint) return true;
  }
  return false;
}

export async function rememberPhotoAlbum(userId: string, conversationId: string, files: Blob[]) {
  const fingerprint = await photoAlbumFingerprint(files.map(blob => ({ blob })));
  await offlineStore('cache', 'readwrite', store => store.put({
    key: photoSendKey(userId, conversationId, fingerprint),
    value: fingerprint,
    saved_at: Date.now()
  }));
}

export async function removeDuplicateQueuedPhotoAlbums(userId: string): Promise<string[]> {
  const queued = await getOfflineQueue();
  const seen = new Set<string>();
  const removed: string[] = [];
  for (const item of queued) {
    if (item.user_id !== userId || item.kind !== 'photos' || !item.files?.length) continue;
    const fingerprint = await photoAlbumFingerprint(item.files);
    const key = item.conversation_id + ':' + fingerprint;
    if (seen.has(key)) {
      await removeOfflineQueueItem(item.id);
      removed.push(item.id);
    } else {
      seen.add(key);
    }
  }
  return removed;
}

export async function addOfflineQueueItem(item: OfflineQueueItem) {
  await offlineStore('queue', 'readwrite', store => store.put(item));
}

export async function getOfflineQueue(): Promise<OfflineQueueItem[]> {
  const rows = await offlineStore<OfflineQueueItem[]>('queue', 'readonly', store => store.getAll());
  return (rows || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function removeOfflineQueueItem(id: string) {
  await offlineStore('queue', 'readwrite', store => store.delete(id));
}
