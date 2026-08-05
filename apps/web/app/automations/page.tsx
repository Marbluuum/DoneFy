const AUTOMATIONS = [
  {
    name: 'Empresas de tecnología',
    keywords: ['software', 'sistema'],
    status: 'active',
    enrolled: 214,
    booked: 8,
  },
  { name: 'Post CRM', keywords: ['CRM'], status: 'active', enrolled: 98, booked: 3 },
  { name: 'Guía de outbound', keywords: ['guia'], status: 'paused', enrolled: 0, booked: 0 },
]

export default function AutomationsPage() {
  return (
    <div className="p-8">
      <header className="mb-5 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Automatizaciones</h1>
          <p className="text-sm muted">Una keyword dispara un flujo</p>
        </div>
        <button className="rounded-lg px-3 py-2 text-sm font-medium text-white" style={{ background: 'var(--accent)' }}>
          Nueva
        </button>
      </header>

      <div className="grid grid-cols-3 gap-3">
        {AUTOMATIONS.map((a) => (
          <div key={a.name} className="panel rounded-2xl p-4">
            <div className="mb-2 flex items-start justify-between">
              <h2 className="text-sm font-medium">{a.name}</h2>
              <span
                className="rounded-full px-2 py-0.5 text-[10px]"
                style={
                  a.status === 'active'
                    ? { background: 'rgb(16 185 129 / 0.12)', color: 'rgb(5 150 105)' }
                    : { background: 'var(--border)', color: 'var(--text-muted)' }
                }
              >
                {a.status === 'active' ? 'activa' : 'pausada'}
              </span>
            </div>

            <div className="mb-3 flex flex-wrap gap-1">
              {a.keywords.map((k) => (
                <code key={k} className="rounded px-1.5 py-0.5 text-[11px]" style={{ background: 'var(--accent-soft)' }}>
                  {k}
                </code>
              ))}
            </div>

            <div className="flex gap-4 text-xs">
              <div>
                <p className="font-semibold">{a.enrolled}</p>
                <p className="muted">inscriptos</p>
              </div>
              <div>
                <p className="font-semibold">{a.booked}</p>
                <p className="muted">agendaron</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-4 text-xs muted">
        El constructor visual de flujos llega después. Por ahora los pasos son los del playbook.
      </p>
    </div>
  )
}
