// Glide a scroll container to an offset, without letting the animation decide
// whether the reader arrives.
//
// Every built-in easing path was verified to leave scrollTop at 0 in a renderer
// that delivers no animation frames — scrollIntoView, scrollTo({behavior}), CSS
// scroll-behavior, and a plain rAF tween all stranded the reader away from the
// sentence they had clicked. So the easing runs on requestAnimationFrame where
// frames exist, and a timer lands the final position where they do not. Timers
// are throttled in those environments but they do fire, so arrival is
// guaranteed either way.

const running = new WeakMap()

const prefersReducedMotion = () =>
  (typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) ||
  false

export default function scrollToOffset(box, to, ms = 480) {
  const target = Math.max(0, Math.min(to, box.scrollHeight - box.clientHeight))

  // A second click mid-flight must not leave two tweens fighting over scrollTop.
  const prev = running.get(box)
  if (prev) {
    cancelAnimationFrame(prev.raf)
    clearTimeout(prev.timer)
    running.delete(box)
  }

  const from = box.scrollTop
  const delta = target - from
  if (Math.abs(delta) < 2 || prefersReducedMotion()) {
    box.scrollTop = target
    return
  }

  const start = performance.now()
  let frames = 0
  const state = { raf: 0, timer: 0 }

  const step = (now) => {
    frames += 1
    const p = Math.min((now - start) / ms, 1)
    box.scrollTop = from + delta * (1 - Math.pow(1 - p, 3)) // ease-out cubic
    if (p < 1) state.raf = requestAnimationFrame(step)
    else running.delete(box)
  }
  state.raf = requestAnimationFrame(step)

  // The safety net: if not one frame arrived, put the reader where they asked
  // to be. Harmless when the animation ran — it has already reached `target`.
  state.timer = setTimeout(() => {
    if (frames === 0) box.scrollTop = target
    running.delete(box)
  }, ms + 120)

  running.set(box, state)
}
