import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import LibraryChat from './LibraryChat'
import Icon from './Icon'
import FolderTree, { PAPER_DRAG } from './FolderTree'
import NotePanel from './NotePanel'
import CiteButton from './CiteButton'
import ReadState, { ReadStateFilter } from './ReadState'
import BulkExport from './BulkExport'
import ImportPanel from './ImportPanel'
import LibrarianPanel from './LibrarianPanel'
import LocalFolderPanel from './LocalFolderPanel'
import AssistantDesigner from './AssistantDesigner'
import RecordsList from './RecordsList'
import WorkspaceBar from './WorkspaceBar'

const sourceLabel = {
  pubmed: 'PubMed',
  semantic_scholar: 'Semantic Scholar',
  openalex: 'OpenAlex',
  biorxiv: 'bioRxiv',
}

// A paper you uploaded is identified by its upload id rather than a DOI, and
// 精读模式 resolves that identifier directly.
const isUpload = (paper) =>
  paper.source === 'upload' || (paper.source_id || '').startsWith('upload:')

// Which identifier 精读模式 should open this paper with.
//
// An upload carries the DOI of the published article, because that is what
// makes it cite correctly — but the DOI locates the *publisher's* copy, which
// is usually paywalled and resolves to an abstract. The file the reader
// actually has is the upload, so for an upload the upload id always wins.
const readerIdFor = (paper) =>
  isUpload(paper) ? paper.source_id : paper.doi || paper.source_id

