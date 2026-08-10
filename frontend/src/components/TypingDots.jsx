import React from 'react'

// Three pulsing dots shown in a chat bubble while the agent composes a reply,
// so a 10-second wait reads as "working" rather than "stuck".
export default function TypingDots({ className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1 ${className}`} aria-hidden="true">
      <span className="dot h-1.5 w-1.5 rounded-full bg-current" />
      <span className="dot h-1.5 w-1.5 rounded-full bg-current" />
      <span className="dot h-1.5 w-1.5 rounded-full bg-current" />
    </span>
  )
}
