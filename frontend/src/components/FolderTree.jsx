import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from './Icon'

// The library's folders, as a tree.
//
// A flat list stops describing how people actually file things the moment a
// project has more than one strand, so folders nest. Two rules make nesting
// safe to use: a branch can be collapsed, so depth never costs you the whole
// list, and deleting a folder keeps its papers and lifts its children up —
// a folder is a label, and losing one should never lose work.

function Node({
  folder,
  childrenOf,
  depth,
  active,
  onPick,
  onCreate,
  onRename,
  onDelete,
  onMove,
  dragging,
  setDragging,
}) {
  const { t } = useTranslation()
  const kids = childrenOf(folder.id)
  const [open, setOpen] = useState(true)
  const isActive = String(active) === String(folder.id)

  return (
    <li>
      <div
        draggable
        onDragStart={() => setDragging(folder.id)}
        onDragOver={(e) => dragging && dragging !== folder.id && e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (dragging && dragging !== folder.id) onMove(dragging, folder.id)
          setDragging(null)
        }}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        className={`group flex items-center gap-1 rounded-lg py-1.5 pr-1 text-sm transition-colors ${
          isActive ? 'bg-blue-50 font-medium text-blue-700' : 'text-slate-600 hover:bg-slate-100'
        }`}
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
          onClick={() => onPick(String(folder.id))}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <Icon name="folder" className={isActive ? 'text-blue-600' : 'text-slate-400'} />
          <span className="truncate">{folder.name}</span>
          <span className="ml-auto shrink-0 pl-1 text-xs text-slate-400">
            {folder.count}
          </span>
        </button>

        {/* Actions stay hidden until the row is hovered: a sidebar of folders
            should read as a list, not as a control panel. */}
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <button
            onClick={() => onCreate(folder.id)}
            title={t('newSubfolder')}
            className="rounded p-1 text-slate-400 hover:bg-white hover:text-blue-700"
          >
            <Icon name="plus" />
          </button>
          <button
            onClick={() => onRename(folder)}
            title={t('rename')}
            className="rounded p-1 text-slate-400 hover:bg-white hover:text-blue-700"
          >
            <Icon name="pencil" />
          </button>
          <button
            onClick={() => onDelete(folder)}
            title={t('deleteFolder')}
            className="rounded p-1 text-slate-400 hover:bg-white hover:text-red-600"
          >
            <Icon name="trash" />
          </button>
        </span>
      </div>

      {open && kids.length > 0 && (
        <ul>
          {kids.map((k) => (
            <Node
              key={k.id}
              folder={k}
              childrenOf={childrenOf}
              depth={depth + 1}
              active={active}
              onPick={onPick}
              onCreate={onCreate}
              onRename={onRename}
              onDelete={onDelete}
              onMove={onMove}
              dragging={dragging}
              setDragging={setDragging}
            />
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
  totalCount,
  unfiledCount,
}) {
  const { t } = useTranslation()
  const [dragging, setDragging] = useState(null)
  const real = folders.filter((f) => f.id !== null && f.id !== undefined)
  const childrenOf = (id) => real.filter((f) => (f.parent_id ?? null) === (id ?? null))

  const rowClass = (on) =>
    `flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm transition-colors ${
      on ? 'bg-blue-50 font-medium text-blue-700' : 'text-slate-600 hover:bg-slate-100'
    }`

  return (
    <div>
      <div className="mb-1 flex items-center justify-between px-2">
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

      <ul
        onDragOver={(e) => dragging && e.preventDefault()}
        onDrop={(e) => {
          // Dropped on empty space: back to the top level.
          e.preventDefault()
          if (dragging) onMove(dragging, null)
          setDragging(null)
        }}
      >
        <li>
          <button onClick={() => onPick(null)} className={rowClass(active === null)}>
            <Icon name="library" />
            <span className="flex-1 text-left">{t('allPapers')}</span>
            <span className="text-xs text-slate-400">{totalCount}</span>
          </button>
        </li>
        {childrenOf(null).map((f) => (
          <Node
            key={f.id}
            folder={f}
            childrenOf={childrenOf}
            depth={0}
            active={active}
            onPick={onPick}
            onCreate={onCreate}
            onRename={onRename}
            onDelete={onDelete}
            onMove={onMove}
            dragging={dragging}
            setDragging={setDragging}
          />
        ))}
        <li>
          <button
            onClick={() => onPick('unfiled')}
            className={rowClass(active === 'unfiled')}
          >
            <Icon name="inbox" />
            <span className="flex-1 text-left">{t('unfiled')}</span>
            <span className="text-xs text-slate-400">{unfiledCount}</span>
          </button>
        </li>
      </ul>

      {real.length > 0 && (
        <p className="mt-2 px-2 text-xs leading-5 text-slate-400">{t('folderDragHint')}</p>
      )}
    </div>
  )
}
