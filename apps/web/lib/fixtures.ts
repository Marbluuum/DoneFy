import type { ConversationStage, EnrollmentState, LeadIntent } from '@linkfy/core'

/**
 * Fake data for building the panel before the agent exists.
 *
 * Modelled on real threads from the account so the layout is judged against
 * messages that actually occur — comment replies of two words, DMs of one line
 * — rather than lorem ipsum that makes every box look comfortable.
 */

export type FixtureMessage = {
  from: 'owner' | 'lead'
  body: string
  at: string
  channel: 'comment_reply' | 'invite_note' | 'dm'
  generated?: boolean
}

export type FixtureLead = {
  id: string
  name: string
  headline: string
  company?: string
  degree: 1 | 2 | 3
  avatarInitials: string
  state: EnrollmentState
  stage: ConversationStage | null
  keyword: string
  postExcerpt: string
  comment: string
  messages: FixtureMessage[]
  /** Last orchestrator read, when there is one. */
  analysis?: {
    intent: LeadIntent
    confidence: number
    rationale: string
    autonomy: 'auto' | 'suggest' | 'handoff'
    notes: string[]
    signals: { company?: string; pain?: string }
  }
  unread: boolean
  lastActivity: string
}

export const LEADS: FixtureLead[] = [
  {
    id: 'diego',
    name: 'Diego Perez',
    headline: 'CEO en Global SI | Desarrollo de software',
    company: 'Global SI',
    degree: 1,
    avatarInitials: 'DP',
    state: 'replied',
    // The stage is where the conversation *is*, not where the reply will take
    // it. Quick replies are the messages that cause the transition, so keying
    // them off the destination would skip a step.
    stage: 'qualifying_company',
    keyword: 'software',
    postExcerpt: 'Las empresas de tecnología no tienen un problema de producto…',
    comment: 'software',
    lastActivity: 'hace 12 min',
    unread: true,
    messages: [
      { from: 'owner', body: 'Diego enviado', at: '22 jul 10:55', channel: 'comment_reply' },
      {
        from: 'owner',
        body: 'Buenas Diego! Vi que me comentaste la publicación, tienes una empresa de tecnología?',
        at: '22 jul 10:57',
        channel: 'dm',
      },
      {
        from: 'lead',
        body: 'Buenos días\nSi tengo una empresa de desarrollo\nMás de 10 años en el mercado.',
        at: '22 jul 10:58',
        channel: 'dm',
      },
      { from: 'lead', body: 'globalsi.com.py', at: '22 jul 11:04', channel: 'dm' },
    ],
    analysis: {
      intent: 'confirms',
      confidence: 0.94,
      rationale: 'Confirma que tiene empresa de desarrollo con 10 años de trayectoria.',
      autonomy: 'suggest',
      notes: ['modo copilot: autonomía limitada a suggest'],
      signals: { company: 'empresa de desarrollo, +10 años en el mercado' },
    },
  },
  {
    id: 'wendy',
    name: 'Wendy Castillo',
    headline: 'Account Manager en Excelia | Strategic Business Development',
    company: 'Excelia',
    degree: 1,
    avatarInitials: 'WC',
    state: 'dm_sent',
    stage: 'qualifying_company',
    keyword: 'software',
    postExcerpt: 'Las empresas de tecnología no tienen un problema de producto…',
    comment: 'software',
    lastActivity: 'hace 1 semana',
    unread: false,
    messages: [
      { from: 'owner', body: 'Wendy enviado', at: '28 jul 09:12', channel: 'comment_reply' },
      {
        from: 'owner',
        body: 'Buenas Wendy! Vi que me comentaste la publicación, tienes una empresa de tecnología?',
        at: '28 jul 11:40',
        channel: 'dm',
      },
    ],
  },
  {
    id: 'clement',
    name: 'Clément Geynet',
    headline: 'Conferencier IA | HEC Paris',
    degree: 2,
    avatarInitials: 'CG',
    state: 'invite_sent',
    stage: null,
    keyword: 'CRM',
    postExcerpt: 'Salesforce en sueur. Claude Code + Twenty CRM…',
    comment: 'CRM me interesa mucho el enfoque',
    lastActivity: 'hace 2 días',
    unread: false,
    messages: [
      { from: 'owner', body: 'Clément enviado', at: '03 ago 15:20', channel: 'comment_reply' },
      {
        from: 'owner',
        body: 'Clément! Vi tu comentario sobre CRM en el post. Trabajás con empresas de tecnología en Francia? Te comparto lo que armamos.',
        at: '03 ago 15:48',
        channel: 'invite_note',
        generated: true,
      },
    ],
  },
  {
    id: 'kimberly',
    name: 'Kimberly Price',
    headline: 'B2B Tech Sales Trainer | Lead Generation',
    degree: 2,
    avatarInitials: 'KP',
    state: 'replied',
    stage: 'qualifying_pain',
    keyword: 'sistema',
    postExcerpt: 'Cold calling is NOT rocket science…',
    comment: 'sistema, quiero ver como lo hacen',
    lastActivity: 'hace 3 h',
    unread: true,
    messages: [
      { from: 'owner', body: 'Kimberly enviado', at: '04 ago 12:02', channel: 'comment_reply' },
      {
        from: 'owner',
        body: 'Buenas Kimberly! Vi que me comentaste la publicación, tienes una empresa de tecnología?',
        at: '04 ago 14:30',
        channel: 'dm',
      },
      {
        from: 'lead',
        body: 'Si, somos una consultora chica. El tema es que dependemos de dos clientes grandes y no logramos crecer más allá de eso.',
        at: '05 ago 10:15',
        channel: 'dm',
      },
    ],
    analysis: {
      intent: 'shares_pain',
      confidence: 0.91,
      rationale: 'Nombra el problema: dependencia de dos clientes y techo de crecimiento.',
      autonomy: 'suggest',
      notes: ['el pitch nunca se envía sin aprobación'],
      signals: {
        company: 'consultora chica',
        pain: 'dependemos de dos clientes grandes y no logramos crecer',
      },
    },
  },
  {
    id: 'ivan',
    name: 'Ivan Falco',
    headline: 'Ads Engineer | Scaling ABM',
    degree: 3,
    avatarInitials: 'IF',
    state: 'invite_queued',
    stage: null,
    keyword: 'sistema',
    postExcerpt: 'Cold calling is NOT rocket science…',
    comment: 'sistema',
    lastActivity: 'hace 5 h',
    unread: false,
    messages: [{ from: 'owner', body: 'Ivan enviado', at: '05 ago 09:41', channel: 'comment_reply' }],
  },
  {
    id: 'jorge',
    name: 'Jorge Escoto',
    headline: 'GTM Acquisition Leader',
    degree: 2,
    avatarInitials: 'JE',
    state: 'handed_off',
    stage: 'handed_off',
    keyword: 'software',
    postExcerpt: 'Las empresas de tecnología no tienen un problema de producto…',
    comment: 'software cuanto sale esto?',
    lastActivity: 'hace 1 día',
    unread: true,
    messages: [
      { from: 'owner', body: 'Jorge enviado', at: '04 ago 08:30', channel: 'comment_reply' },
      {
        from: 'owner',
        body: 'Buenas Jorge! Vi que me comentaste la publicación, tienes una empresa de tecnología?',
        at: '04 ago 11:15',
        channel: 'dm',
      },
      { from: 'lead', body: 'Si. Cuanto cuesta el servicio? Manejan fee mensual?', at: '04 ago 16:02', channel: 'dm' },
    ],
    analysis: {
      intent: 'asks_question',
      confidence: 0.88,
      rationale: 'Pregunta directamente por precio y modalidad de cobro.',
      autonomy: 'handoff',
      notes: ['pregunta fuera del guion: siempre pasa a humano'],
      signals: {},
    },
  },
]

