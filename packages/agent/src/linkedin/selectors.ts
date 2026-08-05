/**
 * Every LinkedIn selector, in one file.
 *
 * LinkedIn ships obfuscated class names that rotate, so selectors are the part
 * of this codebase guaranteed to break. Isolating them means a breakage is a
 * one-file fix by someone reading the live DOM, not an archaeology expedition
 * through the driver.
 *
 * Each entry is a list tried in order. Prefer selectors anchored to things that
 * carry meaning to LinkedIn's own code — `data-*` attributes, ARIA roles,
 * stable component names — over layout classes, which change with every
 * redesign. The last entry in each list is usually the loosest fallback.
 */

export type SelectorSet = readonly string[]

export const SELECTORS = {
  /** Confirms a live session before anything else runs. */
  loggedIn: [
    'nav [data-test-global-nav-me]',
    'img.global-nav__me-photo',
    '.global-nav__me',
  ],
  /** Shown when LinkedIn wants a checkpoint, captcha or re-auth. */
  authWall: [
    'input[name="session_key"]',
    '#captcha-internal',
    '.authentication-outlet',
    'form.challenge',
  ],

  post: {
    /** Comments on the currently open post. */
    comment: ['article.comments-comment-entity', '.comments-comment-item'],
    commentAuthorLink: ['a.comments-post-meta__actor-link', '.comments-post-meta__actor-link'],
    commentAuthorHeadline: ['.comments-post-meta__headline', '.comments-comment-meta__description'],
    commentBody: ['.comments-comment-item__main-content', '.update-components-text'],
    /** Loads the next page of comments. */
    loadMoreComments: [
      'button.comments-comments-list__load-more-comments-button',
      'button[aria-label*="más comentario"]',
      'button[aria-label*="more comment"]',
    ],
    replyButton: ['button.comments-comment-social-bar__reply-action-button', 'button[aria-label*="Responder"]'],
    replyEditor: ['div.ql-editor[contenteditable="true"]', 'div[role="textbox"]'],
    replySubmit: ['button.comments-comment-box__submit-button--cr', 'button[type="submit"]'],
  },

  profile: {
    /** "1er" / "2do" / "3ro" — the degree badge next to the name. */
    degreeBadge: ['span.dist-value', '.distance-badge .dist-value'],
    headline: ['div.text-body-medium.break-words', '.pv-text-details__left-panel .text-body-medium'],
    currentCompany: ['button[aria-label^="Empresa actual"]', '.pv-text-details__right-panel-item-text'],
    connectButton: ['button[aria-label^="Invitar"]', 'button[aria-label^="Invite"]'],
    /** Under "Más" when the primary action slot is taken by Follow/Message. */
    moreActionsButton: ['button[aria-label="Más acciones"]', 'button[aria-label="More actions"]'],
    messageButton: ['button[aria-label^="Enviar mensaje"]', 'button[aria-label^="Message"]'],
  },

  invite: {
    addNoteButton: ['button[aria-label="Añadir una nota"]', 'button[aria-label="Add a note"]'],
    noteTextarea: ['textarea#custom-message', 'textarea[name="message"]'],
    sendButton: ['button[aria-label="Enviar invitación"]', 'button[aria-label="Send invitation"]'],
    /** Shown when the weekly invitation cap is already spent. */
    limitReached: ['.ip-fuse-limit-alert', 'div[data-test-modal] h2:has-text("límite")'],
  },

  messaging: {
    conversationListItem: ['li.msg-conversation-listitem', '.msg-conversations-container__convo-item'],
    conversationLink: ['a.msg-conversation-listitem__link', '.msg-conversation-listitem__link'],
    conversationName: ['.msg-conversation-listitem__participant-names', 'h3'],
    conversationSnippet: ['.msg-conversation-card__message-snippet', '.msg-conversation-listitem__message-snippet'],
    conversationTimestamp: ['time.msg-conversation-listitem__time-stamp', 'time'],
    messageItem: ['li.msg-s-message-list__event', '.msg-s-event-listitem'],
    messageSender: ['.msg-s-message-group__name', '.msg-s-event-listitem__name'],
    messageBody: ['.msg-s-event-listitem__body', '.msg-s-event__content'],
    composer: ['div.msg-form__contenteditable[contenteditable="true"]', 'div[role="textbox"]'],
    sendButton: ['button.msg-form__send-button', 'button[type="submit"]'],
  },

  invitationsSent: {
    row: ['li.invitation-card', '.mn-invitation-list li'],
    withdrawButton: ['button[aria-label^="Retirar"]', 'button[aria-label^="Withdraw"]'],
    confirmWithdraw: ['button[data-test-dialog-primary-btn]', 'button.artdeco-modal__confirm-dialog-btn'],
  },
} as const

/** Joins a selector list into one CSS query. */
export function anyOf(selectors: SelectorSet): string {
  return selectors.join(', ')
}

export const URLS = {
  feed: 'https://www.linkedin.com/feed/',
  messaging: 'https://www.linkedin.com/messaging/',
  sentInvitations: 'https://www.linkedin.com/mynetwork/invitation-manager/sent/',
  profile: (publicIdentifier: string) => `https://www.linkedin.com/in/${publicIdentifier}/`,
  recentActivity: (publicIdentifier: string) =>
    `https://www.linkedin.com/in/${publicIdentifier}/recent-activity/all/`,
} as const
