import Link from 'next/link'

import { type FixtureLead } from '@/lib/fixtures'
import { getPanelData } from '@/lib/data'

/**
 * Pipeline.
 *
 * Grouped by what is happening to the lead, not by internal state name. The
 * engine has fifteen states; a person watching their funnel needs five. The
 * mapping below is the translation, and "Te toca a vos" gets its own column
 * because those are the ones that go cold while nobody is looking.
 */

const COLUMNS: Array<{
  id: string
  title: string
  hint: string
  states: string[]
  accent?: string
}> = [
  {
    id: 'reached',
    title: 'Contactados',
    hint: 'Comentaron y ya les respondí',
    states: ['detected', 'comment_replied', 'invite_queued'],
  },
  {
    id: 'invited',
    title: 'Invitación enviada',
    hint: 'Esperando que acepten',
    states: ['invite_sent'],
  },
  {
    id: 'messaged',
    title: 'DM enviado',
    hint: 'Esperando que respondan',
    states: ['connected', 'dm_sent', 'followup_1_sent', 'followup_2_sent'],
  },
  {
    id: 'talking',
    title: 'Conversando',
    hint: 'El agente está calificando',
    states: ['replied'],
    accent: 'rgb(16 185 129)',
  },
  {
    id: 'yours',
    title: 'Te toca a vos',
    hint: 'Frenado a propósito',
    states: ['handed_off'],
    accent: 'rgb(225 29 72)',
  },
  {
    id: 'closed',
    title: 'Cerrados',
    hint: 'Agendaron o quedaron afuera',
    states: ['booked', 'disqualified', 'closed', 'invite_expired', 'opted_out'],
  },
]

export default async function PipelinePage() {
  const { leads: LEADS } = await getPanelData()
  return (
    <div className="flex h-screen flex-col p-8">
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Pipeline</h1>
        <p className="text-sm muted">Dónde está parado cada lead ahora mismo</p>
      </header>

      <div className="flex flex-1 gap-3 overflow-x-auto pb-2">
        {COLUMNS.map((col) => {
          const leads = LEADS.filter((l) => col.states.includes(l.state))
          return (
            <div key={col.id} className="flex w-64 shrink-0 flex-col">
              <div className="mb-2 px-1">
                <div className="flex items-center gap-2">
                  {col.accent && <span className="h-2 w-2 rounded-full" style={{ background: col.accent }} />}
                  <h2 className="text-sm font-semibold">{col.title}</h2>
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                    style={{ background: 'var(--border)' }}
                  >
                    {leads.length}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] muted">{col.hint}</p>
              </div>

              <div
                className="flex-1 space-y-2 rounded-xl p-2"
                style={{ background: 'color-mix(in srgb, var(--border) 40%, transparent)' }}
              >
                {leads.map((lead) => (
                  <Card key={lead.id} lead={lead} accent={col.accent} />
                ))}
                {leads.length === 0 && (
                  <p className="px-2 py-6 text-center text-[11px] muted">Nadie acá</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Card({ lead, accent }: { lead: FixtureLead; accent?: string }) {
  return (
    <Link
      href={`/inbox?lead=${lead.id}`}
      className="block rounded-xl border p-3 transition-shadow hover:shadow-sm"
      style={{
        background: 'var(--panel)',
        borderColor: 'var(--border)',
        borderLeftWidth: accent ? 3 : 1,
        borderLeftColor: accent ?? 'var(--border)',
      }}
    >
      <div className="mb-1.5 flex items-start gap-2">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          {lead.avatarInitials}
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">{lead.name}</p>
          <p className="truncate text-[10px] muted">{lead.headline}</p>
        </div>
      </div>

      {/* The lead's own words about their problem — the single most useful
          thing to see when scanning a board. */}
      {lead.analysis?.signals.pain && (
        <p
          className="mb-1.5 rounded border-l-2 px-1.5 py-1 text-[10px] leading-snug"
          style={{ borderColor: 'var(--accent)', background: 'var(--accent-soft)' }}
        >
          “{lead.analysis.signals.pain}”
        </p>
      )}

      <div className="flex items-center justify-between text-[10px] muted">
        <code className="rounded px-1 py-px" style={{ background: 'var(--border)' }}>
          {lead.keyword}
        </code>
        <span>{lead.lastActivity}</span>
      </div>
    </Link>
  )
}
