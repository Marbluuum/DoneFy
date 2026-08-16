'use client'

import { useState, useTransition } from 'react'

import { createAutomation, setAutomationStatus } from '../actions'

/**
 * Creating an automation, in the panel.
 *
 * It used to be a terminal command with four flags, which is a fine way to
 * describe the shape of the thing and a bad way to ask someone to use it —
 * the rule that decides who gets contacted is the product, not a setup detail.
 *
 * The keyword field carries the warning rather than the help text: an
 * automation with no keyword fires on every comment, and that is the one
 * mistake here with a cost measured in real people.
 */
export function NewAutomation({ live }: { live: boolean }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const [form, setForm] = useState({ name: '', keywords: '', postUrl: '', calendarUrl: '' })
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  function submit() {
    setError(null)
    if (!live) {
      setError('Son datos de ejemplo — conectá tu cuenta primero.')
      return
    }
    startTransition(async () => {
      const result = await createAutomation(form)
      if (result.ok) {
        setForm({ name: '', keywords: '', postUrl: '', calendarUrl: '' })
        setOpen(false)
      } else {
        setError(result.error)
      }
    })
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg px-3 py-2 text-sm font-medium text-white"
        style={{ background: 'var(--accent)' }}
      >
        Nueva automatización
      </button>
    )
  }

  return (
    <div className="panel w-full max-w-lg rounded-2xl p-5">
      <h2 className="mb-1 text-sm font-semibold">Nueva automatización</h2>
      <p className="mb-4 text-xs muted">
        A quien comente la palabra en tu publicación: le doy like, le respondo en público, le mando
        conexión con nota, y cuando acepta arranco la conversación.
      </p>

      <div className="space-y-3">
        <Field
          label="Nombre"
          hint="Sólo para reconocerla acá"
          value={form.name}
          onChange={set('name')}
          placeholder="Empresas de tecnología"
        />
        <Field
          label="Palabra clave"
          hint="La que pedís en el post. Varias, separadas por coma."
          value={form.keywords}
          onChange={set('keywords')}
          placeholder="software, sistema"
        />
        <Field
          label="Publicación"
          hint="Dejalo vacío para vigilar todas tus publicaciones"
          value={form.postUrl}
          onChange={set('postUrl')}
          placeholder="https://www.linkedin.com/feed/update/urn:li:activity:…"
        />
        <Field
          label="Link de tu agenda"
          hint="El que paso cuando piden horarios"
          value={form.calendarUrl}
          onChange={set('calendarUrl')}
          placeholder="https://tu-agenda.com/reunion"
        />
      </div>

      {error && (
        <p className="mt-3 text-[11px]" style={{ color: 'rgb(251 113 133)' }}>
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          onClick={submit}
          disabled={pending}
          className="rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
          style={{ background: 'var(--accent)' }}
        >
          {pending ? 'Creando…' : 'Crear y activar'}
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--border)' }}
        >
          Cancelar
        </button>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string
  hint: string
  value: string
  onChange: (e: { target: { value: string } }) => void
  placeholder: string
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium">{label}</span>
      <input
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
        style={{ borderColor: 'var(--border)' }}
      />
      <span className="mt-1 block text-[11px] muted">{hint}</span>
    </label>
  )
}

/** Pause and resume, per automation. */
export function StatusToggle({
  id,
  status,
  live,
}: {
  id: string
  status: string
  live: boolean
}) {
  const [pending, startTransition] = useTransition()
  const next = status === 'active' ? 'paused' : 'active'

  return (
    <button
      onClick={() => live && startTransition(async () => void (await setAutomationStatus(id, next)))}
      disabled={pending || !live}
      className="rounded-lg border px-2.5 py-1 text-[11px] transition-colors hover:bg-[var(--accent-soft)] disabled:opacity-50"
      style={{ borderColor: 'var(--border)' }}
      // Said out loud because the opposite is the reasonable assumption, and
      // being wrong about it means someone is left mid-conversation.
      title="Pausar frena la entrada de gente nueva. Las conversaciones en curso siguen."
    >
      {status === 'active' ? 'Pausar' : 'Activar'}
    </button>
  )
}
