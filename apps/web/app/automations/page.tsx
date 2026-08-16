import { getPanelData } from '@/lib/data'
import { ModePicker, NewAutomation, StatusToggle } from './automation-form'

/**
 * Automations, built from the account's own posts.
 *
 * Pick a post, name the keywords, done. The posts come from the agent's sync —
 * it is already logged in as the owner on their own machine, so reading their
 * own publications needs no browser extension.
 */

export default async function AutomationsPage() {
  const { posts: POSTS, automations, live } = await getPanelData()
  return (
    <div className="p-8">
      <header className="mb-5 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Automatizaciones</h1>
          <p className="text-sm muted">Elegí una publicación y las palabras que la disparan</p>
        </div>
        <NewAutomation live={live} />
      </header>

      {automations.length === 0 && live && (
        // The state where the agent is running and watching nothing. Without
        // saying so, an empty page reads as "still loading" and the agent
        // looks broken while it is working exactly as configured.
        <div className="panel mb-8 rounded-2xl p-5">
          <h2 className="mb-1 text-sm font-semibold">Todavía no hay ninguna automatización</h2>
          <p className="text-xs muted">
            El agente está andando pero no tiene ningún post que vigilar ni ninguna palabra que
            esperar. Creá una y arranca.
          </p>
        </div>
      )}

      <div className="mb-8 grid grid-cols-3 gap-3">
        {automations.map((a) => (
          <div key={a.id} className="panel rounded-2xl p-4">
            <div className="mb-2 flex items-start justify-between gap-2">
              <h2 className="text-sm font-medium">{a.name}</h2>
              <span
                className="shrink-0 rounded-full px-2 py-0.5 text-[10px]"
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

            <div className="flex items-end justify-between gap-3">
              <div className="flex gap-4 text-xs">
                <Metric value={a.postUrls.length} label={a.postUrls.length === 1 ? 'post' : 'posts'} />
                <Metric value={a.enrolled} label="inscriptos" />
                <Metric value={a.booked} label="agendaron" />
              </div>
              <StatusToggle id={a.id} status={a.status} live={live} />
            </div>

            <ModePicker id={a.id} mode={a.mode} live={live} />

            {a.postUrls.length === 0 && (
              <p className="mt-2 text-[11px] muted">Vigila todas tus publicaciones</p>
            )}
            {!a.calendarUrl && (
              // Worth saying: the flow runs to the end and then has nothing to
              // hand over when someone asks for times.
              <p className="mt-2 text-[11px]" style={{ color: 'rgb(251 191 36)' }}>
                Sin link de agenda
              </p>
            )}
          </div>
        ))}
      </div>

      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <div>
            <h2 className="text-sm font-semibold">Tus publicaciones</h2>
            <p className="text-xs muted">Sincronizadas por el agente hace 8 minutos</p>
          </div>
          <p className="text-[11px] muted">Sin extensión de Chrome</p>
        </div>

        <div className="space-y-2">
          {POSTS.map((post) => (
            <div
              key={post.id}
              className="panel flex items-start gap-4 rounded-xl p-4"
              style={post.automation ? { borderLeftWidth: 3, borderLeftColor: 'var(--accent)' } : undefined}
            >
              <div className="min-w-0 flex-1">
                <p className="mb-1.5 line-clamp-2 text-sm leading-snug">{post.excerpt}</p>
                <div className="flex flex-wrap items-center gap-3 text-[11px] muted">
                  <span>{post.postedAt}</span>
                  <span>{post.reactions} reacciones</span>
                  <span>{post.comments} comentarios</span>
                  {post.matched !== undefined && (
                    <span style={{ color: 'var(--accent)' }}>{post.matched} con keyword</span>
                  )}
                </div>
              </div>

              <div className="shrink-0 text-right">
                {post.automation ? (
                  <>
                    <p className="mb-1 text-[11px] muted">Automatizando</p>
                    <p className="text-xs font-medium">{post.automation}</p>
                  </>
                ) : (
                  <button
                    className="rounded-lg border px-3 py-1.5 text-xs transition-colors hover:bg-[var(--accent-soft)]"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    Automatizar
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <p className="mt-6 text-xs muted">
        El constructor visual de flujos llega después. Por ahora los pasos son los del playbook: responder el
        comentario, invitar con nota personalizada, calificar y ofrecer la reunión.
      </p>
    </div>
  )
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <p className="font-semibold">{value}</p>
      <p className="muted">{label}</p>
    </div>
  )
}
