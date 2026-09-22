// One sentence per library action, in the reader's language.
//
// Shared by the assistant panel (what it proposes) and the lab's list of
// recent changes (what it did), so the same change is described the same way
// in both places. `past` switches to the "did" wording for the history.
export function actionLabel(t, a, past = false) {
  const k = (key) => (past ? key.replace(/^act/, 'did') : key)
  const n = (a.paper_ids || []).length
  if (a.kind === 'create_folder') {
    return a.parent
      ? t(k('actCreateFolderIn'), { name: a.name, parent: a.parent })
      : t(k('actCreateFolder'), { name: a.name })
  }
  if (a.kind === 'move_papers') {
    return (a.folder || '').toLowerCase() === 'unfiled'
      ? t(k('actUnfile'), { n })
      : t(k('actMovePapers'), { n, folder: a.folder })
  }
  if (a.kind === 'add_tags') {
    return t(k('actAddTags'), { n, tags: (a.tags || []).join('、') })
  }
  if (a.kind === 'set_reading_state') {
    return t(k('actSetState'), {
      n,
      state: a.state ? t(`state_${a.state}`) : t('stateUnset'),
    })
  }
  if (a.kind === 'write_record') return t(k('actWriteRecord'), { title: a.title })
  if (a.kind === 'amend_record') return t(k('actAmendRecord'))
  if (a.kind === 'write_note') return t(k('actWriteNote'))
  return a.kind
}
