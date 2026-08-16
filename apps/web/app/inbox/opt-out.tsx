'use client'

import { useState, useTransition } from 'react'

import { optOutContact } from '../actions'

/**
 * Never contact this person again.
 *
 * Two clicks, and the second one says what it does in full. Every other
 * control in this panel is reversible; this one is not, and a single click
 * next to "La sigo yo" would eventually be hit by mistake.
 *
 * It is also the one control here that has to keep working when everything
 * else is confusing, so it says plainly what it covers: not just this
 * conversation, but the next post they comment on too.
 */
export function OptOutButton({ enrollmentId, live }: { enrollmentId: string; live: boolean }) {
  const [confirming, setConfirming] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  if (done) {
    return (
      <p className="rounded-lg border px-3 py-2 text-center text-xs muted" style={{ borderColor: 'var(--border)' }}>
        No se le escribe más
      </p>
    )
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="w-full rounded-lg border px-3 py-2 text-xs transition-colors hover:bg-[var(--accent-soft)]"
        style={{ borderColor: 'var(--border)' }}
      >
        No escribirle más
      </button>
    )
  }

  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'rgb(225 29 72 / 0.5)' }}>
      <p className="mb-2 text-xs leading-snug">
        No se le escribe más, ni en esta conversación ni si comenta otro post. No se puede deshacer
        desde acá.
      </p>

      {error && (
        <p className="mb-2 text-[11px]" style={{ color: 'rgb(251 113 133)' }}>
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => {
            setError(null)
            if (!live) {
              setError('Son datos de ejemplo.')
              return
            }
            startTransition(async () => {
              const result = await optOutContact(enrollmentId)
              if (result.ok) setDone(true)
              else setError(result.error)
            })
          }}
          disabled={pending}
          className="flex-1 rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
          style={{ background: 'rgb(225 29 72)' }}
        >
          {pending ? 'Guardando…' : 'Confirmar'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="rounded-lg border px-3 py-1.5 text-xs"
          style={{ borderColor: 'var(--border)' }}
        >
          Cancelar
        </button>
      </div>
    </div>
  )
}
