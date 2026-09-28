const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * public/index.html has no build step, so nothing would otherwise catch a
 * syntax error, a handler that no longer exists, or the reappearance of a
 * defect that is invisible in a diff. These are cheap and they run in
 * `npm test`; they are not a substitute for opening the page.
 */

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SCRIPT = (() => {
  const open = HTML.indexOf('\n<script>');
  const close = HTML.indexOf('</script>', open);
  assert.ok(open > 0 && close > open, 'no inline script block found');
  return HTML.slice(open + '\n<script>'.length, close);
})();

test('the inline script parses', () => {
  // Throws with a line number on a syntax error. Compile only: nothing runs.
  new vm.Script(SCRIPT, { filename: 'public/index.html <script>' });
});

test('every inline handler resolves to a function that exists', () => {
  const used = new Set([...HTML.matchAll(/on(?:click|input|submit)="([A-Za-z0-9_$]+)\(/g)].map((m) => m[1]));
  const declared = new Set([...SCRIPT.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g)].map((m) => m[1]));
  assert.ok(used.size > 5, 'expected to find the inline handlers');
  for (const fn of used) assert.ok(declared.has(fn), `${fn}() is referenced by an attribute but not declared`);
});

test('nothing is declared twice at the top level', () => {
  const counts = new Map();
  for (const m of SCRIPT.matchAll(/^\s{0,2}(?:function|var|let|const)\s+([A-Za-z0-9_$]+)/gm)) {
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  const dupes = [...counts].filter(([, n]) => n > 1);
  assert.deepEqual(dupes, [], 'a second declaration would shadow or throw');
});

test('the hidden attribute is not defeated by an author display rule', () => {
  // .btn sets display:inline-flex, which outranks the UA rule for [hidden]
  // whatever the specificity, so btnRedeem.hidden did nothing until this rule
  // existed. Losing it puts the gold Redeem button in front of every customer.
  assert.match(HTML, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(SCRIPT, /btnRedeem\.hidden\s*=/, 'the page still relies on the attribute');
});

test('no script is loaded from another origin', () => {
  const remote = [...HTML.matchAll(/<script[^>]+src="(https?:)?\/\/[^"]+"/g)].map((m) => m[0]);
  assert.deepEqual(remote, [], 'the QR decoder is vendored on purpose; a CDN cannot be integrity-checked here');
  assert.match(HTML, /src="\/vendor\/jsQR-1\.4\.0\.min\.js"/);
});

test('the page can still be zoomed', () => {
  const viewport = /<meta name="viewport" content="([^"]*)"/.exec(HTML);
  assert.ok(viewport, 'no viewport meta tag');
  assert.doesNotMatch(viewport[1], /user-scalable\s*=\s*no/, 'WCAG 1.4.4');
  assert.doesNotMatch(viewport[1], /maximum-scale\s*=\s*1/);
});

test('the recessive text and the chart labels stay legible', () => {
  // --text-3 at 0.32 measured 2.65:1 on the card against a 4.5:1 requirement.
  const alpha = /--text-3:\s*rgba\(\s*235,\s*235,\s*245,\s*([\d.]+)\s*\)/.exec(HTML);
  assert.ok(alpha, '--text-3 is not the expected rgba() form');
  assert.ok(Number(alpha[1]) >= 0.5, `--text-3 alpha is ${alpha[1]}: below about 0.5 it fails AA on the card`);

  // The chart's viewBox is 448 wide and renders around 325px on a phone, so a
  // font-size in viewBox units lands at roughly 0.73x. 10 was about 7px.
  const size = /\.chart-wrap svg text \{[^}]*font-size:\s*(\d+)px/.exec(HTML);
  assert.ok(size, 'the chart text rule is gone; the axis would fall back to tiny defaults');
  assert.ok(Number(size[1]) >= 14, `chart font-size ${size[1]} renders at about ${(Number(size[1]) * 0.73).toFixed(1)}px`);
});

test('the y axis does not round the peak down into the floor', () => {
  // Pulled out of the inline script and run on its own: it is a pure function,
  // and getting it wrong is invisible in a diff but obvious on screen.
  const m = /niceMax: (function \(v\) \{[\s\S]*?\n {4}\})/.exec(SCRIPT);
  assert.ok(m, 'niceMax is not in the shape this test expects');
  const niceMax = vm.runInNewContext('(' + m[1] + ')');

  assert.equal(niceMax(27), 30, 'a peak of 27 used to round to 50, so the line sat halfway down');
  assert.equal(niceMax(7), 8);
  assert.equal(niceMax(12), 15);
  assert.equal(niceMax(146), 150);
  assert.equal(niceMax(677), 800);

  // Whatever the ladder, the axis must contain the data without burying it.
  for (const peak of [1, 3, 6, 9, 17, 27, 41, 88, 130, 249, 512, 1001, 4820]) {
    const max = niceMax(peak);
    assert.ok(max >= peak, `${peak} would be drawn off the top of a ${max} axis`);
    if (peak > 5) {
      assert.ok(peak / max >= 0.6, `a peak of ${peak} only reaches ${Math.round((peak / max) * 100)}% of a ${max} axis`);
    }
  }
});

test('the chart box is tall enough for the axis text it now carries', () => {
  const viewBox = /<svg id="chart" viewBox="0 0 (\d+) (\d+)"/.exec(HTML);
  assert.ok(viewBox, 'the chart viewBox is not where this test expects it');
  const geometry = /W: (\d+), H: (\d+), padL: (\d+), padR: (\d+), padT: (\d+), padB: (\d+)/.exec(SCRIPT);
  assert.ok(geometry, 'the chart geometry is not where this test expects it');
  const [, w, h, , , padT, padB] = geometry.map(Number);
  assert.equal(w, Number(viewBox[1]), 'Chart.W and the viewBox have drifted apart');
  assert.equal(h, Number(viewBox[2]), 'Chart.H and the viewBox have drifted apart');

  // Labels are drawn at H - 9 in a 16-unit font, so the box needs room beneath
  // the plot for the text plus its descenders.
  assert.ok(padB >= 32, `padB ${padB} clips the descenders on the x labels`);
  assert.ok(h - padT - padB >= 180, 'the plot area is too short for the line to say anything');
});

test('the armed redeem button is unmistakable, with and without motion', () => {
  // Redeeming went from one tap to two. Staff will not read a changed label,
  // so the armed state has to look different, and it has to still look
  // different for anyone who has asked their device for less motion.
  assert.match(HTML, /\.btn\.gold\.confirm\s*\{[^}]*animation:\s*confirmPulse/,
    'the armed button no longer pulses');
  assert.match(HTML, /@keyframes confirmPulse/);

  const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n  \}/.exec(HTML);
  assert.ok(reduced, 'no reduced-motion fallback: the armed state would be invisible without the animation');
  assert.match(reduced[1], /\.btn\.gold\.confirm/);
  assert.match(reduced[1], /animation:\s*none/);
  assert.match(reduced[1], /box-shadow/, 'turning the animation off must leave something behind');

  // Every route out of the armed state has to take the class with it, or the
  // button keeps pulsing at the next customer.
  assert.match(SCRIPT, /function disarmRedeem\(\)\s*\{[\s\S]*?classList\.remove\('confirm'\)/);
  const adds = SCRIPT.match(/classList\.add\('confirm'\)/g) || [];
  assert.equal(adds.length, 1, 'only armRedeem() should arm the button');
});

test('the API takes no application-level auth, which is deliberate', () => {
  // Reverted once already. If this fails, someone has added a gate to the page:
  // check that it was actually asked for (see CLAUDE.md).
  assert.doesNotMatch(SCRIPT, /passcode/i);
  assert.doesNotMatch(HTML, /X-Staff-Passcode/i);
});
