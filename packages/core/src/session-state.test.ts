import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readSessionFromUrl } from './session-state.js'

test('staying on the feed means the session is alive', () => {
  // The case that was reported as signed-out while the account was perfectly
  // fine, because detection hung off a CSS class instead of the redirect.
  for (const url of [
    'https://www.linkedin.com/feed/',
    'https://www.linkedin.com/feed',
    'https://www.linkedin.com/feed/?trk=nav',
  ]) {
    assert.equal(readSessionFromUrl(url).state, 'signed_in', url)
  }
})

test('a redirect to any sign-in surface means signed out', () => {
  for (const path of ['/login', '/uas/login', '/authwall', '/signup', '/home']) {
    const verdict = readSessionFromUrl(`https://www.linkedin.com${path}`)
    assert.equal(verdict.state, 'signed_out', path)
  }
})

test('a checkpoint is distinguished from being signed out', () => {
  // Different problems, different instructions: one needs a password, the
  // other needs a human to clear a challenge. Retrying the second never works.
  for (const path of ['/checkpoint/challenge', '/challenge/verify']) {
    const verdict = readSessionFromUrl(`https://www.linkedin.com${path}`)
    assert.equal(verdict.state, 'checkpoint', path)
  }
})

test('a challenge URL mentioning login is still a checkpoint', () => {
  // Ordering matters — checkpoints are matched before sign-in surfaces.
  const verdict = readSessionFromUrl('https://www.linkedin.com/checkpoint/lg/login-submit')
  assert.equal(verdict.state, 'checkpoint')
})

test('an unexpected destination is reported as unknown, not as signed out', () => {
  // Worth separating: unknown is usually a slow redirect, and the caller gives
  // the DOM a second chance before failing.
  const verdict = readSessionFromUrl('https://www.linkedin.com/mynetwork/')
  assert.equal(verdict.state, 'unknown')
  assert.match(verdict.state === 'unknown' ? verdict.reason : '', /mynetwork/)
})

test('a malformed URL does not throw', () => {
  assert.equal(readSessionFromUrl('not a url').state, 'unknown')
})

test('every non-signed-in verdict explains itself', () => {
  for (const url of [
    'https://www.linkedin.com/login',
    'https://www.linkedin.com/checkpoint/challenge',
    'https://www.linkedin.com/jobs/',
  ]) {
    const verdict = readSessionFromUrl(url)
    assert.notEqual(verdict.state, 'signed_in')
    assert.ok('reason' in verdict && verdict.reason.length > 0, url)
  }
})
