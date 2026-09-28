const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pointsFromEvent, pointsFromNotes } = require('../api/admin/backfill')._internals;

// The riskiest file in the PR: it writes thousands of rows in bulk, from free
// text that a system we no longer run produced.
test('an amount is read from an old event however the note was phrased', () => {
  assert.equal(pointsFromNotes('Loyalty Scanner: +3 points'), 3);
  assert.equal(pointsFromNotes('Loyalty Scanner: -9 points'), 9);
  assert.equal(pointsFromNotes('9 points'), 9, 'unsigned: the old format, which used to read as 0');
  assert.equal(pointsFromNotes('1 point redeemed'), 1);
  assert.equal(pointsFromNotes('Earned 12 Points'), 12);
  assert.equal(pointsFromNotes(''), null, 'unknown stays unknown');
  assert.equal(pointsFromNotes('Stamp added'), null);
  assert.equal(pointsFromNotes(undefined), null);
});

test('a structured amount on the event beats the note, and the sign never decides', () => {
  assert.equal(pointsFromEvent({ points: 4, notes: '9 points' }), 4);
  assert.equal(pointsFromEvent({ points: '7' }), 7);
  assert.equal(pointsFromEvent({ pointsBurned: -9 }), 9, 'direction comes from eventType, not the sign');
  assert.equal(pointsFromEvent({ metaData: { points: 2 } }), 2);
  assert.equal(pointsFromEvent({ eventDetails: { points: 5 } }), 5);
  assert.equal(pointsFromEvent({ notes: '9 points' }), 9);
  assert.equal(pointsFromEvent({}), null);
  assert.equal(pointsFromEvent({ points: 'lots' }), null);
});
