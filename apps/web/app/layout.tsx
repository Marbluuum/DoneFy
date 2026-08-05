import type { Metadata } from 'next'
import Link from 'next/link'

import './globals.css'
import { HEALTH, LEADS, MODE } from '@/lib/fixtures'

export const metadata: Metadata = {
  title: 'DoneFy',
  description: 'Automatización inbound de LinkedIn',
}

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/leads', label: 'Leads' },
  { href: '/automations', label: 'Automatizaciones' },
]

const MODE_COPY: Record<string, { label: string; hint: string }> = {
  copilot: { label: 'Copiloto', hint: 'Todo se propone, nada se envía solo' },
  assisted: { label: 'Asistido', hint: 'Preguntas de calificación automáticas' },
  autopilot: { label: 'Automático', hint: 'Todo lo permitido se envía solo' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const unread = LEADS.filter((l) => l.unread).length
  const mode = MODE_COPY[MODE]!

  return (
    <html lang="es">
      <body>
        <div className="flex min-h-screen">
          <aside
            className="flex w-60 shrink-0 flex-col justify-between border-r p-4"
            style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}
          >
            <div>
              <div className="mb-6 flex items-center gap-2 px-2">
                <div
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-sm font-bold text-white"
                  style={{ background: 'var(--accent)' }}
                >
                  D
                </div>
                <span className="text-lg font-semibold tracking-tight">DoneFy</span>
              </div>

              <nav className="space-y-1">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors hover:bg-[var(--accent-soft)]"
                  >
                    <span>{item.label}</span>
                    {item.href === '/inbox' && unread > 0 && (
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[11px] font-semibold text-white"
                        style={{ background: 'var(--accent)' }}
                      >
                        {unread}
                      </span>
                    )}
                  </Link>
                ))}
              </nav>
            </div>

            <div className="space-y-3">
              {/* The panel never touches LinkedIn; this reports the agent on the
                  owner's machine, which is the piece that actually can stop. */}
              <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border)' }}>
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="text-xs font-medium">Agente conectado</span>
                </div>
                <p className="text-[11px] muted">Martin Bufczyk · MacBook</p>
              </div>

              <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border)' }}>
                <p className="text-[11px] uppercase tracking-wide muted">Modo</p>
                <p className="text-sm font-medium">{mode.label}</p>
                <p className="mt-0.5 text-[11px] leading-snug muted">{mode.hint}</p>
              </div>

              <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-baseline justify-between">
                  <p className="text-[11px] uppercase tracking-wide muted">Invitaciones</p>
                  <p className="text-xs font-medium">
                    {HEALTH.invitesThisWeek}/{HEALTH.invitesCap}
                  </p>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--border)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(HEALTH.invitesThisWeek / HEALTH.invitesCap) * 100}%`,
                      background: 'var(--accent)',
                    }}
                  />
                </div>
                <p className="mt-1.5 text-[11px] muted">Aceptación {Math.round(HEALTH.acceptanceRate * 100)}%</p>
              </div>
            </div>
          </aside>

          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </body>
    </html>
  )
}
