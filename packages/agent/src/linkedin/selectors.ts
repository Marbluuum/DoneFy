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
  /**
   * Secondary confirmation of a live session.
   *
   * Session detection is primarily by URL — a signed-out browser gets
   * redirected off /feed/, and that redirect is behaviour LinkedIn cannot
   * change without changing what the site does. These are a fallback signal
   * only, because anchoring auth to a CSS class means a class rename reads as
   * a logged-out account.
   */
  loggedIn: [
    '#global-nav',
    'nav.global-nav',
    '.global-nav__me',
    'img.global-nav__me-photo',
    'button.global-nav__primary-link-me-menu-trigger',
    'nav [data-test-global-nav-me]',
    'main[id="main"]',
  ],
  /** Shown when LinkedIn wants a checkpoint, captcha or re-auth. */
  authWall: [
    'input[name="session_key"]',
    '#captcha-internal',
    '.authentication-outlet',
    'form.challenge',
    '.join-form',
  ],

  post: {
    /**
     * Comments on the currently open post.
     *
     * Confirmed against the live DOM: the class-based containers are gone, but
     * the reply buttons are there, so comments render — the container name
     * changed, not the structure. `:has()` walks up from the button, which
     * survives a rename of the container itself.
     */
    comment: [
      'article:has(button[aria-label*="Responder"])',
      'article.comments-comment-entity',
      '.comments-comment-item',
    ],
    commentAuthorLink: [
      'a[href*="/in/"]',
      'a.comments-post-meta__actor-link',
      '.comments-post-meta__actor-link',
    ],
    commentAuthorHeadline: ['.comments-post-meta__headline', '.comments-comment-meta__description'],
    commentBody: ['.comments-comment-item__main-content', '.update-components-text'],
    /** Loads the next page of comments. */
    loadMoreComments: [
      'button[aria-label*="más comentario"]',
      'button[aria-label*="more comment"]',
      'button.comments-comments-list__load-more-comments-button',
    ],
    // Verified live: aria-label matches, the class does not. Ordered so the
    // one that works is tried first.
    replyButton: ['button[aria-label*="Responder"]', 'button[aria-label*="Reply"]'],
    replyEditor: ['div[role="textbox"]', 'div.ql-editor[contenteditable="true"]'],
    replySubmit: ['button[type="submit"]', 'button.comments-comment-box__submit-button--cr'],
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

  // Verified against the live DOM. The ones without a note matched on the
  // first candidate; where the second matched and the first did not, the
  // working one has been moved to the front.
  messaging: {
    conversationListItem: ['li.msg-conversation-listitem', '.msg-conversations-container__convo-item'],
    /** The `a.` prefix does not match — the element is not an anchor. */
    conversationLink: ['.msg-conversation-listitem__link', 'a.msg-conversation-listitem__link'],
    conversationName: ['.msg-conversation-listitem__participant-names', 'h3'],
    conversationSnippet: ['.msg-conversation-card__message-snippet', '.msg-conversation-listitem__message-snippet'],
    conversationTimestamp: ['time.msg-conversation-listitem__time-stamp', 'time'],
    messageItem: ['li.msg-s-message-list__event', '.msg-s-event-listitem'],
    messageSender: ['.msg-s-message-group__name', '.msg-s-event-listitem__name'],
    messageBody: ['.msg-s-event-listitem__body', '.msg-s-event__content'],
    composer: ['div.msg-form__contenteditable[contenteditable="true"]', 'div[role="textbox"]'],
    /**
     * The only miss in messaging. Neither the class nor a submit type matched,
     * so the send control is likely an aria-labelled button rendered outside
     * the form element — hence the label-first ordering.
     */
    sendButton: [
      'button[aria-label*="Enviar"]',
      'button[aria-label*="Send"]',
      'form.msg-form button:not([aria-label*="adjunt"]):not([aria-label*="attach"])',
      'button.msg-form__send-button',
      'button[type="submit"]',
    ],
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
