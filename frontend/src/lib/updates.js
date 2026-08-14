// What changed, by date.
//
// Written from the project's own history, but not from its commit messages:
// those describe code, and this describes what a reader can now do. Entries are
// added by hand for the same reason — a generated list would grow to include
// every fix of a fix, and the useful signal is which of them a user would
// notice.
//
// `kind` is one of: feature | fix | change.

export const UPDATES = [
  {
    date: '2026-08-13',
    title: { zh: '文库整理与两种检索模式的分工', en: 'Library organisation, and the two search modes' },
    items: [
      {
        kind: 'feature',
        zh: '文件夹支持多层级：可新建子文件夹、拖动整理，或用「移动到……」菜单精确指定位置。删除文件夹不会删除其中的文献。',
        en: 'Folders nest. Create sub-folders, drag to re-nest, or use the "move to" menu to say exactly where. Deleting a folder keeps its papers.',
      },
      {
        kind: 'feature',
        zh: '拖动文献卡片即可归档到左侧文件夹，拖到「未分类」可取消归档。',
        en: 'Drag a paper onto a folder to file it, or onto Unfiled to take it out.',
      },
      {
        kind: 'feature',
        zh: '笔记改为独立面板：有空间写、可删除，⌘/Ctrl + Enter 保存；未保存时关闭会先提醒。',
        en: 'Notes open in their own panel — room to write, an explicit delete, ⌘/Ctrl+Enter to save, and a warning before discarding unsaved text.',
      },
      {
        kind: 'feature',
        zh: '保存文献时可以直接选择存入哪个文件夹。',
        en: 'Saving a paper asks which folder to put it in.',
      },
      {
        kind: 'change',
        zh: '「快速检索」只给简短综述，「深度研究」给完整研究简报，不再重复同一段文字；深度研究可设置最多 50 篇，并可调整每个子问题的检索量。',
        en: 'Quick search gives a short orientation; deep research gives a full report, and no longer prints the same text twice. Deep research goes up to 50 papers and lets you set how many each sub-question retrieves.',
      },
      {
        kind: 'change',
        zh: '切换检索模式或数据库不再立刻开始检索——先设置好，再检索。同一个问题换模式重跑，会更新原有记录而不是新建一条。',
        en: 'Switching mode or databases no longer starts a search — set things up first. Re-running the same question in another mode updates its existing entry instead of filing a new one.',
      },
      {
        kind: 'fix',
        zh: '追问时若现有文献覆盖不到，会直接问你要不要去检索，而不是只说「语料库不足」。',
        en: 'When a follow-up falls outside the papers gathered so far, Gaze offers to go and search for it rather than reporting that the corpus is insufficient.',
      },
      {
        kind: 'feature',
        zh: '新增「反馈」：左侧栏点一下就能写——问题、想要的功能、觉得不对的结论都行。不用登录，邮箱可留可不留；会附带你当时所在的页面，方便复现。',
        en: 'Feedback: one click in the left rail — bugs, missing features, an answer that looked wrong. No account needed, email optional, and the screen you were on is attached so a report can be reproduced.',
      },
      {
        kind: 'feature',
        zh: '新增「更新日志」：每次更新做了什么，按日期排列，中英文都有。',
        en: 'An update log: what changed in each release, by date, in both languages.',
      },
      {
        kind: 'change',
        zh: '文件夹上多了一个铃铛：「追踪这个领域的新文献」。功能还没上线，点开会说明它将做什么——放在这里是想先听听你要不要。',
        en: 'A bell on each folder: track new papers in that field. Not built yet — clicking it explains what it will do. It is there to find out whether you want it.',
      },
      {
        kind: 'fix',
        zh: '点开「引用」等下拉菜单时不再被下一张卡片盖住。',
        en: 'Dropdown menus such as Cite are no longer painted under the next card.',
      },
      {
        kind: 'fix',
        zh: '「深度研究」下也能选择检索哪些数据库——之前这个选项只在快速检索时出现。',
        en: 'The database picker now appears in deep research too — it had only been showing in quick search.',
      },
      {
        kind: 'feature',
        zh: '新增「整理本地文件夹」：授权电脑上存放 PDF 的那个文件夹，Gaze 会读取每个 PDF 的 DOI，与文库比对，然后建议把 `1-s2.0-S00928674…-main.pdf` 这类文件名改成「作者, 年份 - 标题.pdf」，并按文库里的文件夹分目录存放；同时告诉你哪些文献存了却没有本地文件。文件不会上传，只有 DOI 和标题会发到服务器；不会删除任何文件，所有改动先列出来，并写入文件夹内的日志以便还原。需要 Chrome / Edge 等 Chromium 内核浏览器。',
        en: 'Tidy a local folder: grant Gaze the folder where your PDFs live and it reads each one for its DOI, matches it against your library, and proposes turning `1-s2.0-S00928674…-main.pdf` into “Author, Year - Title.pdf”, filed into sub-folders matching your library. It also tells you which saved papers have no file. Nothing is uploaded — only a DOI and title reach the server — nothing is ever deleted, every change is listed first, and a log is written inside the folder so it can be undone. Chromium browsers (Chrome, Edge) only.',
      },
      {
        kind: 'feature',
        zh: '文库多了一个「整理助手」：可以让它按主题分文件夹、把文献归档、打标签，或者替你写每篇文献的笔记（这篇做了什么、发现了什么、为什么值得留着）。它会先读一遍你保存的文献再给方案，所有改动都先列出来——点「应用」之前，文库不会动。',
        en: 'A librarian in 我的文库: ask it to sort papers into folders by topic, file them, tag them, or write the note for each one — what the study did, what it found, why it is worth keeping. It reads your saved papers first, then lists every change it wants to make. Nothing happens to your library until you press Apply.',
      },
      {
        kind: 'feature',
        zh: '左侧的检索记录可以搜索了：不只搜标题，也搜你问过的问题、对话里的每一句回答，以及那次检索引用过的文献标题——命中的那句会显示出来并高亮。中英文都可以。',
        en: 'The history in the left rail is searchable — not just titles, but the questions you asked, every line of the answers, and the titles of the papers each search cited. The matching line is shown with the term highlighted. Works in Chinese and English.',
      },
      {
        kind: 'feature',
        zh: '新增「导入文献库」：可直接导入 EndNote、Zotero、Mendeley、PubMed 导出的文件（RIS、BibTeX、.enw、.xml、.nbib、CSL-JSON），也可以粘贴一列 DOI / PMID。导入时会逐条去数据库核对，补全作者、期刊、年份与引用格式；文件里重复的、以及文库里已有的，都只算一次。可以指定存入哪个文件夹。',
        en: 'Import an existing library: files exported from EndNote, Zotero, Mendeley or PubMed (RIS, BibTeX, .enw, .xml, .nbib, CSL-JSON), or a pasted list of DOIs and PMIDs. Each reference is looked up and filled in with authors, journal, year and citation key; repeats within the file and papers already in your library are counted, not duplicated. You choose which folder they land in.',
      },
      {
        kind: 'change',
        zh: '上传的 PDF 改存到文件存储服务，不再占用数据库空间——这样才装得下一整个实验室的文献库。另外，即使原始 PDF 不在了，精读模式仍然可以打开：正文与结论是分开保存的，丢的只是 PDF 视图。',
        en: 'Uploaded PDFs now live in file storage rather than in the database, which is what makes importing a whole lab library possible. And if an original PDF is ever missing, close reading still opens — the extracted text is stored separately, so only the PDF pane is lost.',
      },
      {
        kind: 'change',
        zh: '「深度研究」与「精读模式」换用了会先推理再作答的模型：研究简报、单篇精读、划词提问与实体抽取都由它来写。同一个问题，简报从一段变成了六段，每句结论都带引用，并能指出研究之间的分歧。代价是等待——深度研究要三到五分钟，精读约一分半，请让它写完。「快速求索」仍用原来的快模型，速度不变。',
        en: 'Deep research and close reading now run on a model that reasons before it answers — the brief, the appraisal, selection questions and entity extraction all come from it. On the same question the brief went from one paragraph to six, every claim carrying its citation, and it now names where studies disagree. The cost is waiting: three to five minutes for deep research, about ninety seconds for a close reading. Quick search keeps the fast model and is unchanged.',
      },
      {
        kind: 'change',
        zh: '同一份 PDF 重复上传不再重复占用空间——识别到内容相同就直接复用；没有存进文库的上传文件会在三天后自动清理，存进文库的一直保留。',
        en: 'Uploading the same PDF twice no longer stores it twice — identical bytes reuse the existing file. Uploads never saved to a library are cleared after three days; anything saved is kept.',
      },
      {
        kind: 'change',
        zh: '共享工作区里，文件夹只能由创建者本人或管理员删除；新建、重命名、调整层级仍对所有成员开放。',
        en: 'In a shared workspace, a folder can only be deleted by whoever created it or by an admin. Creating, renaming and re-nesting stay open to every member.',
      },
      {
        kind: 'fix',
        zh: '任何检索模式下，被判定与问题无关的文献都不会出现在来源列表里（此前快速检索仍会显示，深度研究里偶尔还会漏出一行内部标记）。',
        en: 'Papers judged unrelated to the question no longer appear in the source list in any mode — quick search was still showing them, and deep research occasionally leaked an internal marker.',
      },
      {
        kind: 'fix',
        zh: '深度研究的来源列表不再混入无关文献。你设置的篇数是上限而非配额——宁可少给几篇，也不会用检索时顺带捞到的文献凑数。',
        en: 'Deep research no longer mixes unrelated papers into its sources. The number you choose is a ceiling, not a quota — it would rather show fewer papers than pad the list with whatever the sub-question searches happened to turn up.',
      },
    ],
  },
  {
    date: '2026-08-12',
    title: { zh: '精读模式、PDF 上传与全新界面', en: 'Close reading, PDF upload, and a new shell' },
    items: [
      {
        kind: 'feature',
        zh: '新增「精读模式」：左边是原文，右边是精读结论、关联图谱、实体与证据，以及一个只读这篇文献的 AI。点击任一结论可在原文中定位它的依据句。',
        en: 'Close reading: the article on the left, its appraisal, paper map, entities and evidence on the right, plus an agent scoped to that one paper. Click any finding to jump to the sentence it came from.',
      },
      {
        kind: 'feature',
        zh: '在原文中选中任意词句或图注，即可要求翻译、解释或说明其生物学意义。',
        en: 'Select any phrase or figure caption in the article to ask for a translation, a plain-language explanation, or its biological meaning.',
      },
      {
        kind: 'feature',
        zh: '可上传自己有权限的 PDF。上传后会自动识别 DOI 并补全作者、期刊、年份与引用格式，与检索结果完全一致。',
        en: 'Upload a PDF you have access to. Gaze reads the DOI from it and fills in authors, journal, year and citation key, exactly as a search result would.',
      },
      {
        kind: 'feature',
        zh: '新增「精读单篇」：粘贴 DOI、PMID 或完整标题，确认是这一篇后直接进入精读模式。',
        en: 'Find one paper: paste a DOI, PMID or exact title, confirm it is the right one, and open it for close reading.',
      },
      {
        kind: 'feature',
        zh: '可选择检索哪些数据库（PubMed / Semantic Scholar / OpenAlex / bioRxiv），选择会被记住，并对追问同样生效。',
        en: 'Choose which databases to search. The choice is remembered and applies to follow-up questions too.',
      },
      {
        kind: 'feature',
        zh: '新增「深度研究」：拆解子问题、分别检索、阅读开放获取全文，并指出证据分歧与研究空白。',
        en: 'Deep research: sub-questions planned and searched separately, open-access full text read, with contradictions and gaps called out.',
      },
      {
        kind: 'change',
        zh: '界面改为左侧常驻侧栏：新建检索、检索与文库切换、历史记录都在一处；点击历史会还原当时的答案、文献与设置，而不是重新检索。',
        en: 'A persistent left rail holds new search, navigation and history. Opening a past search restores its answer, papers and settings rather than running it again.',
      },
      {
        kind: 'fix',
        zh: '撤稿与编辑关注声明会在阅读前标出。',
        en: 'Retractions and expressions of concern are flagged before you read.',
      },
      {
        kind: 'fix',
        zh: '按标题检索会真正匹配标题，而不是返回同主题里被引最多的那一篇；找不到完全匹配时会直说。',
        en: 'Searching by title matches the title, rather than returning the most-cited paper on the same topic. When nothing matches exactly, it says so.',
      },
    ],
  },
  {
    date: '2026-08-10',
    title: { zh: '实验室共享工作区', en: 'Shared lab workspaces' },
    items: [
      {
        kind: 'feature',
        zh: '可创建实验室工作区并邀请成员，共用一个文库；管理员权限可以转让，成员只能删除自己保存的文献。',
        en: 'Create a lab workspace and invite members to share one library. Admin can be handed over, and members can only remove papers they saved.',
      },
      {
        kind: 'feature',
        zh: '研究对话会被保存，可以随时回到之前的线索继续。',
        en: 'Research conversations are saved, so a thread can be picked up later.',
      },
      { kind: 'change', zh: '界面改用统一的线性图标，并加入用于说明状态的动效。', en: 'A single line-icon set throughout, with motion used to explain state.' },
    ],
  },
  {
    date: '2026-08-09',
    title: { zh: '账号、文库与笔记', en: 'Accounts, library and notes' },
    items: [
      { kind: 'feature', zh: '支持注册登录，文献、文件夹与检索记录都保存在账号下。', en: 'Accounts, with papers, folders and history saved to them.' },
      { kind: 'feature', zh: '可以就自己保存的文献提问，也可以在文库内检索。', en: 'Ask questions across your saved papers, and search within the library.' },
      { kind: 'feature', zh: '每篇文献可以写笔记。', en: 'Per-paper notes.' },
    ],
  },
  {
    date: '2026-08-07',
    title: { zh: '文件夹与测试反馈', en: 'Folders, and tester feedback' },
    items: [
      { kind: 'feature', zh: '文库支持文件夹分类。', en: 'Folders in the library.' },
      { kind: 'change', zh: '根据测试反馈：支持按时间排序、一键导出、更紧凑的来源列表。', en: 'From tester feedback: sort by date, one-click export, a denser source list.' },
    ],
  },
  {
    date: '2026-08-02',
    title: { zh: 'Gaze 上线', en: 'Gaze goes live' },
    items: [
      { kind: 'feature', zh: '中英双语提问，四大文献库并行检索，逐句标注引用的综合回答。', en: 'Ask in Chinese or English, search four databases at once, and get an answer with every claim cited.' },
      { kind: 'feature', zh: '可就检索结果继续追问，AI 会在需要时补充检索。', en: 'Follow-up questions on a result, with the agent searching again when it needs to.' },
      { kind: 'feature', zh: '接入 OpenAlex 与 bioRxiv，覆盖预印本与更广的学科。', en: 'OpenAlex and bioRxiv added, covering preprints and broader coverage.' },
    ],
  },
]
