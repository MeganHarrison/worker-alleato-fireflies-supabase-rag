// Rate limiting service

import { RateLimitInfo } from '../types';

export class RateLimiter {
  constructor(
    private kv: KVNamespace,
    private maxRequests: number,
    private windowSeconds: number
  ) {}

  async checkLimit(identifier: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const key = `ratelimit:${identifier}`;
    const now = Date.now();
    const windowStart = now - (this.windowSeconds * 1000);
    
    // Get current rate limit info
    const info = await this.kv.get<RateLimitInfo>(key, 'json');
    
    if (!info || info.resetTime < now) {
      // Create new window
      const newInfo: RateLimitInfo = {
        key: identifier,
        requests: 1,
        resetTime: now + (this.windowSeconds * 1000),
      };
      
      await this.kv.put(key, JSON.stringify(newInfo), {
        expirationTtl: this.windowSeconds,
      });
      
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetAt: newInfo.resetTime,
      };
    }
    
    // Check if limit exceeded
    if (info.requests >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: info.resetTime,
      };
    }
    
    // Increment counter
    info.requests++;
    await this.kv.put(key, JSON.stringify(info), {
      expirationTtl: Math.max(60, Math.ceil((info.resetTime - now) / 1000)),
    });
    
    return {
      allowed: true,
      remaining: this.maxRequests - info.requests,
      resetAt: info.resetTime,
    };
  }

  async reset(identifier: string): Promise<void> {
    const key = `ratelimit:${identifier}`;
    await this.kv.delete(key);
  }

  getHeaders(result: { allowed: boolean; remaining: number; resetAt: number }): Record<string, string> {
    return {
      'X-RateLimit-Limit': this.maxRequests.toString(),
      'X-RateLimit-Remaining': result.remaining.toString(),
      'X-RateLimit-Reset': result.resetAt.toString(),
    };
  }
}