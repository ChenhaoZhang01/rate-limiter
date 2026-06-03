/**
 * Demo: an HTTP server (zero dependencies — uses node:http) protected by a
 * token-bucket limiter. Hit it in a loop to watch 200s turn into 429s and then
 * recover as the bucket refills.
 *
 *   node demo/server.js
 *   for i in $(seq 1 15); do curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/; done
 */

import http from "node:http";
import { TokenBucket } from "../src/strategies.js";

const limiter = new TokenBucket({ burst: 5, refillPerSec: 2 });

const server = http.createServer((req, res) => {
  const key = req.socket.remoteAddress || "global";
  const r = limiter.check(key);
  res.setHeader("RateLimit-Remaining", String(Math.max(0, r.remaining)));
  if (!r.allowed) {
    res.setHeader("Retry-After", String(Math.ceil(r.retryAfterMs / 1000)));
    res.writeHead(429, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Too Many Requests", retryAfterMs: r.retryAfterMs }));
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, remaining: r.remaining }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`rate-limited server on http://localhost:${PORT}`));
