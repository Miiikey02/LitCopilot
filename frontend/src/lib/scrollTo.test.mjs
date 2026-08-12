// Run with: node src/lib/scrollTo.test.mjs   (no test runner required)
//
// This exists because the scroll-to-highlight in 精读模式 broke three times in
// three different disguises, each time because the environment did not deliver
// animation frames. The second case below is the one that matters: it asserts
// the reader still arrives when nothing is painted.

import scrollToOffset from './scrollTo.js'

const mkBox = () => ({ scrollTop: 0, scrollHeight: 10000, clientHeight: 600 })

// --- harness: a controllable clock, rAF and timers -------------------------
function install({ framesDelivered, reducedMotion = false }) {
  let now = 0, rafQ = [], timerQ = [], id = 1
  globalThis.performance = { now: () => now }
  globalThis.requestAnimationFrame = (cb) => { rafQ.push([id, cb]); return id++ }
  globalThis.cancelAnimationFrame = (h) => { rafQ = rafQ.filter(([i]) => i !== h) }
  globalThis.setTimeout = (cb, ms) => { timerQ.push([id, now + ms, cb]); return id++ }
  globalThis.clearTimeout = (h) => { timerQ = timerQ.filter(([i]) => i !== h) }
  globalThis.window = { matchMedia: () => ({ matches: reducedMotion }) }
  return {
    advance(ms, { deliverFrames = framesDelivered } = {}) {
      const end = now + ms
      while (now < end) {
        now = Math.min(now + 16, end)
        if (deliverFrames) { const q = rafQ; rafQ = []; q.forEach(([, cb]) => cb(now)) }
        const due = timerQ.filter(([, at]) => at <= now)
        timerQ = timerQ.filter(([, at]) => at > now)
        due.forEach(([, , cb]) => cb())
      }
    },
  }
}

const results = []
const check = (name, pass, detail) => results.push({ name, pass, detail })

// 1. Normal browser: frames delivered — it should ease, not teleport.
{
  const c = install({ framesDelivered: true }), box = mkBox()
  scrollToOffset(box, 4000)
  c.advance(100)
  const mid = box.scrollTop
  c.advance(600)
  check('animates when frames run', mid > 0 && mid < 4000 && Math.round(box.scrollTop) === 4000,
        `midpoint ${Math.round(mid)}, final ${Math.round(box.scrollTop)}`)
}

// 2. This session's renderer: zero frames — the reader must still arrive.
{
  const c = install({ framesDelivered: false }), box = mkBox()
  scrollToOffset(box, 4000)
  c.advance(200)
  const during = box.scrollTop
  c.advance(600)
  check('lands when no frames run', during === 0 && box.scrollTop === 4000,
        `during ${during}, final ${box.scrollTop}`)
}

// 3. Reduced motion: jump immediately, no animation.
{
  install({ framesDelivered: true, reducedMotion: true })
  const box = mkBox()
  scrollToOffset(box, 4000)
  check('reduced motion jumps at once', box.scrollTop === 4000, `final ${box.scrollTop}`)
}

// 4. Second click mid-flight: the first tween must not fight the second.
{
  const c = install({ framesDelivered: true }), box = mkBox()
  scrollToOffset(box, 4000)
  c.advance(100)
  scrollToOffset(box, 1000)
  c.advance(800)
  check('re-entrant click wins', Math.round(box.scrollTop) === 1000, `final ${Math.round(box.scrollTop)}`)
}

// 5. Target beyond the scrollable range is clamped.
{
  const c = install({ framesDelivered: true }), box = mkBox()
  scrollToOffset(box, 99999)
  c.advance(800)
  check('clamps to max scroll', box.scrollTop === 9400, `final ${box.scrollTop} (max 9400)`)
}

for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(30)} ${r.detail}`)
process.exit(results.every(r => r.pass) ? 0 : 1)
