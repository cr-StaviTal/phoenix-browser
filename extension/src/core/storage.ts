/**
 * Chrome storage wrapper for simple key-value storage (policy, config).
 */
export class ChromeStorage {
  async get<T>(key: string): Promise<T | null> {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => {
        resolve(result[key] ?? null);
      });
    });
  }

  async set<T>(key: string, value: T): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, resolve);
    });
  }

  async remove(key: string): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.remove(key, resolve);
    });
  }

  async getAll(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (result) => {
        resolve(result);
      });
    });
  }

  async getBytesInUse(): Promise<number> {
    return new Promise((resolve) => {
      chrome.storage.local.getBytesInUse(null, resolve);
    });
  }
}

/**
 * IndexedDB wrapper for high-volume structured data (forensic logs).
 */
export class ForensicLogDB {
  private db: IDBDatabase | null = null;
  private readonly DB_NAME = 'phoenix_forensic_logs';
  private readonly STORE_NAME = 'logs';
  private readonly DB_VERSION = 1;

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('type', 'type', { unique: false });
          store.createIndex('severity', 'severity', { unique: false });
          store.createIndex('source', 'source', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve();
      };

      request.onerror = () => reject(request.error);
    });
  }

  async write(entry: ForensicLogEntry): Promise<void> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      tx.objectStore(this.STORE_NAME).add(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async query(options: LogQueryOptions = {}): Promise<ForensicLogEntry[]> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);

      let request: IDBRequest;
      if (options.since) {
        const index = store.index('timestamp');
        const range = IDBKeyRange.lowerBound(options.since);
        request = index.getAll(range, options.limit || 100);
      } else {
        request = store.getAll(null, options.limit || 100);
      }

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async deleteOlderThan(timestamp: number): Promise<number> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const index = store.index('timestamp');
      const range = IDBKeyRange.upperBound(timestamp);
      const request = index.openCursor(range);
      let deleted = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          cursor.delete();
          deleted++;
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(tx.error);
    });
  }

  async getCount(): Promise<number> {
    const db = this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readonly');
      const request = tx.objectStore(this.STORE_NAME).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async estimateStorageBytes(): Promise<number> {
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const estimate = await navigator.storage.estimate();
      return estimate.usage || 0;
    }
    return 0;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private getDB(): IDBDatabase {
    if (!this.db) {
      throw new Error('ForensicLogDB not opened. Call open() first.');
    }
    return this.db;
  }
}

export interface ForensicLogEntry {
  id: string;
  timestamp: number;
  type: string;
  severity: string;
  source: string;
  payload: Record<string, unknown>;
  tabId?: number;
  url?: string;
  sessionId: string;
}

export interface LogQueryOptions {
  since?: number;
  type?: string;
  severity?: string;
  limit?: number;
}
