'use client'

import { useState, useTransition } from 'react'

import { createAutomation, setAutomationMode, setAutomationStatus } from '../actions'

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
export function NewAutomation({
  live,
  posts = [],
  initialPostUrl,
}: {
  live: boolean
  /** The account's own posts, so the trigger is picked rather than pasted. */
  posts?: Array<{ id: string; url?: string; excerpt: string; postedAt: string }>
  initialPostUrl?: string
}) {
  const [open, setOpen] = useState(Boolean(initialPostUrl))

  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const [form, setForm] = useState({
    name: '',
    keywords: '',
    postUrl: initialPostUrl ?? '',
    calendarUrl: '',
  })
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
        <div>
          <span className="mb-1 block text-xs font-medium">Publicación</span>

          {/* Picked from what the agent already read, because pasting an
              activity URL is the one step here that fails silently: a wrong
              copy watches a post that does not exist and never fires. */}
          {posts.length > 0 ? (
            <select
              value={form.postUrl}
              onChange={set('postUrl')}
              className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
              style={{ borderColor: 'var(--border)' }}
            >
              <option value="">Todas mis publicaciones</option>
              {posts.map((post) => (
                <option key={post.id} value={post.url ?? ''}>
                  {post.excerpt.slice(0, 70)}
                  {post.excerpt.length > 70 ? '…' : ''} · {post.postedAt}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={form.postUrl}
              onChange={set('postUrl')}
              placeholder="https://www.linkedin.com/feed/update/urn:li:activity:…"
              className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
              style={{ borderColor: 'var(--border)' }}
            />
          )}

          <span className="mt-1 block text-[11px] muted">
            {posts.length > 0
              ? 'Sincronizadas por el agente'
              : 'Todavía no leí tus publicaciones — pegá la URL o esperá al próximo ciclo del agente'}
          </span>
        </div>
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


const MODE_COPY: Record<string, { label: string; hint: string }> = {
  copilot: { label: 'Copiloto', hint: 'Te propone todo, no manda nada solo' },
  assisted: { label: 'Asistido', hint: 'Las preguntas de calificación salen solas' },
  autopilot: { label: 'Automático', hint: 'Todo lo permitido sale sin esperarte' },
}

/**
 * Autonomy, per automation.
 *
 * Shown as three named choices rather than a switch, because "on" and "off" is
 * not what the setting does — the middle one is where most of this belongs and
 * a two-state control has nowhere to put it.
 */
export function ModePicker({ id, mode, live }: { id: string; mode: string; live: boolean }) {
  const [current, setCurrent] = useState(mode)
  const [pending, startTransition] = useTransition()

  function choose(next: string) {
    const previous = current
    setCurrent(next)
    if (!live) return
    startTransition(async () => {
      const result = await setAutomationMode(id, next)
      if (!result.ok) setCurrent(previous)
    })
  }

  return (
    <div className="mt-3">
      <div className="flex gap-1">
        {Object.entries(MODE_COPY).map(([key, copy]) => (
          <button
            key={key}
            onClick={() => choose(key)}
            disabled={pending || !live}
            title={copy.hint}
            className="flex-1 rounded-lg border px-2 py-1 text-[11px] transition-colors disabled:opacity-60"
            style={{
              borderColor: current === key ? 'var(--accent)' : 'var(--border)',
              background: current === key ? 'var(--accent-soft)' : 'transparent',
            }}
          >
            {copy.label}
          </button>
        ))}
      </div>
      <p className="mt-1 text-[11px] muted">{MODE_COPY[current]?.hint}</p>
      {current === 'autopilot' && (
        // Worth saying at the moment of choosing, because "automatic" sounds
        // like it means everything, and the one message where being wrong
        // costs the lead is the one it never sends.
        <p className="mt-1 text-[11px] muted">La reunión te la sigue proponiendo a vos.</p>
      )}
    </div>
  )
}
