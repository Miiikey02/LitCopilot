import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from './Icon'

// The library's folders, as a tree.
//
// A flat list stops describing how people file things the moment a project has
// more than one strand, so folders nest. Two rules make nesting safe: a branch
// can be collapsed, so depth never costs you the whole list, and deleting a
// folder keeps its papers and lifts its children up — a folder is a label, and
// losing one should never lose work.
//
// Re-nesting is offered twice over. Dragging is quick once you know it works,
// but it is invisible until you try it and easy to drop in the wrong place, so
// every folder also has an explicit "move to" menu that says exactly where
// things will land. The menu is the reliable path; the drag is the shortcut.

// Papers and folders can both be dragged onto a folder, and during `dragover`
// the payload is unreadable — only the list of types is. Naming the type is
// what lets a folder tell "file this paper here" from "nest this folder here".
export const PAPER_DRAG = 'application/x-gaze-paper'

const isPaperDrag = (e) => e.dataTransfer.types.includes(PAPER_DRAG)

const descendantsOf = (id, all) => {
  const out = new Set()
  const walk = (parent) => {
    for (const f of all) {
      if ((f.parent_id ?? null) === parent && !out.has(f.id)) {
        out.add(f.id)
        walk(f.id)
      }
    }
  }
  walk(id)
  return out
}

function MoveMenu({ folder, all, onMove, onClose }) {
  const { t } = useTranslation()
  // A folder cannot go inside itself or anything beneath it — offering those
  // and then refusing the drop teaches nothing.
  const banned = descendantsOf(folder.id, all)
  const options = all.filter(
    (f) => f.id !== folder.id && !banned.has(f.id) && f.id !== (folder.parent_id ?? null)
  )

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute right-1 z-20 mt-1 max-h-64 w-56 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg">
        <p className="px-3 pb-1 pt-1 text-xs text-slate-400">
          {t('moveFolderTo', { name: folder.name })}
        </p>
        {(folder.parent_id ?? null) !== null && (
          <button
            onClick={() => {
              onMove(folder.id, null)
              onClose()
            }}
            className="block w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            <Icon name="library" className="mr-1.5 text-slate-400" />
            {t('topLevel')}
          </button>
        )}
        {options.map((f) => (
          <button
            key={f.id}
            onClick={() => {
              onMove(folder.id, f.id)
              onClose()
            }}
            className="block w-full truncate px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            <Icon name="folder" className="mr-1.5 text-slate-400" />
            {f.name}
          </button>
        ))}
        {options.length === 0 && (folder.parent_id ?? null) === null && (
          <p className="px-3 py-1.5 text-xs text-slate-400">{t('noMoveTarget')}</p>
        )}
      </div>
    </>
  )
}

