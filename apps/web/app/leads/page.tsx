import Link from 'next/link'

import { STAGE_LABELS, STATE_LABELS } from '@/lib/fixtures'
import { getPanelData } from '@/lib/data'

export default async function LeadsPage() {
  const { leads: LEADS } = await getPanelData()
  return (
    <div className="p-8">
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Leads</h1>
        <p className="text-sm muted">
          Solo gente que comentó tus publicaciones. Nunca se guardan perfiles que no interactuaron.
        </p>
      </header>

      <div className="panel overflow-hidden rounded-2xl">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-[11px] uppercase tracking-wide muted" style={{ borderColor: 'var(--border)' }}>
              <th className="px-4 py-2.5 font-medium">Persona</th>
              <th className="px-4 py-2.5 font-medium">Keyword</th>
              <th className="px-4 py-2.5 font-medium">Estado</th>
              <th className="px-4 py-2.5 font-medium">Etapa</th>
              <th className="px-4 py-2.5 font-medium">Actividad</th>
            </tr>
          </thead>
          <tbody>
            {LEADS.map((lead) => (
              <tr key={lead.id} className="border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                <td className="px-4 py-3">
                  <Link href={`/inbox?lead=${lead.id}`} className="block">
                    <p className="font-medium">{lead.name}</p>
                    <p className="text-xs muted">{lead.headline}</p>
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <code className="rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--accent-soft)' }}>
                    {lead.keyword}
                  </code>
                </td>
                <td className="px-4 py-3 text-xs">{STATE_LABELS[lead.state] ?? lead.state}</td>
                <td className="px-4 py-3 text-xs muted">{lead.stage ? STAGE_LABELS[lead.stage] : '—'}</td>
                <td className="px-4 py-3 text-xs muted">{lead.lastActivity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
