'use client'

import { useState } from 'react'

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
  replies,
  blockedReason,
  autoAllowed,
}: {
  replies: Reply[]
  blockedReason?: string
  /** Whether the playbook would let this step send unattended. */
  autoAllowed: boolean
}) {
  const [autoSend, setAutoSend] = useState(false)
  const [selected, setSelected] = useState(0)

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
        <Composer />
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
                onClick={() => setAutoSend((v) => !v)}
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
              className="flex-1 rounded-xl px-4 py-2.5 text-sm font-medium text-white"
              style={{ background: 'var(--accent)' }}
            >
              {autoSend && autoAllowed ? 'Programar envío' : 'Enviar esta respuesta'}
            </button>
            <button
              className="rounded-xl border px-4 py-2.5 text-sm transition-colors hover:bg-[var(--accent-soft)]"
              style={{ borderColor: 'var(--border)' }}
            >
              Editar
            </button>
          </div>
        </>
      )}

      <Composer />
    </div>
  )
}

function Composer() {
  return (
    <div className="flex items-end gap-2">
      <div className="flex-1 rounded-xl border px-3 py-2 text-sm muted" style={{ borderColor: 'var(--border)' }}>
        …o escribí la tuya
      </div>
      <button
        className="rounded-xl border px-4 py-2 text-sm transition-colors hover:bg-[var(--accent-soft)]"
        style={{ borderColor: 'var(--border)' }}
      >
        Enviar
      </button>
    </div>
  )
}
