// Self-test for mend: practice rounds, examples, and hand-written edge
// cases. Node 22, standard library only. Usage:
//   node scripts/selftest.mjs [practice.json]
// Exit 0 when everything passes; prints one line per failure.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = join(ROOT, 'main.ts');
const CHECK = join(ROOT, 'check.ts');
const EXAMPLES = join(ROOT, 'examples');

const candidates = [
  process.argv[2],
  join(ROOT, '..', 'kit', 'hidden-spec-cli-01-run-20261122-kit', 'program', 'generator', 'practice.json'),
  process.env.MAKEFUN_PRACTICE_JSON,
].filter(Boolean);
const PRACTICE = candidates.find((p) => existsSync(p)) ?? null;

let passed = 0;
let failed = 0;
const failures = [];
const note = (ok, label, detail = '') => {
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${label}${detail === '' ? '' : `: ${detail}`}`);
  }
};

function runCli(files, argv, stdin) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-selftest-'));
  try {
    for (const [p, text] of Object.entries(files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(process.execPath, [MAIN, ...argv], {
      cwd: dir,
      input: stdin ?? '',
      encoding: 'utf8',
      timeout: 10_000,
    });
    const after = {};
    const walk = (d, prefix = '') => {
      for (const name of readdirSync(d)) {
        const f = join(d, name);
        const rel = prefix === '' ? name : `${prefix}/${name}`;
        if (statSync(f).isDirectory()) walk(f, rel);
        else if (statSync(f).isFile()) after[rel] = readFileSync(f, 'utf8');
      }
    };
    walk(dir);
    return { exit: r.status, stdout: r.stdout ?? '', after, dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// One case: files in, argv/stdin, exit + stdout + files after.
function t(name, files, argv, stdin, exit, stdout, after = {}) {
  const got = runCli(files, argv, stdin);
  const why = [];
  if (got.exit !== exit) why.push(`exit ${got.exit}, expected ${exit}`);
  if (got.stdout !== stdout) {
    why.push(`stdout ${JSON.stringify(got.stdout)}, expected ${JSON.stringify(stdout)}`);
  }
  for (const [p, v] of Object.entries(after)) {
    const g = got.after[p] === undefined ? null : got.after[p];
    // A file the case never created counts as absent.
    const have = Object.hasOwn(got.after, p) ? g : null;
    if (v === null ? have !== null : have !== v) {
      why.push(`${p} is ${JSON.stringify(have)}, expected ${JSON.stringify(v)}`);
    }
  }
  note(why.length === 0, name, why.join('; '));
}

const ABC = 'a\nb\nc\n';

// ------------------------------------------------------------ CLI cases
t('cli: unknown option', { 'p.diff': '' }, ['--dry-run', 'p.diff'], null, 2, 'error: usage\n');
t('cli: duplicate --check', {}, ['--check', '--check', '-'], '', 2, 'error: usage\n');
t('cli: duplicate --format', {}, ['--format=json', '--format=json', '-'], '', 2, 'error: usage\n');
t('cli: bad --format value', { 'p.diff': '' }, ['--format=git', 'p.diff'], null, 2, 'error: usage\n');
t('cli: two positionals', {}, ['a', 'b'], null, 2, 'error: usage\n');
t('cli: -- ends options', {}, ['--', '--check'], null, 2, 'error: no-patch\n');
t('cli: patch file missing', {}, ['missing.patch'], null, 2, 'error: no-patch\n');
t('cli: prose is no format', {}, [], 'just some prose\n', 2, 'error: format\n');
t('cli: empty patch is no format', {}, [], '', 2, 'error: format\n');
t('cli: empty json array is parse 1', {}, [], '[]\n', 2, 'error: parse 1\n');
t('cli: json object without command is parse 1', {}, [], '{"bad": 1}\n', 2, 'error: parse 1\n');
t(
  'cli: header-only section is a no-op edit',
  { x: 'hi\n' },
  [],
  'diff --git a/x b/x\n',
  0,
  'ok: 0 files\n',
  { x: 'hi\n' },
);

// -------------------------------------------------------- unified cases
t(
  'unified: exact replace',
  { f: ABC },
  [],
  'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
  0,
  'M f\nok: 1 file\n',
  { f: 'a\nB\nc\n' },
);
t(
  'unified: nearest occurrence wins',
  { f: 'k1\nv\nk2\nv\nk3\nv\n' },
  [],
  '--- f\n+++ f\n@@ -99,1 +99,1 @@\n-v\n+V\n',
  0,
  'M f\nok: 1 file\n',
  { f: 'k1\nv\nk2\nv\nk3\nV\n' },
);
t(
  'unified: tier 1 trailing whitespace',
  { f: 'a  \nb\n' },
  [],
  '--- f\n+++ f\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n',
  0,
  'M f\nok: 1 file\n',
  { f: 'A\nb\n' },
);
t(
  'unified: tier 2 re-indent',
  { f: '  foo():\n    return 1\n' },
  [],
  '--- f\n+++ f\n@@ -1,2 +1,2 @@\n foo():\n-  return 1\n+  return 2\n',
  0,
  'M f\nok: 1 file\n',
  { f: '  foo():\n    return 2\n' },
);
t(
  'unified: CRLF file keeps CRLF',
  { f: 'a\r\nb\r\nc\r\n' },
  [],
  '--- f\n+++ f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
  0,
  'M f\nok: 1 file\n',
  { f: 'a\r\nB\r\nc\r\n' },
);
t(
  'unified: match to end without backslash gains a final break',
  { f: 'a\nb' },
  [],
  '--- f\n+++ f\n@@ -2,1 +2,1 @@\n-b\n+B\n',
  0,
  'M f\nok: 1 file\n',
  { f: 'a\nB\n' },
);
t(
  'unified: backslash keeps no final break',
  { f: 'a\nb' },
  [],
  '--- f\n+++ f\n@@ -2,1 +2,1 @@\n-b\n+B\n\\ No newline at end of file\n',
  0,
  'M f\nok: 1 file\n',
  { f: 'a\nB' },
);
t(
  'unified: create',
  {},
  [],
  'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n',
  0,
  'A new.txt\nok: 1 file\n',
  { 'new.txt': 'one\ntwo\n' },
);
t(
  'unified: create without final break',
  {},
  [],
  '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+one\n\\ No newline at end of file\n',
  0,
  'A new.txt\nok: 1 file\n',
  { 'new.txt': 'one' },
);
t('unified: delete', { f: 'x\n' }, [], '--- a/f\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n', 0, 'D f\nok: 1 file\n', { f: null });
t(
  'unified: rename prints one R line',
  { 'a.txt': 'one\ntwo\n' },
  [],
  'diff --git a/a.txt b/b.txt\nrename from a.txt\nrename to b.txt\n--- a/a.txt\n+++ b/b.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n',
  0,
  'R a.txt -> b.txt\nok: 1 file\n',
  { 'a.txt': null, 'b.txt': 'one\n2\n' },
);
t('unified: missing file', {}, [], '--- a/ghost.txt\n+++ b/ghost.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n', 1, 'error: missing ghost.txt\nfailed: 1 of 1 edits\n');
t(
  'unified: create over an existing file',
  { f: 'x\n' },
  [],
  '--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+y\n',
  1,
  'error: exists f\nfailed: 1 of 1 edits\n',
  { f: 'x\n' },
);
t('unified: bad hunk header is parse 2', { f: 'x\n' }, [], 'diff --git a/f b/f\n@@ -x +y @@\n', 2, 'error: parse 2\n');
t(
  'unified: dangling --- in a header is parse 3',
  { f: 'x\n' },
  [],
  'diff --git a/f b/f\n--- f\nfoo\n',
  2,
  'error: parse 3\n',
);
t(
  'unified: two files sort by path',
  { a: '1\n', b: '2\n' },
  [],
  'diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1,1 +1,1 @@\n-2\n+two\ndiff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,1 +1,1 @@\n-1\n+one\n',
  0,
  'M a\nM b\nok: 2 files\n',
  { a: 'one\n', b: 'two\n' },
);
t(
  'unified: empty old inserts after A lines',
  { f: 'a\nc\n' },
  [],
  '--- f\n+++ f\n@@ -1,0 +2 @@\n+b\n',
  0,
  'M f\nok: 1 file\n',
  { f: 'a\nb\nc\n' },
);
t(
  'unified: prose and fences around the patch are ignored',
  { f: ABC },
  [],
  'Here is the fix:\n```diff\ndiff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n```\nDone.\n',
  0,
  'M f\nok: 1 file\n',
  { f: 'a\nB\nc\n' },
);

// --------------------------------------------- search-replace and V4A cases
const SR = (path, oldLines, newLines) =>
  `${path}\n<<<<<<< SEARCH\n${oldLines}=======\n${newLines}>>>>>>> REPLACE\n`;

t('sr: basic', { f: ABC }, [], SR('f', 'b\n', 'B\n'), 0, 'M f\nok: 1 file\n', { f: 'a\nB\nc\n' });
t('sr: empty old creates', {}, [], SR('new.txt', '', 'hello\n'), 0, 'A new.txt\nok: 1 file\n', { 'new.txt': 'hello\n' });
t(
  'sr: two occurrences are ambiguous',
  { f: 'two\ntwo\n' },
  [],
  SR('f', 'two\n', '2\n'),
  1,
  'error: ambiguous f\nfailed: 1 of 1 edits\n',
  { f: 'two\ntwo\n' },
);
t('sr: missing file', {}, [], SR('ghost', 'a\n', 'A\n'), 1, 'error: missing ghost\nfailed: 1 of 1 edits\n');
t('sr: no match', { f: ABC }, [], SR('f', 'z\n', 'Z\n'), 1, 'error: no-match f\nfailed: 1 of 1 edits\n', { f: ABC });
t(
  'sr: tier 2 re-indent',
  { f: '  foo():\n    return 1\n' },
  [],
  SR('f', 'foo():\n  return 1\n', 'foo():\n  return 2\n'),
  0,
  'M f\nok: 1 file\n',
  { f: '  foo():\n    return 2\n' },
);
t(
  'sr: second block reuses the previous path',
  { f: ABC },
  [],
  `${SR('f', 'a\n', 'A\n')}<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n`,
  0,
  'M f\nok: 1 file\n',
  { f: 'A\nB\nc\n' },
);
t('sr: no ======= is parse 2', { f: ABC }, [], 'f\n<<<<<<< SEARCH\nb\n>>>>>>> REPLACE\n', 2, 'error: parse 2\n');
t(
  'sr: CRLF file keeps CRLF',
  { f: 'a\r\nb\r\nc\r\n' },
  [],
  SR('f', 'b\n', 'B\n'),
  0,
  'M f\nok: 1 file\n',
  { f: 'a\r\nB\r\nc\r\n' },
);
t('sr: unsafe path', { f: ABC }, [], SR('../escape.txt', 'b\n', 'B\n'), 1, 'error: unsafe ../escape.txt\nfailed: 1 of 1 edits\n');

const V4A_ADD = '*** Begin Patch\n*** Add File: new.txt\n+one\n+two\n*** End Patch\n';
t('v4a: add', {}, [], V4A_ADD, 0, 'A new.txt\nok: 1 file\n', { 'new.txt': 'one\ntwo\n' });
t('v4a: add over existing fails', { 'new.txt': 'x\n' }, [], V4A_ADD, 1, 'error: exists new.txt\nfailed: 1 of 1 edits\n');
t(
  'v4a: delete',
  { f: 'x\n' },
  [],
  '*** Begin Patch\n*** Delete File: f\n*** End Patch\n',
  0,
  'D f\nok: 1 file\n',
  { f: null },
);
t(
  'v4a: anchor moves the cursor past the first copy',
  { f: 'def a():\n    return 1\ndef b():\n    return 1\n' },
  [],
  '*** Begin Patch\n*** Update File: f\n@@ def b():\n-    return 1\n+    return 2\n*** End Patch\n',
  0,
  'M f\nok: 1 file\n',
  { f: 'def a():\n    return 1\ndef b():\n    return 2\n' },
);
t(
  'v4a: move prints one R line',
  { 'a.txt': 'one\ntwo\n' },
  [],
  '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@ one\n two\n*** End Patch\n',
  0,
  'R a.txt -> b.txt\nok: 1 file\n',
  { 'a.txt': null, 'b.txt': 'one\ntwo\n' },
);
t(
  'v4a: end-of-file chunk only matches at the end',
  { f: 'a\nb\n' },
  [],
  '*** Begin Patch\n*** Update File: f\n@@ a\n-b\n+B\n*** End of File\n*** End Patch\n',
  0,
  'M f\nok: 1 file\n',
  { f: 'a\nB\n' },
);
t('v4a: missing End Patch is parse 4', {}, [], '*** Begin Patch\n*** Add File: x\n+y\n', 2, 'error: parse 4\n');
t(
  'v4a: update with no chunk is parse 2',
  {},
  [],
  '*** Begin Patch\n*** Update File: f\n*** End Patch\n',
  2,
  'error: parse 2\n',
);
t('v4a: anchor with no match', { f: 'a\nb\n' }, [], '*** Begin Patch\n*** Update File: f\n@@ zzz\n a\n-b\n+B\n*** End Patch\n', 1, 'error: no-match f\nfailed: 1 of 1 edits\n');

// ------------------------------------------------------------ JSON cases
t(
  'json: create',
  {},
  [],
  '{"command":"create","path":"n.txt","file_text":"hi"}\n',
  0,
  'A n.txt\nok: 1 file\n',
  { 'n.txt': 'hi' },
);
t('json: str_replace', { f: ABC }, [], '{"command":"str_replace","path":"f","old_str":"b","new_str":"B"}\n', 0, 'M f\nok: 1 file\n', {
  f: 'a\nB\nc\n',
});
t(
  'json: str_replace in a CRLF file',
  { f: 'a\r\nb\r\nc\r\n' },
  [],
  '{"command":"str_replace","path":"f","old_str":"b","new_str":"B"}\n',
  0,
  'M f\nok: 1 file\n',
  { f: 'a\r\nB\r\nc\r\n' },
);
t('json: insert', { f: ABC }, [], '{"command":"insert","path":"f","insert_line":1,"new_str":"x"}\n', 0, 'M f\nok: 1 file\n', {
  f: 'a\nx\nb\nc\n',
});
t(
  'json: str_replace twice is ambiguous',
  { f: 'b\nb\n' },
  [],
  '{"command":"str_replace","path":"f","old_str":"b","new_str":"B"}\n',
  1,
  'error: ambiguous f\nfailed: 1 of 1 edits\n',
);
t(
  'json: insert past the end is no-match',
  { f: ABC },
  [],
  '{"command":"insert","path":"f","insert_line":99,"new_str":"x"}\n',
  1,
  'error: no-match f\nfailed: 1 of 1 edits\n',
);
t('json: bad command in an array is parse 1', {}, [], '[{"command":"explode","path":"f"}]\n', 2, 'error: parse 1\n');
t('json: bad line in JSON Lines is parse 2', {}, [], '{"command":"create","path":"a","file_text":"x"}\nnot json\n', 2, 'error: parse 2\n');

// ------------------------------------------- atomicity, --check, --strict
t(
  'atomic: one failed edit writes nothing',
  { f: ABC },
  [],
  `${SR('f', 'a\n', 'A\n')}${SR('f', 'z\n', 'Z\n')}`,
  1,
  'error: no-match f\nfailed: 1 of 2 edits\n',
  { f: ABC },
);
t(
  'check: reports the change, writes nothing',
  { f: ABC },
  ['--check'],
  SR('f', 'b\n', 'B\n'),
  0,
  'M f\nok: 1 file\n',
  { f: ABC },
);
t(
  'check: a failing patch still fails',
  { f: ABC },
  ['--check'],
  SR('f', 'z\n', 'Z\n'),
  1,
  'error: no-match f\nfailed: 1 of 1 edits\n',
  { f: ABC },
);
t(
  'strict: tier 1 match is no-match under --strict',
  { f: 'a  \nb\n' },
  ['--strict'],
  SR('f', 'a\n', 'A\n'),
  1,
  'error: no-match f\nfailed: 1 of 1 edits\n',
  { f: 'a  \nb\n' },
);
t(
  'noop: replacing a line with itself changes nothing',
  { f: ABC },
  [],
  SR('f', 'b\n', 'b\n'),
  0,
  'ok: 0 files\n',
  { f: ABC },
);

// ------------------------------------------------------- examples on disk
function example(name, aTxt, exit, stdout) {
  const patch = readFileSync(join(EXAMPLES, name), 'utf8');
  const got2 = runCli({ 'a.txt': aTxt, [name]: patch }, [name], null);
  const why = [];
  if (got2.exit !== exit) why.push(`exit ${got2.exit}, expected ${exit}`);
  if (got2.stdout !== stdout) why.push(`stdout ${JSON.stringify(got2.stdout)}, expected ${JSON.stringify(stdout)}`);
  note(why.length === 0, `example: ${name}`, why.join('; '));
}

const THREE = 'one\ntwo\nthree\n';
example('good-unified.patch', THREE, 0, 'M a.txt\nok: 1 file\n');
example('good-search-replace.patch', THREE, 0, 'M a.txt\nok: 1 file\n');
example('good-v4a.patch', THREE, 0, 'M a.txt\nok: 1 file\n');
example('good-json.patch', THREE, 0, 'M a.txt\nok: 1 file\n');
example('bad-no-match.patch', THREE, 1, 'error: no-match a.txt\nfailed: 1 of 1 edits\n');
example('bad-ambiguous.patch', 'two\ntwo\n', 1, 'error: ambiguous a.txt\nfailed: 1 of 1 edits\n');
example('bad-unsafe.patch', THREE, 1, 'error: unsafe ../escape.txt\nfailed: 1 of 1 edits\n');
example('bad-parse.patch', THREE, 2, 'error: parse 2\n');

// ------------------------------------------------------- practice rounds
const rounds = [];
if (PRACTICE === null) {
  process.stdout.write('practice: SKIPPED (no practice.json found; pass its path)\n');
} else {
  for (let round = 1; round <= 5; round += 1) {
    const r = spawnSync(process.execPath, [CHECK, PRACTICE], { encoding: 'utf8', timeout: 300_000 });
    const line = (r.stdout ?? '').trim().split('\n').pop() ?? '';
    rounds.push(line);
    note(line === '100 of 100 passed: practice score 1000', `practice round ${round}`, line);
  }
  note(new Set(rounds).size === 1, 'practice rounds are identical', rounds.join(' | '));
}

process.stdout.write(`selftest: ${passed} passed, ${failed} failed\n`);
if (failures.length > 0) {
  for (const f of failures) process.stdout.write(`FAIL ${f}\n`);
}
const record = [
  '# SELFTEST',
  '',
  `- practice rounds (5): ${rounds.length === 0 ? 'skipped' : rounds.join(' | ')}`,
  `- total checks: ${passed} passed, ${failed} failed (62 hand-written edge cases + 8 examples + 6 practice-round notes)`,
  `- practice file: ${PRACTICE ?? 'not found'}`,
  '',
  ...(failures.length === 0 ? ['All green.'] : failures.map((f) => `- FAIL ${f}`)),
  '',
].join('\n');
writeFileSync(join(ROOT, 'SELFTEST.md'), record);
process.exit(failed === 0 ? 0 : 1);
