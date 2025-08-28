// Cache service for embedding and query caching

import { CacheEntry } from '../types';

export class CacheService {
  constructor(private kv: KVNamespace, private ttl: number = 3600) {}

  private getCacheKey(type: string, id: string): string {
    return `${type}:${id}`;
  }

  async get<T>(type: string, id: string): Promise<T | null> {
    const key = this.getCacheKey(type, id);
    const cached = await this.kv.get<CacheEntry<T>>(key, 'json');
    
    if (!cached) return null;
    
    // Check if cache is expired
    if (Date.now() > cached.timestamp + cached.ttl * 1000) {
      // Delete expired cache
      await this.kv.delete(key);
      return null;
    }
    
    return cached.data;
  }

  async set<T>(type: string, id: string, data: T, customTtl?: number): Promise<void> {
    const key = this.getCacheKey(type, id);
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl: customTtl || this.ttl,
    };
    
    await this.kv.put(key, JSON.stringify(entry), {
      expirationTtl: customTtl || this.ttl,
    });
  }

  async delete(type: string, id: string): Promise<void> {
    const key = this.getCacheKey(type, id);
    await this.kv.delete(key);
  }

  async getEmbedding(text: string): Promise<number[] | null> {
    const hash = await this.hashText(text);
    return this.get<number[]>('embedding', hash);
  }

  async setEmbedding(text: string, embedding: number[]): Promise<void> {
    const hash = await this.hashText(text);
    await this.set('embedding', hash, embedding, this.ttl);
  }

  private async hashText(text: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async invalidatePattern(pattern: string): Promise<void> {
    // KV doesn't support pattern deletion, so we track keys
    // This is a simplified version - in production, consider using a list
    const listKey = `invalidation:${pattern}`;
    const keys = await this.kv.get<string[]>(listKey, 'json') || [];
    
    await Promise.all(keys.map(key => this.kv.delete(key)));
    await this.kv.delete(listKey);
  }
}