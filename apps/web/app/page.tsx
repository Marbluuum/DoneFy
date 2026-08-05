import Link from 'next/link'

import { FUNNEL, HEALTH, LEADS, STATE_LABELS } from '@/lib/fixtures'

/**
 * Dashboard.
 *
 * The funnel is the point: without conversion between stages there is no way
 * to tell whether any of this works, only that it ran.
 */

export default function DashboardPage() {
  const needsYou = LEADS.filter((l) => l.analysis?.autonomy === 'handoff' || l.unread)

  const steps = [
    { label: 'Comentaron', value: FUNNEL.comments, of: FUNNEL.comments },
    { label: 'Invitaciones', value: FUNNEL.invitesSent, of: FUNNEL.comments },
    { label: 'Aceptaron', value: FUNNEL.invitesAccepted, of: FUNNEL.invitesSent },
    { label: 'Conversaron', value: FUNNEL.conversations, of: FUNNEL.dmsSent },
    { label: 'Agendaron', value: FUNNEL.booked, of: FUNNEL.conversations },
  ]

  return (
    <div className="p-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm muted">Últimos 30 días</p>
      </header>

      <div className="mb-6 grid grid-cols-4 gap-3">
        <Stat label="Comentarios" value={FUNNEL.comments} hint="con keyword" />
        <Stat label="Aceptación" value={`${Math.round(HEALTH.acceptanceRate * 100)}%`} hint="invitaciones" good />
        <Stat label="Conversaciones" value={FUNNEL.conversations} hint="activas o cerradas" />
        <Stat label="Reuniones" value={FUNNEL.booked} hint="agendadas" good />
      </div>

      <section className="panel mb-6 rounded-2xl p-5">
        <h2 className="mb-4 text-sm font-semibold">Embudo</h2>
        <div className="space-y-3">
          {steps.map((s) => {
            const pct = s.of > 0 ? (s.value / s.of) * 100 : 0
            return (
              <div key={s.label}>
                <div className="mb-1 flex items-baseline justify-between text-xs">
                  <span>{s.label}</span>
                  <span className="muted">
                    <span className="font-medium" style={{ color: 'var(--text)' }}>
                      {s.value}
                    </span>{' '}
                    · {Math.round(pct)}%
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--border)' }}>
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'var(--accent)' }} />
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <div className="grid grid-cols-2 gap-4">
        <section className="panel rounded-2xl p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Te esperan</h2>
            <Link href="/inbox" className="text-xs" style={{ color: 'var(--accent)' }}>
              Ver inbox →
            </Link>
          </div>
          <div className="space-y-2">
            {needsYou.map((l) => (
              <Link
                key={l.id}
                href={`/inbox?lead=${l.id}`}
                className="flex items-center justify-between rounded-lg border px-3 py-2 text-xs transition-colors hover:bg-[var(--accent-soft)]"
                style={{ borderColor: 'var(--border)' }}
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{l.name}</p>
                  <p className="truncate muted">{STATE_LABELS[l.state]}</p>
                </div>
                {l.analysis?.autonomy === 'handoff' && (
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ background: 'rgb(244 63 94 / 0.12)', color: 'rgb(225 29 72)' }}>
                    pregunta
                  </span>
                )}
              </Link>
            ))}
          </div>
        </section>

        <section className="panel rounded-2xl p-5">
          <h2 className="mb-3 text-sm font-semibold">Salud de la cuenta</h2>
          <div className="mb-4 flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
            <span className="text-sm font-medium">Saludable</span>
          </div>
          <dl className="space-y-2 text-xs">
            <HealthRow label="Aceptación de invitaciones" value={`${Math.round(HEALTH.acceptanceRate * 100)}%`} note="mínimo 40%" />
            <HealthRow label="Invitaciones esta semana" value={`${HEALTH.invitesThisWeek} / ${HEALTH.invitesCap}`} note="tope propio, bajo el de LinkedIn" />
            <HealthRow label="Pendientes sin responder" value={String(HEALTH.pending)} note="se retiran a los 21 días" />
            <HealthRow label="Acciones fallidas" value={`${Math.round(HEALTH.failureRate * 100)}%`} note="frena todo sobre 15%" />
          </dl>
        </section>
      </div>
    </div>
  )
}

function Stat({ label, value, hint, good }: { label: string; value: string | number; hint: string; good?: boolean }) {
  return (
    <div className="panel rounded-2xl p-4">
      <p className="text-xs muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight" style={good ? { color: 'rgb(16 185 129)' } : undefined}>
        {value}
      </p>
      <p className="text-[11px] muted">{hint}</p>
    </div>
  )
}

function HealthRow({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <dt>{label}</dt>
        <dd className="text-[11px] muted">{note}</dd>
      </div>
      <span className="shrink-0 font-medium">{value}</span>
    </div>
  )
}
