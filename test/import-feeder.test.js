const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const FEEDER = pathToFileURL(path.join(__dirname, '..', 'scripts', 'import-passkit.mjs')).href;

const HEAD = 'members.member.id,person.forename,person.surname,person.emailAddress,members.member.points';
function csv(rows, head = HEAD) {
  return [head, ...rows].join('\n') + '\n';
}

test('the feeder reads a blank balance as zero only when the points column carries data', async () => {
  const { parseCsv, mapRecords } = await import(FEEDER);
  const map = (text) => mapRecords(parseCsv(text));

  // A normal export: PassKit writes no "0", so blanks under a live column are
  // real zeroes and have to be sent as such, or the endpoint's
  // unreadable-points guard refuses the whole import. 1,657 of 5,271 rows on
  // the switch-day export were blank.
  let r = map(csv([
    'AAAAAAAAAAAA,Ann,A,ann@x.com,14',
    'BBBBBBBBBBBB,Ben,B,ben@x.com,',
    'CCCCCCCCCCCC,Cat,C,cat@x.com,3',
  ]));
  assert.deepEqual(r.members.map((m) => m.points), ['14', '0', '3']);
  assert.deepEqual([r.points.readable, r.points.blankAsZero, r.points.unreadable], [2, 1, 0]);
  assert.equal(r.points.columnAlive, true);

  // A renamed column: unreadable, so the endpoint refuses. This is the case
  // the import endpoint's guard was written for and it must keep working.
  r = map(csv([
    'AAAAAAAAAAAA,Ann,A,ann@x.com,14',
    'BBBBBBBBBBBB,Ben,B,ben@x.com,',
  ], 'members.member.id,person.forename,person.surname,person.emailAddress,pts'));
  assert.deepEqual(r.members.map((m) => m.points), ['', '']);
  assert.equal(r.points.columnInHeader, false);
  assert.deepEqual([r.points.readable, r.points.blankAsZero, r.points.unreadable], [0, 0, 2]);

  // The column is in the header but empty in every row -- a filtered export, a
  // permissions change, a failed join on PassKit's side. Reading these as zero
  // would write every customer down to nothing on a re-run, with the endpoint
  // seeing nothing unreadable and reporting it as `updated`. They stay
  // unreadable so the guard fires instead.
  r = map(csv([
    'AAAAAAAAAAAA,Ann,A,ann@x.com,',
    'BBBBBBBBBBBB,Ben,B,ben@x.com,',
    'CCCCCCCCCCCC,Cat,C,cat@x.com,',
  ]));
  assert.deepEqual(r.members.map((m) => m.points), ['', '', ''], 'not zeroes');
  assert.equal(r.points.columnInHeader, true);
  assert.equal(r.points.columnAlive, false);
  assert.deepEqual([r.points.readable, r.points.blankAsZero, r.points.unreadable], [0, 0, 3]);

  // One live value is enough to trust the column, which is what makes the
  // normal export work at all.
  r = map(csv([
    'AAAAAAAAAAAA,Ann,A,ann@x.com,',
    'BBBBBBBBBBBB,Ben,B,ben@x.com,',
    'CCCCCCCCCCCC,Cat,C,cat@x.com,7',
  ]));
  assert.deepEqual(r.members.map((m) => m.points), ['0', '0', '7']);
  assert.equal(r.points.blankAsZero, 2);
});

test('the feeder says which of those three cases it is in', async () => {
  const { parseCsv, mapRecords, describePoints } = await import(FEEDER);
  const describe = (text) => {
    const records = parseCsv(text);
    return describePoints(mapRecords(records).points, records.length);
  };

  assert.match(describe(csv(['AAAAAAAAAAAA,Ann,A,ann@x.com,14', 'BBBBBBBBBBBB,Ben,B,ben@x.com,'])),
    /1 with a value, 1 blank read as zero/);
  assert.match(describe(csv(['AAAAAAAAAAAA,Ann,A,ann@x.com,', 'BBBBBBBBBBBB,Ben,B,ben@x.com,'])),
    /present but empty in all 2 rows.*no balance will be written/);
  assert.match(describe(csv(['AAAAAAAAAAAA,Ann,A,ann@x.com,14'], 'members.member.id,person.forename,person.surname,person.emailAddress,pts')),
    /no points column/);
});

test('the feeder maps the rest of a PassKit row the way the endpoint expects', async () => {
  const { parseCsv, mapRecords } = await import(FEEDER);
  const { members } = mapRecords(parseCsv(csv(['16dm9KIQ7haLWTVgchJPHI,Yunus,Tufail,"Yunus@Example.com",9'])));
  assert.deepEqual(members[0], {
    passkit_member_id: '16dm9KIQ7haLWTVgchJPHI',
    full_name: 'Yunus Tufail',
    email: 'Yunus@Example.com',
    phone: '',
    points: '9',
    pass_status: '',
  });
});

test('importing the feeder does not run it', async () => {
  // It has to be importable for the tests above; a module that fired its CLI
  // on import would try to read argv, and exit the test runner.
  const mod = await import(FEEDER);
  assert.equal(typeof mod.mapRecords, 'function');
  assert.equal(typeof mod.parseCsv, 'function');
  assert.equal(typeof mod.describePoints, 'function');
});
