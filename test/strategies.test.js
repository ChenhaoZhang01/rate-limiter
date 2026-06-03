import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FixedWindow,
  SlidingWindowLog,
  SlidingWindowCounter,
  TokenBucket,
} from "../src/strategies.js";

// A controllable clock so tests are deterministic (no real waiting).
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("FixedWindow allows up to the limit then blocks", () => {
  const c = clock();
  const rl = new FixedWindow({ limit: 3, windowMs: 1000, now: c.now });
  assert.equal(rl.check("a").allowed, true);
  assert.equal(rl.check("a").allowed, true);
  assert.equal(rl.check("a").allowed, true);
  assert.equal(rl.check("a").allowed, false); // 4th blocked
});

test("FixedWindow resets after the window", () => {
  const c = clock();
  const rl = new FixedWindow({ limit: 2, windowMs: 1000, now: c.now });
  rl.check("a"); rl.check("a");
  assert.equal(rl.check("a").allowed, false);
  c.advance(1000); // new window
  assert.equal(rl.check("a").allowed, true);
});

test("FixedWindow isolates keys", () => {
  const c = clock();
  const rl = new FixedWindow({ limit: 1, windowMs: 1000, now: c.now });
  assert.equal(rl.check("a").allowed, true);
  assert.equal(rl.check("b").allowed, true); // different key, own budget
  assert.equal(rl.check("a").allowed, false);
});

test("SlidingWindowLog is exact across a rolling window", () => {
  const c = clock();
  const rl = new SlidingWindowLog({ limit: 2, windowMs: 1000, now: c.now });
  assert.equal(rl.check("a").allowed, true); // t=0
  c.advance(500);
  assert.equal(rl.check("a").allowed, true); // t=500
  assert.equal(rl.check("a").allowed, false); // 2 in window
  c.advance(600); // t=1100; first (t=0) now expired
  assert.equal(rl.check("a").allowed, true);
});

test("SlidingWindowCounter smooths the boundary burst", () => {
  const c = clock();
  const rl = new SlidingWindowCounter({ limit: 10, windowMs: 1000, now: c.now });
  for (let i = 0; i < 10; i++) assert.equal(rl.check("a").allowed, true);
  assert.equal(rl.check("a").allowed, false);
  // Immediately into the next window, the weighted prev count still limits us.
  c.advance(1000);
  assert.equal(rl.check("a").allowed, false); // weight ~1 -> prev fills the window
  c.advance(900); // late in the new window, prev weight ~0.1
  assert.equal(rl.check("a").allowed, true);
});

test("TokenBucket allows a burst then refills over time", () => {
  const c = clock();
  const rl = new TokenBucket({ burst: 5, refillPerSec: 1, now: c.now });
  for (let i = 0; i < 5; i++) assert.equal(rl.check("a").allowed, true); // burst
  assert.equal(rl.check("a").allowed, false); // empty
  c.advance(1000); // +1 token
  assert.equal(rl.check("a").allowed, true);
  assert.equal(rl.check("a").allowed, false);
});

test("TokenBucket retryAfter reflects refill rate", () => {
  const c = clock();
  const rl = new TokenBucket({ burst: 1, refillPerSec: 2, now: c.now }); // 1 token / 500ms
  assert.equal(rl.check("a").allowed, true);
  const blocked = rl.check("a");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 500);
});