function Node({ folder, all, childrenOf, depth, ctx }) {
  const { t } = useTranslation()
  const kids = childrenOf(folder.id)
  const [open, setOpen] = useState(true)
  const [menu, setMenu] = useState(false)
  const [soon, setSoon] = useState(false)
  const [hover, setHover] = useState(false)
  const isActive = String(ctx.active) === String(folder.id)
  const isDropTarget = ctx.dropTarget === folder.id
  const isDragging = ctx.dragging === folder.id

  return (
    <li
      className="relative"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        draggable
        onDragStart={(e) => {
          // Firefox refuses to start a drag without payload.
          e.dataTransfer.setData('text/plain', String(folder.id))
          e.dataTransfer.effectAllowed = 'move'
          ctx.setDragging(folder.id)
        }}
        onDragEnd={() => {
          ctx.setDragging(null)
          ctx.setDropTarget(undefined)
        }}
        onDragOver={(e) => {
          if (isPaperDrag(e)) {
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            if (ctx.dropTarget !== folder.id) ctx.setDropTarget(folder.id)
            return
          }
          if (!ctx.dragging || ctx.dragging === folder.id) return
          if (descendantsOf(ctx.dragging, all).has(folder.id)) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
          if (ctx.dropTarget !== folder.id) ctx.setDropTarget(folder.id)
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const paperId = e.dataTransfer.getData(PAPER_DRAG)
          if (paperId) ctx.onFilePaper(Number(paperId), folder.id)
          else if (ctx.dragging && ctx.dragging !== folder.id) {
            ctx.onMove(ctx.dragging, folder.id)
          }
          ctx.setDragging(null)
          ctx.setDropTarget(undefined)
        }}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        className={`group flex items-center gap-1 rounded-lg py-1.5 pr-1 text-sm transition-colors ${
          isDropTarget
            ? 'bg-blue-100 ring-2 ring-inset ring-blue-400'
            : isActive
            ? 'bg-blue-50 font-medium text-blue-700'
            : 'text-slate-600 hover:bg-slate-100'
        } ${isDragging ? 'opacity-40' : ''}`}
      >
        <button
          onClick={() => setOpen((v) => !v)}
          className={`shrink-0 rounded p-0.5 text-slate-400 transition-transform hover:text-slate-700 ${
            kids.length ? '' : 'invisible'
          } ${open ? '' : '-rotate-90'}`}
          title={t(open ? 'collapse' : 'expand')}
        >
          <Icon name="chevronDown" />
        </button>

        <button
          onClick={() => ctx.onPick(String(folder.id))}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <Icon name="folder" className={isActive ? 'text-blue-600' : 'text-slate-400'} />
          <span className="truncate">{folder.name}</span>
          {/* While a folder is being dragged over this one, say what will
              happen rather than leaving the reader to infer it from a colour. */}
          {isDropTarget ? (
            <span className="ml-auto shrink-0 whitespace-nowrap pl-1 text-xs font-medium text-blue-700">
              {t(ctx.dragging ? 'dropInside' : 'fileHere')}
            </span>
          ) : (
            <span className="ml-auto shrink-0 pl-1 text-xs text-slate-400">
              {folder.count}
            </span>
          )}
        </button>

      </div>

      {/* Actions live under the folder rather than beside it: the row already
          holds a chevron, an icon, a name and a count, and five more controls
          squeezed to its right collided with all of them. Kept visible while a
          menu is open, so the pointer can travel to it. */}
      {(hover || menu || soon || isActive) && (
        <div
          style={{ paddingLeft: `${depth * 14 + 30}px` }}
          className="animate-expand flex items-center gap-0.5 pb-1"
        >
          <button
            onClick={() => ctx.onCreate(folder.id)}
            title={t('newSubfolder')}
            className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-blue-700"
          >
            <Icon name="plus" />
          </button>
          <button
            onClick={() => setSoon((v) => !v)}
            title={t('watchFieldSoon')}
            className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-blue-600"
          >
            <Icon name="bell" />
          </button>
          <button
            onClick={() => setMenu((v) => !v)}
            title={t('moveFolder')}
            className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-blue-700"
          >
            <Icon name="folder" />
          </button>
          <button
            onClick={() => ctx.onRename(folder)}
            title={t('rename')}
            className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-blue-700"
          >
            <Icon name="pencil" />
          </button>
          <button
            onClick={() => ctx.onDelete(folder)}
            title={t('deleteFolder')}
            className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-red-600"
          >
            <Icon name="trash" />
          </button>
        </div>
      )}

      {/* Explains what it will do rather than looking broken. A disabled
          button teaches nothing; this at least tells you what is coming. */}
      {soon && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setSoon(false)} />
          <div className="absolute right-1 z-20 mt-1 w-64 rounded-md border border-slate-200 bg-white p-3 shadow-lg">
            <p className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
              <Icon name="bell" className="text-blue-600" />
              {t('watchField')}
              <span className="ml-auto rounded-full bg-amber-50 px-2 py-0.5 text-xs font-normal text-amber-700">
                {t('comingSoon')}
              </span>
            </p>
            <p className="mt-1.5 text-xs leading-5 text-slate-500">
              {t('watchFieldWhat', { name: folder.name })}
            </p>
          </div>
        </>
      )}

      {menu && (
        <MoveMenu
          folder={folder}
          all={all}
          onMove={ctx.onMove}
          onClose={() => setMenu(false)}
        />
      )}

      {open && kids.length > 0 && (
        <ul>
          {kids.map((k) => (
            <Node key={k.id} folder={k} all={all} childrenOf={childrenOf} depth={depth + 1} ctx={ctx} />
          ))}
        </ul>
      )}
    </li>
  )
}

