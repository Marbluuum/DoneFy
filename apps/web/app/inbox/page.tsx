import Link from 'next/link'

import { STAGE_LABELS, STATE_LABELS, type FixtureLead } from '@/lib/fixtures'
import { getPanelData } from '@/lib/data'
import { ReplyBar } from './reply-bar'

/**
 * The inbox. The screen this product lives or dies on.
 *
 * Three columns: who is waiting, what was said, and what to do about it. The
 * right-hand column is the difference from every other tool — it shows the
 * orchestrator's read *and why it did not act on its own*, so the quick reply
 * is a decision rather than a button press.
 */

const AUTONOMY_COPY: Record<string, { label: string; tone: string }> = {
  auto: { label: 'Puede enviarse solo', tone: 'text-emerald-600 dark:text-emerald-400' },
  suggest: { label: 'Necesita tu aprobación', tone: 'text-amber-600 dark:text-amber-400' },
  handoff: { label: 'Te toca a vos', tone: 'text-rose-600 dark:text-rose-400' },
}

/**
 * Mirrors `quickReplies()` in @linkfy/core, keyed by the stage being *left*.
 * Wired to the real function once the panel talks to the database.
 */
function quickRepliesFor(stage: string, firstName: string) {
  switch (stage) {
    case 'qualifying_company':
      return [
        { label: 'Preguntar por clientes', body: `${firstName}! estas en la busqueda de mas clientes?`, advances: true },
        { label: 'Preguntar rubro', body: `${firstName}! Que tipo de desarrollo hacen?`, advances: false },
      ]
    case 'qualifying_pain':
      return [
        {
          label: 'Pitch + cierre',
          body: 'Entiendo, nosotros conseguimos clientes mediante un sistema propio y personalizado para empresas de tecnología...si quieres te envío mi calendario para que agendes una reunión? Quieres?',
          advances: true,
        },
        { label: 'Profundizar el dolor', body: `${firstName}! Y hoy como estan consiguiendo clientes?`, advances: false },
      ]
    case 'pitching':
      return [
        { label: 'Mandar calendario', body: 'enbiconsulting.com/agenda-software', advances: true },
        { label: 'Reforzar y cerrar', body: 'Te paso el calendario y coordinamos, te parece?', advances: true },
      ]
    case 'awaiting_booking':
      return [
        { label: 'Reenviar calendario', body: 'enbiconsulting.com/agenda-software', advances: false },
        { label: 'Recordatorio suave', body: `${firstName}! Pudiste ver la agenda?`, advances: false },
      ]
    default:
      return []
  }
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ lead?: string }>
}) {
  const params = await searchParams
  const { leads } = await getPanelData()
  const active = leads.find((l) => l.id === params.lead) ?? leads[0]

  // Before the first lead arrives this page has nothing to show, and rendering
  // an empty three-column shell reads like something is broken.
  if (!active) {
    return (
      <div className="flex h-screen items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <h1 className="mb-2 text-lg font-semibold">Todavía no hay conversaciones</h1>
          <p className="text-sm muted">
            Cuando alguien comente la palabra clave en uno de tus posts, va a aparecer acá.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen">
      <ConversationList leads={leads} activeId={active.id} />
      <Thread lead={active} />
      <SidePanel lead={active} />
    </div>
  )
}

function ConversationList({ leads: LEADS, activeId }: { leads: FixtureLead[]; activeId: string }) {
  return (
    <div
      className="flex w-80 shrink-0 flex-col border-r"
      style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}
    >
      <div className="border-b px-4 py-3.5" style={{ borderColor: 'var(--border)' }}>
        <h1 className="text-sm font-semibold">Inbox</h1>
        <p className="text-[11px] muted">{LEADS.filter((l) => l.unread).length} esperando respuesta</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {LEADS.map((lead) => {
          const isActive = lead.id === activeId
          return (
            <Link
              key={lead.id}
              href={`/inbox?lead=${lead.id}`}
              className="block border-b px-4 py-3 transition-colors"
              style={{
                borderColor: 'var(--border)',
                background: isActive ? 'var(--accent-soft)' : undefined,
              }}
            >
              <div className="flex items-start gap-3">
                <Avatar initials={lead.avatarInitials} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-sm font-medium">{lead.name}</p>
                    <span className="shrink-0 text-[10px] muted">{lead.lastActivity}</span>
                  </div>
                  <p className="truncate text-xs muted">{lead.headline}</p>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <StateBadge state={lead.state} />
                    {lead.unread && <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />}
                  </div>
                </div>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}

function Thread({ lead }: { lead: FixtureLead }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div
        className="flex items-center justify-between border-b px-6 py-3"
        style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-3">
          <Avatar initials={lead.avatarInitials} />
          <div>
            <p className="text-sm font-medium">
              {lead.name} <span className="text-[11px] muted">· {lead.degree}er</span>
            </p>
            <p className="text-xs muted">{lead.headline}</p>
          </div>
        </div>
        {lead.stage && (
          <span className="rounded-full px-2.5 py-1 text-[11px]" style={{ background: 'var(--accent-soft)' }}>
            {STAGE_LABELS[lead.stage] ?? lead.stage}
          </span>
        )}
      </div>

      {/* Why this person is here at all. Without it the thread reads as cold
          outreach, which is precisely what it is not. */}
      <div className="border-b px-6 py-2.5 text-xs" style={{ borderColor: 'var(--border)' }}>
        <span className="muted">Comentó </span>
        <span className="font-medium" style={{ color: 'var(--accent)' }}>
          “{lead.comment}”
        </span>
        <span className="muted"> en “{lead.postExcerpt}”</span>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
        {lead.messages.map((m, i) => (
          <div key={i} className={m.from === 'owner' ? 'flex justify-end' : 'flex justify-start'}>
            <div className="max-w-[75%]">
              <div className="mb-1 flex items-center gap-2 text-[10px] muted">
                <span>{m.from === 'owner' ? 'Vos' : lead.name}</span>
                <span>·</span>
                <span>{m.at}</span>
                <ChannelTag channel={m.channel} />
                {m.generated && (
                  <span className="rounded px-1 py-px" style={{ background: 'var(--accent-soft)' }}>
                    IA
                  </span>
                )}
              </div>
              <div
                className="whitespace-pre-line rounded-2xl px-3.5 py-2.5 text-sm"
                style={
                  m.from === 'owner'
                    ? { background: 'var(--accent)', color: '#fff' }
                    : { background: 'var(--panel)', border: '1px solid var(--border)' }
                }
              >
                {m.body}
              </div>
            </div>
          </div>
        ))}
      </div>

      <QuickReplyBar lead={lead} />
    </div>
  )
}

function QuickReplyBar({ lead }: { lead: FixtureLead }) {
  const firstName = lead.name.split(' ')[0]!
  // The agent's own proposals win: they were produced by the playbook against
  // this exact conversation, while the local list is a mirror for the fixtures.
  const replies =
    lead.quickReplies && lead.quickReplies.length > 0
      ? lead.quickReplies
      : lead.stage
        ? quickRepliesFor(lead.stage, firstName)
        : []
  const blocked = lead.analysis?.autonomy === 'handoff'

  return (
    <ReplyBar
      replies={replies}
      blockedReason={blocked ? lead.analysis?.notes[0] : undefined}
      // Only the playbook decides this. The pitch is never auto-sendable.
      autoAllowed={lead.stage === 'qualifying_company' || lead.stage === 'awaiting_booking'}
    />
  )
}

function SidePanel({ lead }: { lead: FixtureLead }) {
  const a = lead.analysis

  return (
    <div
      className="w-80 shrink-0 space-y-4 overflow-y-auto border-l p-4"
      style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}
    >
      <section>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide muted">Lectura del agente</h2>
        {a ? (
          <div className="space-y-3 rounded-xl border p-3" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center justify-between">
              <span className="rounded px-1.5 py-0.5 font-mono text-[11px]" style={{ background: 'var(--accent-soft)' }}>
                {a.intent}
              </span>
              <span className="text-[11px] muted">{Math.round(a.confidence * 100)}% confianza</span>
            </div>

            <p className="text-xs leading-relaxed">{a.rationale}</p>

            <div className="border-t pt-2" style={{ borderColor: 'var(--border)' }}>
              <p className={`text-xs font-medium ${AUTONOMY_COPY[a.autonomy]?.tone}`}>
                {AUTONOMY_COPY[a.autonomy]?.label}
              </p>
              {/* The panel explains restraint, not just action. Silence with no
                  reason attached is what makes people stop trusting the tool. */}
              {a.notes.map((n) => (
                <p key={n} className="mt-1 text-[11px] leading-snug muted">
                  {n}
                </p>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs muted">Todavía no respondió.</p>
        )}
      </section>

      {a && (a.signals.company || a.signals.pain) && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide muted">Lo que contó</h2>
          <div className="space-y-2">
            {a.signals.company && <Signal label="Empresa" value={a.signals.company} />}
            {a.signals.pain && <Signal label="Dolor" value={a.signals.pain} />}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide muted">Estado</h2>
        <dl className="space-y-1.5 text-xs">
          <Row label="Secuencia" value={STATE_LABELS[lead.state] ?? lead.state} />
          {lead.stage && <Row label="Etapa" value={STAGE_LABELS[lead.stage] ?? lead.stage} />}
          <Row label="Keyword" value={lead.keyword} />
          <Row label="Grado" value={`${lead.degree}er`} />
          {lead.company && <Row label="Empresa" value={lead.company} />}
        </dl>
      </section>

      <button
        className="w-full rounded-lg border px-3 py-2 text-xs transition-colors hover:bg-[var(--accent-soft)]"
        style={{ borderColor: 'var(--border)' }}
      >
        Pausar automatización
      </button>
    </div>
  )
}

function Signal({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border-l-2 px-2.5 py-1.5" style={{ borderColor: 'var(--accent)', background: 'var(--accent-soft)' }}>
      <p className="text-[10px] uppercase tracking-wide muted">{label}</p>
      <p className="text-xs leading-snug">“{value}”</p>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="muted">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  )
}

function Avatar({ initials }: { initials: string }) {
  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
      style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
    >
      {initials}
    </div>
  )
}

function StateBadge({ state }: { state: string }) {
  const urgent = state === 'handed_off'
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px]"
      style={
        urgent
          ? { background: 'rgb(244 63 94 / 0.12)', color: 'rgb(225 29 72)' }
          : { background: 'var(--accent-soft)', color: 'var(--text-muted)' }
      }
    >
      {STATE_LABELS[state] ?? state}
    </span>
  )
}

function ChannelTag({ channel }: { channel: string }) {
  const label = channel === 'comment_reply' ? 'comentario' : channel === 'invite_note' ? 'nota invitación' : 'DM'
  return <span className="rounded px-1 py-px" style={{ background: 'var(--border)' }}>{label}</span>
}
