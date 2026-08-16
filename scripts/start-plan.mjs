/**
 * Works out which setup steps still need doing.
 *
 * Kept apart from running them so the decision can be tested: the failure this
 * guards against is a start script that skips a step because it misread the
 * environment, which surfaces much later as an agent that runs and does
 * nothing.
 */

export const STEPS = {
  setup: {
    id: 'setup',
    label: 'Configurar .env (base de datos y API key)',
    interactive: true,
  },
  migrate: {
    id: 'migrate',
    label: 'Crear o actualizar las tablas',
    interactive: false,
  },
  connect: {
    id: 'connect',
    label: 'Conectar tu cuenta de LinkedIn (se abre Chrome)',
    interactive: true,
  },
  automation: {
    id: 'automation',
    label: 'Crear tu primera automatización',
    interactive: false,
  },
}

/**
 * @param env values already present in .env
 * @param options.hasEnvFile whether .env exists at all
 * @param options.migrated whether the tables are known to be up to date
 */
export function plan(env = {}, { hasEnvFile = true, migrated = false } = {}) {
  const steps = []

  if (!hasEnvFile || !env.DATABASE_URL || !env.ANTHROPIC_API_KEY) {
    steps.push(STEPS.setup)
  }

  // Always, unless something already confirmed it this run: the schema changes
  // between versions and a missing column fails as a query error that says
  // nothing about a migration.
  if (!migrated) steps.push(STEPS.migrate)

  // Both names accepted — an .env written before the rename still counts.
  if (!env.LINKFY_ACCOUNT_ID && !env.DONEFY_ACCOUNT_ID) {
    steps.push(STEPS.connect)
  }

  return steps
}

/** True once everything the agent needs is in place. */
export function isReady(env = {}, options = {}) {
  return plan(env, { ...options, migrated: true }).length === 0
}
