import assert from 'node:assert/strict'
import { test } from 'node:test'

import { publicIdentifierFromHref } from './extract.js'

test('the public identifier is read out of a profile href', () => {
  // Every dedup rule keys on this, so a wrong parse means messaging the wrong
  // person or enrolling someone twice.
  for (const [href, expected] of [
    ['/in/martin-bufczyk/', 'martin-bufczyk'],
    ['/in/martin-bufczyk', 'martin-bufczyk'],
    ['https://www.linkedin.com/in/diego-perez/', 'diego-perez'],
    ['/in/piero-storace/?miniProfileUrn=urn%3Ali%3A123', 'piero-storace'],
    ['/in/yeison-villamil/#experience', 'yeison-villamil'],
  ] as const) {
    assert.equal(publicIdentifierFromHref(href), expected, href)
  }
})

test('percent-encoded identifiers are decoded', () => {
  assert.equal(publicIdentifierFromHref('/in/cl%C3%A9ment-geynet/'), 'clément-geynet')
})

test('a non-profile href yields nothing rather than a wrong identifier', () => {
  // Comment bodies contain links; a company or post URL must not be mistaken
  // for the author.
  for (const href of [
    '/company/enbi-consulting/',
    '/feed/update/urn:li:share:123/',
    'https://enbiconsulting.com/agenda-software',
    '',
  ]) {
    assert.equal(publicIdentifierFromHref(href), '', href)
  }
})
