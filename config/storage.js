/**
 * In-Memory Storage Module
 * Simple key-value store using JavaScript Map
 */

class InMemoryStore {
  constructor() {
    this.store = new Map();
    this.connected = false;
  }

  async connect() {
    this.connected = true;
    console.log('✓ Connected to In-Memory Storage');
    return true;
  }

  async set(key, value) {
    this.store.set(key, value);
    return 'OK';
  }

  async get(key) {
    return this.store.get(key) || null;
  }

  async del(key) {
    return this.store.delete(key) ? 1 : 0;
  }

  async exists(key) {
    return this.store.has(key) ? 1 : 0;
  }

  async keys(pattern) {
    const allKeys = Array.from(this.store.keys());
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return allKeys.filter(key => key.startsWith(prefix));
    }
    return allKeys.filter(key => key === pattern);
  }

  async expire(key, seconds) {
    return 1;
  }
}

const memoryStore = new InMemoryStore();

const connectStore = async () => {
  try {
    await memoryStore.connect();
    return true;
  } catch (error) {
    console.error('Failed to initialize storage:', error);
    return false;
  }
};

module.exports = { memoryStore, connectStore };
