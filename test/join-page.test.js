const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * public/join/index.html has no build step, the same as public/index.html, and
 * it is now where /upgrade lands -- the link on the back of every old PassKit
 * card. A syntax error or a selector that stopped matching reaches customers,
 * so these are the cheap checks that run in `npm test`. They are not a
 * substitute for opening the page.
 */

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'join', 'index.html'), 'utf8');
const SCRIPT = (() => {
  const open = HTML.indexOf('\n<script>');
  const close = HTML.indexOf('</script>', open);
  assert.ok(open > 0 && close > open, 'no inline script block found');
  return HTML.slice(open + '\n<script>'.length, close);
})();

test('the inline script parses', () => {
  // Throws with a line number on a syntax error. Compile only: nothing runs.
  new vm.Script(SCRIPT, { filename: 'public/join/index.html <script>' });
});

test('the #upgrade retitle runs after the handlers it could otherwise take with it', () => {
  // It is cosmetic DOM work, and `null.textContent` throws. Run ahead of the
  // submit handlers -- where it used to be -- a selector that stopped matching
  // aborts the rest of the inline script, and the upgrade form then renders
  // perfectly and does nothing at all when submitted.
  const retitle = SCRIPT.indexOf('upgradeEntry');
  const lostSubmit = SCRIPT.indexOf("lostForm.addEventListener('submit'");
  const codeSubmit = SCRIPT.indexOf("codeForm.addEventListener('submit'");
  assert.ok(retitle > 0, 'the #upgrade entry point is gone');
  assert.ok(lostSubmit > 0 && codeSubmit > 0, 'the submit handlers moved');
  assert.ok(retitle > lostSubmit && retitle > codeSubmit, 'the retitle must come after both submit handlers');
  // And it checks both selectors before touching either.
  assert.match(SCRIPT.slice(retitle, retitle + 600), /if \(!h1 \|\| !lead\) return;/);
});

test('the markup the retitle reaches for is still there', () => {
  const form = HTML.slice(HTML.indexOf('<form id="lostForm"'), HTML.indexOf('<form id="codeForm"'));
  assert.ok(form.length > 100, 'the lost-card form markup moved');
  assert.match(form, /<h1>/, '#lostForm h1');
  assert.match(form, /class="lead"/, '#lostForm .lead');
});

test('Back puts the wording the markup carries back', () => {
  // The upgrade copy is applied over the lost-card copy, and Back asks a
  // different question, so it has to be restored rather than left behind. The
  // original is read off the markup and not repeated in the script, so the
  // two cannot drift.
  const entry = SCRIPT.slice(SCRIPT.indexOf('upgradeEntry'));
  assert.match(entry, /var wasH1 = h1\.textContent, wasLead = lead\.textContent;/);
  assert.match(entry, /getElementById\('lostBack'\)\.addEventListener\('click', function \(\) \{\s*h1\.textContent = wasH1;\s*lead\.textContent = wasLead;/);
  assert.ok(!/Get your card back/.test(entry), 'the default wording must come from the markup, not a copy here');
});