export default function FolderTree({
  folders,
  active,
  onPick,
  onCreate,
  onRename,
  onDelete,
  onMove,
  onFilePaper,
  totalCount,
  unfiledCount,
}) {
  const { t } = useTranslation()
  const [dragging, setDragging] = useState(null)
  const [dropTarget, setDropTarget] = useState(undefined)
  const all = folders.filter((f) => f.id !== null && f.id !== undefined)
  const childrenOf = (id) => all.filter((f) => (f.parent_id ?? null) === (id ?? null))
  const ctx = {
    active,
    onPick,
    onCreate,
    onRename,
    onDelete,
    onMove,
    onFilePaper,
    dragging,
    setDragging,
    dropTarget,
    setDropTarget,
  }

  // Views and folders are different things and now look it. Previously the
  // "Folders" heading sat above 全部文献, and folder rows were indented past it
  // by the width of their chevron — so a new top-level folder read as a child
  // of 全部文献 rather than a sibling of it.
  const viewClass = (on) =>
    `flex w-full items-center gap-1.5 rounded-lg py-1.5 pl-2 pr-2 text-sm transition-colors ${
      on ? 'bg-blue-50 font-medium text-blue-700' : 'text-slate-600 hover:bg-slate-100'
    }`

  return (
    <div>
      <ul className="mb-2">
        <li>
          <button onClick={() => onPick(null)} className={viewClass(active === null)}>
            {/* Matches the chevron the folder rows carry, so the labels of
                views and top-level folders start on the same line. */}
            <span className="w-[18px] shrink-0" aria-hidden="true" />
            <Icon name="library" />
            <span className="flex-1 text-left">{t('allPapers')}</span>
            <span className="text-xs text-slate-400">{totalCount}</span>
          </button>
        </li>
        <li
          onDragOver={(e) => {
            if (!isPaperDrag(e)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDropTarget('unfiled')
          }}
          onDragLeave={() => setDropTarget((v) => (v === 'unfiled' ? undefined : v))}
          onDrop={(e) => {
            e.preventDefault()
            const paperId = e.dataTransfer.getData(PAPER_DRAG)
            if (paperId) onFilePaper(Number(paperId), null)
            setDropTarget(undefined)
          }}
        >
          <button
            onClick={() => onPick('unfiled')}
            className={`${viewClass(active === 'unfiled')} ${
              dropTarget === 'unfiled' ? 'bg-blue-100 ring-2 ring-inset ring-blue-400' : ''
            }`}
          >
            <span className="w-[18px] shrink-0" aria-hidden="true" />
            <Icon name="inbox" />
            <span className="flex-1 text-left">{t('unfiled')}</span>
            <span className="text-xs text-slate-400">
              {dropTarget === 'unfiled' ? t('fileHere') : unfiledCount}
            </span>
          </button>
        </li>
      </ul>

      <div className="mb-1 flex items-center justify-between border-t border-slate-100 px-2 pt-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
          {t('folders')}
        </span>
        <button
          onClick={() => onCreate(null)}
          title={t('newFolder')}
          className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-blue-700"
        >
          <Icon name="plus" />
        </button>
      </div>

      <ul>
        {childrenOf(null).map((f) => (
          <Node key={f.id} folder={f} all={all} childrenOf={childrenOf} depth={0} ctx={ctx} />
        ))}
      </ul>

      {all.length === 0 && (
        <p className="px-2 py-1 text-xs leading-5 text-slate-400">{t('noFoldersYet')}</p>
      )}

      {/* A named target for "out of every folder", shown only while dragging.
          Dropping on ambient empty space is not a thing anyone can guess. */}
      {dragging && (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (dropTarget !== null) setDropTarget(null)
          }}
          onDrop={(e) => {
            e.preventDefault()
            onMove(dragging, null)
            setDragging(null)
            setDropTarget(undefined)
          }}
          className={`animate-rise mt-2 rounded-lg border-2 border-dashed px-3 py-3 text-center text-xs transition-colors ${
            dropTarget === null
              ? 'border-blue-400 bg-blue-50 text-blue-700'
              : 'border-slate-300 text-slate-500'
          }`}
        >
          {t('dropToTopLevel')}
        </div>
      )}

      {!dragging && all.length > 0 && (
        <p className="mt-2 px-2 text-xs leading-5 text-slate-400">{t('folderHint')}</p>
      )}
    </div>
  )
}
