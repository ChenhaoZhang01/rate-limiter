# Rate Limiter

Three classic rate-limiting strategies — **fixed window**, **sliding window**
(log + counter), and **token bucket** — with an in-memory backend for single
instances and **Redis + Lua** backends for correctness across a cluster. Ships
with Express middleware and a zero-dependency demo server.

![stack](https://img.shields.io/badge/stack-Node.js%20·%20Redis-1f6feb)

## Strategies & trade-offs

| Strategy | Memory | Accuracy | Notes |
|----------|--------|----------|-------|
| **Fixed window** | O(1) | low | Simple, but allows ~2× burst across a boundary |
| **Sliding window log** | O(requests) | exact | Keeps timestamps; precise but memory-heavy |
| **Sliding window counter** | O(1) | high | Weights current + previous window; smooths the boundary burst |
| **Token bucket** | O(1) | exact rate | Allows bursts up to capacity, bounds sustained rate |

Each strategy implements the same contract:

```js
check(key) -> { allowed, remaining, resetMs, retryAfterMs }
```

The in-memory classes take an injectable clock (`now`), so the whole suite is
tested deterministically with **no real waiting**.

## Usage

```js
import { TokenBucket } from "./src/strategies.js";
const limiter = new TokenBucket({ burst: 20, refillPerSec: 5 });
const { allowed, retryAfterMs } = limiter.check("user:42");
```

### Express middleware

```js
import express from "express";
import { SlidingWindowCounter } from "./src/strategies.js";
import { rateLimit } from "./src/middleware.js";

const app = express();
const limiter = new SlidingWindowCounter({ limit: 100, windowMs: 60_000 });
app.use(rateLimit(limiter, { limit: 100 }));   // adds RateLimit-* headers, 429s
```

### Redis (multi-instance, atomic)

```js
import Redis from "ioredis";
import { RedisTokenBucket } from "./src/redisStrategies.js";
const limiter = new RedisTokenBucket(new Redis(), { burst: 20, refillPerSec: 5 });
await limiter.check("user:42");   // read-modify-write in one Lua call
```

Lua runs atomically inside Redis, so concurrent requests across many app
servers can't oversell the limit.

## Demo

```bash
npm run demo
# in another shell, hammer it:
for i in $(seq 1 9); do curl -s -o /dev/null -w "%{http_code} " localhost:3000/; done
# -> 200 200 200 200 200 429 429 429 429   (burst of 5, then throttled)
```

## Tests

```bash
npm test        # node --test, 7 tests, no Redis required
```

Covers per-key isolation, window resets, exact sliding-window expiry, the
counter smoothing the boundary burst, and token-bucket burst + refill + retry.
