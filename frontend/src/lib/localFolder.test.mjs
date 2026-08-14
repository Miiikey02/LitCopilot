// Naming and planning, which are pure and where the damage would be done.
// Run with plain node: `node src/lib/localFolder.test.mjs`.
//
// The filesystem parts need a browser and a user's consent, so they are not
// covered here; these are the decisions that turn a match into a new path, and
// a wrong one renames somebody's paper.

import { buildPlan, safeName, GAZE_DIR, UNMATCHED_DIR } from './localFolder.js'

let failed = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed += 1
  console.log(`${ok ? 'OK ' : 'BAD'} ${label.padEnd(52)} ${JSON.stringify(got)}` +
    (ok ? '' : `\n${''.padEnd(56)}!= ${JSON.stringify(want)}`))
}

// --- safeName --------------------------------------------------------------
check('strips path separators', safeName('CRISPR/Cas9: a review'), 'CRISPR Cas9 a review')
check('strips characters Windows forbids', safeName('What? "Yes" <or> no|maybe*'), 'What Yes or no maybe')
check('collapses whitespace', safeName('a   b\n\nc'), 'a b c')
check('trims trailing dots and spaces', safeName('Trailing dot. '), 'Trailing dot')
check('keeps Chinese', safeName('青光眼神经保护'), '青光眼神经保护')
check('truncates long titles', safeName('x'.repeat(200)).length, 110)
check('empty stays empty', safeName(''), '')

// --- buildPlan -------------------------------------------------------------
const file = (path) => ({
  path,
  name: path.split('/').pop(),
  dirPath: path.split('/').slice(0, -1).join('/'),
})

const matched = (title, key, folder = '') => ({
  paper_id: 1, title, citation_key: key, folder,
})

{
  const files = [file('1-s2.0-S009286742031234-main.pdf')]
  const m = new Map([[files[0].path, matched('CRISPR/Cas9 therapeutics', 'Tribble, 2021', '基因编辑')]])
  const plan = buildPlan(files, m, { intoFolders: true })
  check('renames and files a match', plan[0].to, '基因编辑/Tribble, 2021 - CRISPR Cas9 therapeutics.pdf')
  check('records where it came from', plan[0].from, '1-s2.0-S009286742031234-main.pdf')
  check('marked as matched', plan[0].matched, true)
}

{
  const files = [file('download.pdf')]
  const m = new Map([[files[0].path, matched('A paper', 'Wu, 2023', '青光眼')]])
  check('leaves papers where they are when asked',
    buildPlan(files, m, { intoFolders: false })[0].to, 'Wu, 2023 - A paper.pdf')
}

{
  // Two different files that resolve to the same name must not collide.
  const files = [file('a.pdf'), file('b.pdf')]
  const same = matched('Same paper', 'Wu, 2023')
  const m = new Map([['a.pdf', same], ['b.pdf', same]])
  const plan = buildPlan(files, m, { intoFolders: false })
  check('collisions are numbered, never overwritten',
    plan.map((c) => c.to), ['Wu, 2023 - Same paper.pdf', 'Wu, 2023 - Same paper (2).pdf'])
}

{
  const files = [file('Wu, 2023 - Same paper.pdf')]
  const m = new Map([[files[0].path, matched('Same paper', 'Wu, 2023')]])
  check('a file already correctly named is left alone',
    buildPlan(files, m, { intoFolders: false }), [])
}

{
  const files = [file('mystery.pdf')]
  const m = new Map([[files[0].path, { paper_id: null }]])
  check('unmatched files are untouched by default',
    buildPlan(files, m, { moveUnmatched: false }), [])
  const moved = buildPlan(files, m, { moveUnmatched: true })
  check('unmatched move aside only when asked',
    moved[0].to, `${GAZE_DIR}/${UNMATCHED_DIR}/mystery.pdf`)
  check('and are marked unmatched', moved[0].matched, false)
  check('and keep their original name', moved[0].to.endsWith('mystery.pdf'), true)
}

{
  // A title carrying a slash must not become a directory.
  const files = [file('x.pdf')]
  const m = new Map([[files[0].path, matched('A/B testing in trials', 'Li, 2020', 'Methods/Stats')]])
  const plan = buildPlan(files, m, { intoFolders: true })
  check('folder name is sanitised too', plan[0].to, 'Methods Stats/Li, 2020 - A B testing in trials.pdf')
  check('exactly one separator in the result', plan[0].to.split('/').length, 2)
}

{
  const files = [file('nested/deep/paper.pdf')]
  const m = new Map([[files[0].path, matched('Deep paper', 'Ng, 2019')]])
  check('a nested file stays nested when not being filed',
    buildPlan(files, m, { intoFolders: false })[0].to, 'nested/deep/Ng, 2019 - Deep paper.pdf')
}

{
  const files = [file('no-key.pdf')]
  const m = new Map([[files[0].path, { paper_id: 2, title: 'Only a title', citation_key: '' }]])
  check('falls back to the title with no citation key',
    buildPlan(files, m, { intoFolders: false })[0].to, 'Only a title.pdf')
}

console.log(failed ? `\n${failed} FAILED` : '\nlocal folder planning is sound')
process.exit(failed ? 1 : 0)
