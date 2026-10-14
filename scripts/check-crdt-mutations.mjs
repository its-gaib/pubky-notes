import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Every deliberate defect is applied to a temporary copy, never the working tree.
const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'pubky-notes-crdt-mutations-'))
const coreTests = 'src/lib/crdt.convergence.test.ts'
const storageTests = 'src/lib/notebook-sync.integration.test.ts'
const mutations = [
  {
    name: 'discard remote CRDT operations', file: 'src/lib/crdt.ts', tests: coreTests,
    before: 'Y.applyUpdate(doc, decode(b.crdt.update))',
    after: '/* Deliberate defect: discard the remote update. */',
  },
  {
    name: 'replace incremental edits with whole-text replacement', file: 'src/lib/crdt.ts', tests: coreTests,
    before: '  let index = 0\n  for (const [operation, chunk] of diff(text.toString(), value)) {',
    after: '  text.delete(0, text.length)\n  text.insert(0, value)\n  return\n  let index = 0\n  for (const [operation, chunk] of diff(text.toString(), value)) {',
  },
  {
    name: 'drop newer edits from the upload queue on a late acknowledgement', file: 'src/lib/local-notebook.ts', tests: storageTests,
    before: 'const pending = noteRevision(record.note) !== noteRevision(incoming.note)',
    after: 'const pending = false',
  },
  {
    name: 'stop following recovered histories for stale local writes', file: 'src/lib/local-notebook.ts', tests: storageTests,
    before: 'const destination = await resolveLocalDestination(transaction, scope, prepared.note)',
    after: 'const destination = await resolveDestination(transaction, scope, prepared.note.id)',
  },
  {
    name: 'leak private CRDT history into public snapshots', file: 'src/lib/notes.ts', tests: storageTests,
    before: 'return { id: note.id, title: note.title, content: note.content, createdAt: note.createdAt, updatedAt: note.updatedAt }',
    after: 'return { ...note, id: note.id, title: note.title, content: note.content, createdAt: note.createdAt, updatedAt: note.updatedAt }',
  },
  {
    name: 'publish unreviewed merged remote text', file: 'src/lib/notes.ts', tests: storageTests,
    before: 'const snapshot = publicSnapshot(reviewed)',
    after: 'const snapshot = publicSnapshot(merged)',
  },
]

async function runTests(name, files, index) {
  const reportPath = join(scratch, `report-${index}.json`)
  const result = spawnSync(process.execPath, [
    join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...files,
    '--maxWorkers=1', '--reporter=json', `--outputFile=${reportPath}`,
  ], { cwd: scratch, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  if (result.error || result.signal) throw new Error(`${name}: test runner did not complete`, { cause: result.error })
  let report
  try { report = JSON.parse(await readFile(reportPath, 'utf8')) }
  catch (error) { throw new Error(`${name}: no valid test report\n${result.stderr}`, { cause: error }) }
  // Import errors, missing tests, or runner failures cannot count as killed mutants.
  const assertions = report.testResults.flatMap(suite => suite.assertionResults ?? [])
  assert.ok(assertions.length > 0, `${name}: no tests executed`)
  const failures = assertions.filter(test => test.status === 'failed')
  return { status: result.status, success: report.success, assertions, failures }
}

try {
  for (const path of ['src', 'package.json', 'tsconfig.json', 'vite.config.ts']) {
    await cp(join(root, path), join(scratch, path), { recursive: true })
  }
  await symlink(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const baseline = await runTests('baseline', [coreTests, storageTests], 'baseline')
  assert.equal(baseline.status, 0, 'The unmodified test baseline must pass before checking mutations.')
  assert.equal(baseline.success, true)
  console.log(`Baseline passed: ${baseline.assertions.length} tests.`)

  for (const [index, mutation] of mutations.entries()) {
    const path = join(scratch, mutation.file)
    const original = await readFile(path, 'utf8')
    assert.equal(original.split(mutation.before).length, 2, `${mutation.name}: expected exactly one mutation target; update the harness after refactoring.`)
    try {
      await writeFile(path, original.replace(mutation.before, mutation.after))
      const result = await runTests(mutation.name, [mutation.tests], index)
      assert.notEqual(result.status, 0, `SURVIVED: ${mutation.name}`)
      assert.ok(result.failures.length > 0, `${mutation.name}: runner failed without a failing test`)
      console.log(`Caught: ${mutation.name} (${result.failures.length} failing tests).`)
    } finally {
      await writeFile(path, original)
    }
  }
  console.log(`All ${mutations.length} deliberate defects were caught. Working-tree code was never modified.`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
