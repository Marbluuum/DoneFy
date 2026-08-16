'use client'

import { useState, useTransition } from 'react'

import { sendReply, setAutoReply, takeOver } from '../actions'

/**
 * The reply bar.
 *
 * First pass put the quick replies in small pill buttons above the input, and
 * they read as decoration — the owner did not find them. They are the primary
 * action on this screen, so they get the weight: full-width cards showing the
 * exact text that will be sent, with the step that advances the playbook marked
 * as the default.
 *
 * Showing the message body rather than just a label is the point. Approving
 * "Pitch + cierre" without seeing the words is a click; reading them first is
 * a decision.
 */

export type Reply = { label: string; body: string; advances: boolean }

export function ReplyBar({
  enrollmentId,
  replies,
  blockedReason,
  autoAllowed,
  autoOn,
  live,
}: {
  enrollmentId: string
  replies: Reply[]
  blockedReason?: string
  /** Whether the playbook would let this step send unattended. */
  autoAllowed: boolean
  /** Whether this conversation is already on unattended replying. */
  autoOn: boolean
  /** False when the panel is showing fixtures; nothing can be sent then. */
  live: boolean
}) {
  const [autoSend, setAutoSend] = useState(autoOn)
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [pending, startTransition] = useTransition()

  // Nothing is sent from here: the click queues the message and the agent on
  // the laptop delivers it. So the button reports "queued", not "sent" — the
  // difference is visible when the agent is off, and saying "sent" then would
  // be a lie the owner only discovers from the lead's silence.
  function queue(body: string) {
    setError(null)
    startTransition(async () => {
      const result = live
        ? await sendReply(enrollmentId, body)
        : ({ ok: false, error: 'Son datos de ejemplo — conectá tu cuenta con `npm run init`.' } as const)
      if (result.ok) setSent(true)
      else setError(result.error)
    })
  }

  function toggleAuto(next: boolean) {
    setAutoSend(next)
    if (!live) return
    startTransition(async () => {
      const result = await setAutoReply(enrollmentId, next)
      if (!result.ok) {
        setAutoSend(!next)
        setError(result.error)
      }
    })
  }

  if (blockedReason) {
    return (
      <div className="border-t px-6 py-4" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
        <div
          className="mb-3 flex items-start gap-2.5 rounded-xl border-l-2 px-3.5 py-3"
          style={{ borderColor: 'rgb(225 29 72)', background: 'rgb(244 63 94 / 0.06)' }}
        >
          <span className="mt-0.5 text-sm">✋</span>
          <div>
            <p className="text-sm font-medium">Esta la respondés vos</p>
            <p className="text-xs muted">{blockedReason}</p>
          </div>
        </div>
        <Composer onSend={queue} pending={pending} />
      </div>
    )
  }

  return (
    <div className="border-t px-6 py-4" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
      {replies.length > 0 && (
        <>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wide muted">Respuestas sugeridas</p>

            {/* Per-conversation autopilot. The global mode sets the ceiling;
                this lets a single thread run on its own without loosening
                anything else. */}
            <label
              className="flex cursor-pointer items-center gap-2 text-[11px]"
              style={{ opacity: autoAllowed ? 1 : 0.45 }}
              title={
                autoAllowed
                  ? 'El agente envía la respuesta sugerida sin esperarte'
                  : 'Este paso siempre necesita tu aprobación'
              }
            >
              <span className="muted">Que responda solo</span>
              <button
                type="button"
                disabled={!autoAllowed}
                onClick={() => toggleAuto(!autoSend)}
                className="relative h-4 w-7 rounded-full transition-colors"
                style={{ background: autoSend && autoAllowed ? 'var(--accent)' : 'var(--border)' }}
              >
                <span
                  className="absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform"
                  style={{ transform: autoSend && autoAllowed ? 'translateX(14px)' : 'translateX(2px)' }}
                />
              </button>
            </label>
          </div>

          <div className="mb-3 space-y-2">
            {replies.map((r, i) => {
              const isSelected = i === selected
              return (
                <button
                  key={r.label}
                  onClick={() => setSelected(i)}
                  className="flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors"
                  style={{
                    borderColor: isSelected ? 'var(--accent)' : 'var(--border)',
                    background: isSelected ? 'var(--accent-soft)' : 'transparent',
                  }}
                >
                  <span
                    className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border"
                    style={{ borderColor: isSelected ? 'var(--accent)' : 'var(--border)' }}
                  >
                    {isSelected && <span className="h-2 w-2 rounded-full" style={{ background: 'var(--accent)' }} />}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="mb-1 flex items-center gap-2">
                      <span className="text-xs font-semibold">{r.label}</span>
                      {r.advances && (
                        <span className="rounded px-1.5 py-px text-[10px]" style={{ background: 'var(--border)' }}>
                          avanza la etapa
                        </span>
                      )}
                    </span>
                    {/* The words, not just the label. */}
                    <span className="block text-xs leading-snug muted">{r.body}</span>
                  </span>
                </button>
              )
            })}
          </div>

          <div className="mb-3 flex gap-2">
            <button
              onClick={() => queue(replies[selected]?.body ?? '')}
              disabled={pending || sent}
              className="flex-1 rounded-xl px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
              style={{ background: 'var(--accent)' }}
            >
              {sent ? 'En cola ✓' : pending ? 'Encolando…' : 'Enviar esta respuesta'}
            </button>
            <button
              onClick={() => live && startTransition(async () => void (await takeOver(enrollmentId)))}
              disabled={pending}
              className="rounded-xl border px-4 py-2.5 text-sm transition-colors hover:bg-[var(--accent-soft)] disabled:opacity-60"
              style={{ borderColor: 'var(--border)' }}
              title="El agente deja de proponer y la conversación queda tuya"
            >
              La sigo yo
            </button>
          </div>

          {sent && (
            <p className="mb-3 text-[11px] muted">
              El agente la envía en su próximo ciclo. Si está apagado, queda esperando.
            </p>
          )}
          {error && (
            <p className="mb-3 text-[11px]" style={{ color: 'rgb(251 113 133)' }}>
              {error}
            </p>
          )}
        </>
      )}

      <Composer onSend={queue} pending={pending} />
    </div>
  )
}

function Composer({ onSend, pending }: { onSend: (body: string) => void; pending: boolean }) {
  const [text, setText] = useState('')

  return (
    <div className="flex items-end gap-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="…o escribí la tuya"
        rows={1}
        className="flex-1 resize-none rounded-xl border bg-transparent px-3 py-2 text-sm outline-none"
        style={{ borderColor: 'var(--border)' }}
      />
      <button
        onClick={() => {
          if (!text.trim()) return
          onSend(text)
          setText('')
        }}
        disabled={pending || !text.trim()}
        className="rounded-xl border px-4 py-2 text-sm transition-colors hover:bg-[var(--accent-soft)] disabled:opacity-50"
        style={{ borderColor: 'var(--border)' }}
      >
        Enviar
      </button>
    </div>
  )
}
