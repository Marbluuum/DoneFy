/**
 * Validation for the setup answers, kept apart from the prompting so it can be
 * tested. Each returns an error string, or null when the value is fine.
 */

export function validateDatabaseUrl(value) {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return 'Hace falta un valor.'
  if (!trimmed.startsWith('postgres')) return 'Tiene que empezar con postgresql://'
  // The single most common mistake: pasting Supabase's URI without substituting
  // the placeholder, which otherwise fails much later as an auth error that
  // says nothing about the real cause.
  if (/\[(YOUR-)?PASSWORD\]/i.test(trimmed)) {
    return 'Todavía dice [YOUR-PASSWORD] — reemplazalo por tu contraseña real (los corchetes también).'
  }
  if (!trimmed.includes('@')) return 'No parece una URL de conexión completa.'
  // Supabase's "Direct connection" host only has an AAAA record unless the
  // IPv4 add-on is paid for, so on a home connection it fails as ENOTFOUND —
  // an error that looks like the project does not exist. The pooler host
  // resolves over IPv4 and is what this project wants anyway.
  if (/@db\.[a-z0-9]+\.supabase\.co/i.test(trimmed)) {
    return (
      'Esa es la "Direct connection" y no resuelve por IPv4.\n' +
      '      En Supabase → Connect → elegí "Session pooler".\n' +
      '      El host termina en .pooler.supabase.com'
    )
  }
  return null
}

export function validateAnthropicKey(value) {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return 'Hace falta un valor.'
  if (!trimmed.startsWith('sk-ant-')) return 'Las keys de Anthropic empiezan con sk-ant-'
  if (trimmed.length < 20) return 'La key parece incompleta.'
  return null
}

/** Parses an existing .env so a re-run preserves settings that are not asked about. */
export function parseEnv(contents) {
  const values = {}
  for (const line of (contents ?? '').split('\n')) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/)
    if (match) values[match[1]] = match[2]
  }
  return values
}

export function renderEnv({ databaseUrl, anthropicKey, existing = {} }) {
  return `# Generado por \`npm run setup\`. Podés editarlo a mano si preferís.

# --- Base de datos (Supabase) ---
DATABASE_URL="${databaseUrl}"

# --- Agente ---
CHROME_PROFILE_PATH="${existing.CHROME_PROFILE_PATH || './.chrome-profile'}"
CHROME_EXECUTABLE_PATH="${existing.CHROME_EXECUTABLE_PATH || ''}"

# --- LLM ---
ANTHROPIC_API_KEY="${anthropicKey}"

# --- Horario de trabajo (fuera de esto el agente no hace nada) ---
AGENT_TICK_SECONDS=${existing.AGENT_TICK_SECONDS || 90}
AGENT_TIMEZONE="${existing.AGENT_TIMEZONE || 'America/Argentina/Buenos_Aires'}"
AGENT_ACTIVE_HOURS="${existing.AGENT_ACTIVE_HOURS || '09:00-19:00'}"
AGENT_ACTIVE_DAYS="${existing.AGENT_ACTIVE_DAYS || '1,2,3,4,5'}"
`
}
