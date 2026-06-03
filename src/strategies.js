/**
 * Three classic rate-limiting strategies, each as a small in-memory class with
 * an injectable clock so behavior is deterministic and unit-testable. Each
 * exposes the same `check(key)` contract:
 *
 *   check(key) -> { allowed: boolean, remaining: number, resetMs: number,
 *                   retryAfterMs: number }
 *
 * The Redis-backed equivalents (src/redisStrategies.js) mirror these exactly
 * using atomic Lua so they're correct under concurrency.
 */

/** Fixed window: N requests per window of `windowMs`. Cheap, but allows up to
 * 2N requests across a window boundary (the classic burst problem). */
export class FixedWindow {
  constructor({ limit, windowMs, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.buckets = new Map(); // key -> { windowStart, count }
  }

  check(key) {
    const t = this.now();
    const windowStart = t - (t % this.windowMs);
    let b = this.buckets.get(key);
    if (!b || b.windowStart !== windowStart) {
      b = { windowStart, count: 0 };
      this.buckets.set(key, b);
    }
    const resetMs = windowStart + this.windowMs - t;
    if (b.count < this.limit) {
      b.count++;
      return { allowed: true, remaining: this.limit - b.count, resetMs, retryAfterMs: 0 };
    }
    return { allowed: false, remaining: 0, resetMs, retryAfterMs: resetMs };
  }
}

/** Sliding window log: keep timestamps, drop ones older than `windowMs`.
 * Exact, but O(requests) memory per key. */
export class SlidingWindowLog {
  constructor({ limit, windowMs, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.logs = new Map(); // key -> number[]
  }

  check(key) {
    const t = this.now();
    const cutoff = t - this.windowMs;
    let log = this.logs.get(key);
    if (!log) this.logs.set(key, (log = []));
    // Drop expired timestamps from the front.
    while (log.length && log[0] <= cutoff) log.shift();

    if (log.length < this.limit) {
      log.push(t);
      const resetMs = this.windowMs;
      return { allowed: true, remaining: this.limit - log.length, resetMs, retryAfterMs: 0 };
    }
    const retryAfterMs = log[0] + this.windowMs - t;
    return { allowed: false, remaining: 0, resetMs: retryAfterMs, retryAfterMs };
  }
}

/** Sliding window counter: approximates the log using the current + previous
 * fixed window, weighted by how far we are into the current window. O(1) memory,
 * smooths the fixed-window boundary burst. */
export class SlidingWindowCounter {
  constructor({ limit, windowMs, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.windows = new Map(); // key -> { current, prev, windowStart }
  }

  check(key) {
    const t = this.now();
    const windowStart = t - (t % this.windowMs);
    let w = this.windows.get(key);
    if (!w) this.windows.set(key, (w = { current: 0, prev: 0, windowStart }));

    if (w.windowStart !== windowStart) {
      // How many windows have elapsed; if exactly one, prev = old current.
      w.prev = windowStart - w.windowStart === this.windowMs ? w.current : 0;
      w.current = 0;
      w.windowStart = windowStart;
    }

    const elapsed = t - windowStart;
    const weight = (this.windowMs - elapsed) / this.windowMs; // 1..0
    const estimated = w.prev * weight + w.current;

    if (estimated < this.limit) {
      w.current++;
      return {
        allowed: true,
        remaining: Math.max(0, Math.floor(this.limit - estimated - 1)),
        resetMs: this.windowMs - elapsed,
        retryAfterMs: 0,
      };
    }
    return { allowed: false, remaining: 0, resetMs: this.windowMs - elapsed, retryAfterMs: this.windowMs - elapsed };
  }
}

/** Token bucket: capacity `burst`, refilled at `refillPerSec`. Allows bursts up
 * to capacity while bounding the sustained rate. */
export class TokenBucket {
  constructor({ burst, refillPerSec, now = Date.now }) {
    this.capacity = burst;
    this.refillPerMs = refillPerSec / 1000;
    this.now = now;
    this.buckets = new Map(); // key -> { tokens, last }
  }

  check(key, cost = 1) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { tokens: this.capacity, last: t }));

    // Refill based on elapsed time.
    const refill = (t - b.last) * this.refillPerMs;
    b.tokens = Math.min(this.capacity, b.tokens + refill);
    b.last = t;

    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, remaining: Math.floor(b.tokens), resetMs: 0, retryAfterMs: 0 };
    }
    const deficit = cost - b.tokens;
    const retryAfterMs = Math.ceil(deficit / this.refillPerMs);
    return { allowed: false, remaining: Math.floor(b.tokens), resetMs: retryAfterMs, retryAfterMs };
  }
}

export const STRATEGIES = { FixedWindow, SlidingWindowLog, SlidingWindowCounter, TokenBucket };