function UploadPdf({ teamId, folderId, onDone }) {
  const { t } = useTranslation()
  const input = useRef(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')

  // An uploaded PDF joins the library as a paper in its own right: it is
  // identified by its upload id, which 精读模式 resolves the same way it
  // resolves a DOI, so everything downstream works without a special case.
  const take = async (file) => {
    if (!file || busy) return
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      return setError(t('uploadNotPdf'))
    }
    setBusy(true)
    setError('')
    try {
      const up = await api.paperUpload(file)
      // The server resolves the DOI printed on the PDF against the same index
      // the search uses, so the card carries real authors, journal, year and
      // citation key. The fallback only matters for a paper that resolves to
      // nothing at all.
      const card = up.paper || {
        source: 'upload',
        source_id: up.identifier,
        title: up.title || file.name.replace(/\.pdf$/i, ''),
        title_zh: '',
        authors: [],
        year: null,
        venue: '',
        url: '',
        doi: '',
        citation_key: (up.title || file.name).slice(0, 40),
        relevance_zh: '',
        has_full_text: true,
      }
      await api.saveLibrary(card, teamId || null)
      onDone()
    } catch (err) {
      setError(err.message || t('uploadFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        take(e.dataTransfer.files?.[0])
      }}
      className={`mb-4 rounded-xl border-2 border-dashed px-4 py-3 text-sm transition-colors ${
        dragging
          ? 'border-blue-400 bg-blue-50/60'
          : 'border-slate-200 bg-slate-50/60 hover:border-slate-300'
      }`}
    >
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          take(f)
        }}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          onClick={() => input.current?.click()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-all hover:bg-slate-800 active:scale-[0.98] disabled:opacity-60"
        >
          <Icon name="filePlus" />
          {busy ? t('uploadingPdf') : t('uploadPdf')}
        </button>
        <span className="text-slate-500">{t('uploadDropHint')}</span>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}


function LibraryCard({ paper, folders = [], teamId, onChanged }) {
  const { t } = useTranslation()
  const [newTag, setNewTag] = useState('')
  const [noteOpen, setNoteOpen] = useState(false)



  const addTag = async (e) => {
    e.preventDefault()
    const tag = newTag.trim()
    if (!tag) return
    await api.addTag(paper.id, tag, teamId)
    setNewTag('')
    onChanged()
  }

  const removeTag = async (tag) => {
    await api.removeTag(paper.id, tag, teamId)
    onChanged()
  }

  const remove = async () => {
    try {
      await api.deletePaper(paper.id, teamId)
    } catch (err) {
      // A shared shelf refuses removals that are not yours; say why rather
      // than appearing to do nothing.
      window.alert(err?.status === 403 ? t('ownerOnlyDelete') : t('errorNetwork'))
      return
    }
    onChanged()
  }

  return (
    <div
      draggable
      onDragStart={(e) => {
        // A custom type so a folder drag and a paper drag stay distinguishable
        // during dragover, where the payload itself cannot be read.
        e.dataTransfer.setData(PAPER_DRAG, String(paper.id))
        e.dataTransfer.setData('text/plain', paper.title)
        e.dataTransfer.effectAllowed = 'move'
      }}
      title={t('dragPaperHint')}
      className="card-hover cursor-grab rounded-xl border border-slate-200 bg-white p-4 shadow-sm active:cursor-grabbing"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
          {isUpload(paper) ? t('uploadedPdf') : sourceLabel[paper.source] || paper.source}
        </span>
        <span className="text-xs font-medium text-blue-700">[{paper.citation_key}]</span>
      </div>

      {paper.retraction_status && (
        <div
          className={`mb-2 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
            paper.retraction_status === 'retracted'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-amber-200 bg-amber-50 text-amber-900'
          }`}
        >
          <Icon name="alert" className="mt-0.5 shrink-0" />
          <span>
            <span className="font-semibold">
              {paper.retraction_status === 'retracted'
                ? t('retracted')
                : t('concernRaised')}
            </span>
            {' · '}
            {t('retractedHint')}
          </span>
        </div>
      )}
      {paper.title_zh && (
        <h3 className="mb-0.5 font-semibold leading-6 text-slate-900">{paper.title_zh}</h3>
      )}
      <p className="text-sm leading-6 text-slate-600">{paper.title}</p>
      <p className="mt-2 text-xs text-slate-500">
        {paper.authors.slice(0, 4).join(', ')}
        {paper.authors.length > 4 ? ' et al.' : ''}
        {paper.year ? ` · ${paper.year}` : ''}
        {paper.venue ? ` · ${paper.venue}` : ''}
      </p>
      {/* In a shared lab library, show who contributed the paper. */}
      {teamId && paper.added_by && (
        <p className="mt-1 text-xs text-slate-400">
          {t('addedBy', { who: paper.added_by })}
        </p>
      )}

      {/* Reading state belongs with the paper's own facts rather than with the
          buttons: it is something true about the paper, not an action. */}
      <div className="mt-2">
        <ReadState paper={paper} teamId={teamId} onChanged={onChanged} />
      </div>

      {/* Your own note on this paper — also used by library chat as evidence */}
      <div className="mt-3">
        {/* The note opens in its own panel: a paragraph of thinking should
            not have to fit in a textarea wedged between the tags and the
            buttons, and the card should not resize while you type. */}
        {paper.notes ? (
          <button
            onClick={() => setNoteOpen(true)}
            className="w-full rounded-md bg-amber-50 p-2 text-left text-sm text-amber-900 transition-colors hover:bg-amber-100"
            title={t('openNote')}
          >
            <span className="font-medium">
              <Icon name="note" className="mr-1" />
              {t('checkNote')}：
            </span>
            <span className="line-clamp-2">{paper.notes}</span>
          </button>
        ) : (
          <button
            onClick={() => setNoteOpen(true)}
            className="text-xs text-slate-400 transition-colors hover:text-slate-700"
          >
            <Icon name="note" className="mr-1" />
            {t('addNote')}
          </button>
        )}
      </div>

      {/* Tags */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {paper.tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="text-blue-400 hover:text-blue-700"
              aria-label="remove tag"
            >
              ×
            </button>
          </span>
        ))}
        <form onSubmit={addTag} className="inline-flex">
          <input
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            placeholder={t('addTagPlaceholder')}
            className="w-44 rounded-l-md border border-slate-300 px-2 py-0.5 text-xs focus:border-blue-500 focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-r-md border border-l-0 border-slate-300 bg-slate-50 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100"
          >
            {t('addTag')}
          </button>
        </form>
      </div>

      {noteOpen && (
        <NotePanel
          paper={paper}
          teamId={teamId}
          onClose={() => setNoteOpen(false)}
          onSaved={onChanged}
        />
      )}

      {/* Actions in two groups on one line: what you do with the paper on the
          left, where it lives on the right. They wrap as groups rather than
          spilling one button at a time, which is what made this two ragged
          rows in a narrow column. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-x-4 gap-y-2">
          {readerIdFor(paper) && (
            <button
              type="button"
              onClick={() =>
                window.open(
                  `/read?id=${encodeURIComponent(readerIdFor(paper))}`,
                  '_blank',
                  'noopener'
                )
              }
              className="whitespace-nowrap text-sm font-medium text-slate-700 transition-colors hover:text-blue-700"
            >
              <Icon name="bookOpen" className="mr-1" />
              {t('openReader')}
            </button>
          )}
          <CiteButton paper={paper} />
          {paper.url && !isUpload(paper) && (
            <a
              href={paper.url}
              target="_blank"
              rel="noopener noreferrer"
              className="whitespace-nowrap text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
            >
              {t('viewSource')} <Icon name="externalLink" className="ml-0.5" />
            </a>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          {/* Which folder it is in is still worth seeing; it just stopped
              being a control, because filing is now done by dragging. */}
          {paper.folder_id != null && (
            <span className="inline-flex items-center gap-1 text-xs text-slate-400">
              <Icon name="folder" />
              {folders.find((f) => String(f.id) === String(paper.folder_id))?.name || ''}
            </span>
          )}
          <button
            type="button"
            onClick={remove}
            title={t('delete')}
            className="rounded p-1 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>
    </div>
  )
}

