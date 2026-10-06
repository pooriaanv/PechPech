'use strict';

// store.js — IndexedDB-backed replacement for the server's RecordingStore
// (server/src/server.js). Audio is stored inline as a Blob instead of a
// file on disk. Verified empirically: IndexedDB (including Blob storage)
// works fine from inside an offscreen document in this Chrome build.

const DB_NAME    = 'pechpech';
const DB_VERSION = 1;
const STORE_NAME = 'recordings';

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _dbPromise;
}

async function initStore() {
  await openDb();
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error);
  });
}

function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function createRecording({ audioBlob, mimeType }) {
  const db = await openDb();
  const id = `rec_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  const record = {
    id,
    audioBlob,
    mimeType:             mimeType || 'audio/webm',
    status:               'saved',
    createdAt:            Date.now(),
    title:                null,
    mode:                 null,
    language:             null,
    notes:                null,
    transcript:           null,
    summary:              null,
    decisions:            null,
    action_items:         null,
    error:                null,
    corrected_transcript: null,
    correction_status:    null,
    correction_error:     null,
  };

  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(record);
  await txDone(tx);

  return record;
}

async function getRecording(id) {
  const db  = await openDb();
  const tx  = db.transaction(STORE_NAME, 'readonly');
  const rec = await reqDone(tx.objectStore(STORE_NAME).get(id));
  return rec || null;
}

async function updateRecording(id, patch) {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  const existing = await reqDone(store.get(id));
  if (!existing) {
    tx.abort();
    return null;
  }

  const merged = { ...existing, ...patch };
  store.put(merged);
  await txDone(tx);

  return merged;
}

async function listRecordings() {
  const db  = await openDb();
  const tx  = db.transaction(STORE_NAME, 'readonly');
  const all = await reqDone(tx.objectStore(STORE_NAME).getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

async function deleteRecording(id) {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).delete(id);
  await txDone(tx);
  return true;
}

export {
  initStore,
  createRecording,
  getRecording,
  updateRecording,
  listRecordings,
  deleteRecording,
};
