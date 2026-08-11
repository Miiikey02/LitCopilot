import React, { useEffect, useRef, useState } from 'react'

// Animates a real number counting up when it first appears. Only ever used on
// values the backend actually returned — never to imply progress we don't know.
export default function CountUp({ value, duration = 700, className = '' }) {
  const [shown, setShown] = useState(0)
  const raf = useRef()

  useEffect(() => {
    const target = Number(value) || 0
    if (target === 0) {
      setShown(0)
      return
    }
    const start = performance.now()
    const tick = (now) => {
      const p = Math.min((now - start) / duration, 1)
      // Ease-out so it decelerates into the final value.
      setShown(Math.round(target * (1 - Math.pow(1 - p, 3))))
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [value, duration])

  return <span className={className}>{shown}</span>
}
