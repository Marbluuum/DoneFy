import { getPanelData } from '@/lib/data'

/**
 * Automations, built from the account's own posts.
 *
 * Pick a post, name the keywords, done. The posts come from the agent's sync —
 * it is already logged in as the owner on their own machine, so reading their
 * own publications needs no browser extension.
 */

const AUTOMATIONS = [
  {
    name: 'Empresas de tecnología',
    keywords: ['software', 'sistema'],
    status: 'active' as const,
    posts: 2,
    enrolled: 214,
    booked: 8,
  },
  { name: 'Post CRM', keywords: ['CRM'], status: 'active' as const, posts: 1, enrolled: 98, booked: 3 },
  { name: 'Guía de outbound', keywords: ['guia'], status: 'paused' as const, posts: 0, enrolled: 0, booked: 0 },
]

export default async function AutomationsPage() {
  const { posts: POSTS } = await getPanelData()
  return (
    <div className="p-8">
      <header className="mb-5 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Automatizaciones</h1>
          <p className="text-sm muted">Elegí una publicación y las palabras que la disparan</p>
        </div>
        <button className="rounded-lg px-3 py-2 text-sm font-medium text-white" style={{ background: 'var(--accent)' }}>
          Nueva automatización
        </button>
      </header>

      <div className="mb-8 grid grid-cols-3 gap-3">
        {AUTOMATIONS.map((a) => (
          <div key={a.name} className="panel rounded-2xl p-4">
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

            <div className="flex gap-4 text-xs">
              <Metric value={a.posts} label="posts" />
              <Metric value={a.enrolled} label="inscriptos" />
              <Metric value={a.booked} label="agendaron" />
            </div>
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