// Folder navigation. The tree itself lives in FolderTree; this holds the
// actions, so creating, renaming, moving and deleting stay in one place with
// the workspace they belong to.
function FolderSidebar({ folders, active, onPick, onChanged, total, teamId }) {
  const { t } = useTranslation()
  const [error, setError] = useState('')
  const unfiled = folders.find((f) => f.id === null)

  const create = async (parentId) => {
    const name = window.prompt(parentId ? t('newSubfolder') : t('newFolder'))
    if (!name || !name.trim()) return
    try {
      await api.createFolder(name.trim(), teamId, parentId)
      setError('')
      onChanged()
    } catch {
      setError(t('folderExists'))
    }
  }

  const rename = async (folder) => {
    const name = window.prompt(t('renameFolder'), folder.name)
    if (!name || name.trim() === folder.name) return
    try {
      await api.renameFolder(folder.id, name.trim(), teamId)
      onChanged()
    } catch {
      setError(t('folderExists'))
    }
  }

  const remove = async (folder) => {
    if (!window.confirm(t('deleteFolderConfirm', { name: folder.name }))) return
    try {
      await api.deleteFolder(folder.id, teamId)
    } catch (err) {
      // A shared workspace refuses deletions that are not yours; say why
      // rather than appearing to do nothing.
      setError(err?.status === 403 ? t('ownerOnlyFolder') : t('errorNetwork'))
      return
    }
    if (active === String(folder.id)) onPick(null)
    onChanged()
  }

  // Dropping a paper on a folder files it there; dropping it on 未分类 takes
  // it out of every folder.
  const file = async (paperId, folderId) => {
    try {
      await api.movePaper(paperId, folderId, teamId)
      onChanged()
    } catch {
      setError(t('errorNetwork'))
    }
  }

  const move = async (folderId, parentId) => {
    try {
      await api.moveFolder(folderId, parentId, teamId)
      onChanged()
    } catch {
      // The server refuses a move that would detach a branch from the tree.
      setError(t('folderMoveRefused'))
    }
  }

  return (
    <div className="min-w-0">
      <FolderTree
        folders={folders}
        active={active}
        onPick={onPick}
        onCreate={create}
        onRename={rename}
        onDelete={remove}
        onMove={move}
        onFilePaper={file}
        totalCount={total}
        unfiledCount={unfiled?.count ?? 0}
      />
      {error && <p className="mt-2 px-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}

// A face for each built-in; anything custom falls back to the spark.
const ASSISTANT_ICON = {
  library: 'sparkles',
  records: 'flask',
  writing: 'note',
}

export default function LibraryTab() {
  const { t, i18n } = useTranslation()
  const [papers, setPapers] = useState([])
  const [tags, setTags] = useState([])
  const [folders, setFolders] = useState([])
  const [activeTag, setActiveTag] = useState(null)
  const [activeFolder, setActiveFolder] = useState(null) // null | id string | 'unfiled'
  const [activeState, setActiveState] = useState(null) // null | a reading state | 'unset'
  const [stateCounts, setStateCounts] = useState({})
  const [query, setQuery] = useState('')
  const [teams, setTeams] = useState([])
  // null = personal library; otherwise the active team's id (as a string).
  const [activeTeam, setActiveTeam] = useState(null)
  const [importing, setImporting] = useState(false)
  // Which assistant a button opened, or null when none is open.
  const [librarian, setLibrarian] = useState(null)
  const [assistants, setAssistants] = useState([])
  const [designing, setDesigning] = useState(false)
  const [localFolder, setLocalFolder] = useState(false)
  // 'papers' | 'records' — the shelf, or the notebook.
  const [view, setView] = useState('papers')

  const [loadError, setLoadError] = useState('')

  const load = async () => {
    try {
      const [ps, ts, fs, cs] = await Promise.all([
        api.listLibrary(activeTag, activeFolder, query, activeTeam, activeState),
        api.listTags(activeTeam),
        api.listFolders(activeTeam),
        api.readStateCounts(activeTeam).catch(() => ({})),
      ])
      setPapers(ps)
      setTags(ts)
      setFolders(fs)
      setStateCounts(cs || {})
      setLoadError('')
    } catch {
      // Surface the failure instead of silently rendering an empty library,
      // which would look like the user had lost their saved papers.
      setLoadError(t('libraryLoadError'))
    }
  }

  useEffect(() => {
    api
      .listAssistants(activeTeam, i18n.language)
      .then(setAssistants)
      .catch(() => {})
  }, [activeTeam, i18n.language])

  useEffect(() => {
    // Debounce so typing in the search box doesn't fire a request per keystroke.
    const id = setTimeout(load, query ? 250 : 0)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTag, activeFolder, query, activeTeam, activeState])

  const loadTeams = async () => {
    try {
      setTeams(await api.listTeams())
    } catch {
      /* teams are optional; personal library still works */
    }
  }

  useEffect(() => {
    loadTeams()
  }, [])

  // Switching workspace resets filters, which belong to the old one.
  const switchWorkspace = (teamId) => {
    setActiveTeam(teamId)
    setActiveTag(null)
    setActiveFolder(null)
    setQuery('')
  }

  const total = folders.reduce((n, f) => n + f.count, 0)

  return (
    <div>
      <WorkspaceBar
        teams={teams}
        activeTeam={activeTeam}
        onSwitch={switchWorkspace}
        onTeamsChanged={loadTeams}
      />
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[13rem_minmax(0,1fr)]">
      <aside className="min-w-0">
        <FolderSidebar
          folders={folders}
          active={activeFolder}
          onPick={setActiveFolder}
          onChanged={load}
          total={total}
          teamId={activeTeam}
        />
      </aside>

      <div>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="shrink-0 text-lg font-semibold text-slate-900">
            {t('libraryTitle')}
          </h2>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('librarySearchPlaceholder')}
            className="w-full max-w-xs rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <span className="shrink-0 text-sm text-slate-500">
            {t('savedCount', { count: papers.length })}
          </span>
          {/* Exports whatever the folder/tag/search filters currently show, so
              "everything in this folder" is one click rather than a selection. */}
          <BulkExport papers={papers} queryLabel={t('libraryTitle')} />
        </div>

        {/* The shelf and the notebook are two halves of the same work, so they
            sit side by side rather than in different corners of the app. */}
        <div className="mb-4 flex items-center gap-1.5">
          {[['papers', t('libraryTitle')], ['records', t('tabRecords')]].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setView(key)}
              className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                view === key
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {view === 'records' && <RecordsList teamId={activeTeam} papers={papers} />}

        {view === 'papers' && (
          <div className="mb-4">
            <ReadStateFilter active={activeState} counts={stateCounts} onPick={setActiveState} />
          </div>
        )}
        {view === 'papers' && (
        <>

        <UploadPdf
          teamId={activeTeam}
          folderId={activeFolder}
          onDone={load}
        />

        {/* Bringing a whole existing library in, as opposed to one PDF. Sits
            beside the PDF drop because both answer "how do I get my papers in
            here" — the difference is only whether you have one or three
            hundred. */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setImporting(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 transition-colors hover:border-blue-300 hover:bg-white hover:text-blue-700"
          >
            <Icon name="download" />
            {t('importOpen')}
          </button>
          {/* Every assistant gets its own way in. Buried behind a picker inside
              one of them, the other two would go unfound — and which assistant
              you want is usually the first thing you know, not the last. */}
          {assistants.map((a) => (
            <button
              key={a.id}
              onClick={() => setLibrarian(a.id)}
              title={a.description}
              className="inline-flex max-w-[16rem] items-center gap-1.5 truncate rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 transition-colors hover:border-blue-300 hover:bg-white hover:text-blue-700"
            >
              <Icon name={ASSISTANT_ICON[a.id] || 'sparkles'} className="text-blue-500" />
              {a.name}
            </button>
          ))}
          <button
            onClick={() => setDesigning(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-sm text-slate-600 transition-colors hover:border-blue-300 hover:bg-white hover:text-blue-700"
          >
            <Icon name="plus" />
            {t('assistantNew')}
          </button>
          <button
            onClick={() => setLocalFolder(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 transition-colors hover:border-blue-300 hover:bg-white hover:text-blue-700"
          >
            <Icon name="folder" />
            {t('localOpen')}
          </button>
        </div>

        {localFolder && (
          <LocalFolderPanel
            teamId={activeTeam}
            onClose={() => setLocalFolder(false)}
            onChanged={load}
          />
        )}

        {librarian && (
          <LibrarianPanel
            teamId={activeTeam}
            initialAssistant={librarian}
            onClose={() => setLibrarian(null)}
            onChanged={load}
          />
        )}

        {designing && (
          <AssistantDesigner
            teamId={activeTeam}
            onClose={() => setDesigning(false)}
            onSaved={(made) => {
              setDesigning(false)
              api
                .listAssistants(activeTeam, i18n.language)
                .then(setAssistants)
                .catch(() => {})
              if (made) setLibrarian(made.id)
            }}
          />
        )}

        {importing && (
          <ImportPanel
            folders={folders}
            folderId={activeFolder && activeFolder !== 'unfiled' ? activeFolder : null}
            teamId={activeTeam}
            onClose={() => setImporting(false)}
            onChanged={load}
          />
        )}

        {/* Ask questions across the papers you've saved */}
        <LibraryChat
          teamId={activeTeam}
          folder={activeFolder}
          scopeLabel={
            activeFolder === null
              ? t('allPapers')
              : activeFolder === 'unfiled'
              ? t('unfiled')
              : folders.find((f) => String(f.id) === activeFolder)?.name || ''
          }
          paperCount={
            activeFolder === null
              ? folders.reduce((n, f) => n + f.count, 0)
              : folders.find(
                  (f) =>
                    (activeFolder === 'unfiled' && f.id === null) ||
                    String(f.id) === activeFolder
                )?.count ?? 0
          }
        />


        {/* Tag filter bar */}
        {tags.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            <button
              onClick={() => setActiveTag(null)}
              className={`rounded-full px-3 py-1 text-sm ${
                activeTag === null
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50'
              }`}
            >
              {t('allTags')}
            </button>
            {tags.map(({ tag, count }) => (
              <button
                key={tag}
                onClick={() => setActiveTag(tag)}
                className={`rounded-full px-3 py-1 text-sm ${
                  activeTag === tag
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50'
                }`}
              >
                {tag} ({count})
              </button>
            ))}
          </div>
        )}

        {loadError ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {loadError}{' '}
            <button onClick={load} className="font-medium underline">
              {t('retry')}
            </button>
          </div>
        ) : papers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
            {query ? t('libraryNoMatch') : t('libraryEmpty')}
          </div>
        ) : (
          <div className="stagger grid grid-cols-1 gap-3 xl:grid-cols-2">
            {papers.map((p) => (
              <LibraryCard
                key={p.id}
                paper={p}
                folders={folders.filter((f) => f.id !== null)}
                teamId={activeTeam}
                onChanged={load}
              />
            ))}
          </div>
        )}
        </>
        )}
      </div>
    </div>
    </div>
  )
}