/**
 * Posts synced by the agent.
 *
 * No browser extension involved: the agent already runs as the account owner
 * on their own machine, so listing their own posts is just reading a page they
 * are logged into. The extension other tools ship exists to lift the session
 * cookie out to a server, which is a different problem, and not one this
 * design has.
 */
export type FixturePost = {
  id: string
  excerpt: string
  postedAt: string
  reactions: number
  comments: number
  /** Comments that matched a keyword, if an automation covers this post. */
  matched?: number
  automation?: string
}

export const POSTS: FixturePost[] = [
  {
    id: 'p1',
    excerpt: 'Las empresas de tecnología no tienen un problema de producto. Tienen un problema de distribución…',
    postedAt: 'hace 2 días',
    reactions: 214,
    comments: 178,
    matched: 96,
    automation: 'Empresas de tecnología',
  },
  {
    id: 'p2',
    excerpt: 'Cold calling is NOT rocket science. So stop acting like it is…',
    postedAt: 'hace 4 días',
    reactions: 83,
    comments: 419,
    matched: 118,
    automation: 'Empresas de tecnología',
  },
  {
    id: 'p3',
    excerpt: 'Salesforce en sueur. Claude Code + Twenty CRM, te dejo la metodología…',
    postedAt: 'hace 6 días',
    reactions: 68,
    comments: 222,
    matched: 98,
    automation: 'Post CRM',
  },
  {
    id: 'p4',
    excerpt: 'Mapeé 3.300 family offices y esto es lo que aprendí sobre cómo compran…',
    postedAt: 'hace 1 semana',
    reactions: 141,
    comments: 87,
  },
  {
    id: 'p5',
    excerpt: '5 años vendiendo software y el error que sigo viendo en cada pitch…',
    postedAt: 'hace 2 semanas',
    reactions: 96,
    comments: 54,
  },
]

export const FUNNEL = {
  comments: 312,
  replied: 312,
  invitesSent: 118,
  invitesAccepted: 94,
  dmsSent: 201,
  conversations: 63,
  booked: 11,
}

export const HEALTH = {
  state: 'healthy' as const,
  acceptanceRate: 0.8,
  invitesThisWeek: 34,
  invitesCap: 80,
  pending: 24,
  failureRate: 0.01,
}

export const MODE: 'copilot' | 'assisted' | 'autopilot' = 'copilot'

export const STATE_LABELS: Record<string, string> = {
  detected: 'Detectado',
  comment_replied: 'Comentario respondido',
  invite_queued: 'En cola de invitación',
  invite_sent: 'Invitación enviada',
  connected: 'Conectado',
  dm_sent: 'DM enviado',
  followup_1_sent: 'Seguimiento 1',
  followup_2_sent: 'Seguimiento 2',
  replied: 'Conversando',
  closed: 'Cerrado',
  booked: 'Reunión agendada',
  disqualified: 'Descartado',
  handed_off: 'Te toca a vos',
  invite_expired: 'Invitación vencida',
  opted_out: 'Opt-out',
  failed: 'Error',
}

export const STAGE_LABELS: Record<string, string> = {
  qualifying_company: 'Calificando empresa',
  qualifying_pain: 'Buscando el dolor',
  pitching: 'Ofreciendo reunión',
  awaiting_booking: 'Esperando que agende',
  booked: 'Agendada',
  disqualified: 'Descartado',
  handed_off: 'Te toca a vos',
  abandoned: 'Abandonado',
}
