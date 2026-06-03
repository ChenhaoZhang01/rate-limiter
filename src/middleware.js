/**
 * Express middleware wrapping any limiter that exposes `check(key)` (sync or
 * async). Adds standard RateLimit-* headers and returns 429 with Retry-After
 * when the limit is exceeded.
 */

export function rateLimit(limiter, { keyGen, limit } = {}) {
  const getKey = keyGen || ((req) => req.ip || req.socket?.remoteAddress || "global");
  return async function (req, res, next) {
    try {
      const r = await limiter.check(getKey(req));
      if (limit != null) res.setHeader("RateLimit-Limit", String(limit));
      res.setHeader("RateLimit-Remaining", String(Math.max(0, r.remaining)));
      res.setHeader("RateLimit-Reset", String(Math.ceil(r.resetMs / 1000)));
      if (r.allowed) return next();
      res.setHeader("Retry-After", String(Math.ceil(r.retryAfterMs / 1000)));
      res.status(429).json({ error: "Too Many Requests", retryAfterMs: r.retryAfterMs });
    } catch (e) {
      // Fail open: if the limiter backend is down, don't take the app down.
      next();
    }
  };
}
