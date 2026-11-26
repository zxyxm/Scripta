(() => {
  'use strict';

  marked.setOptions({ gfm: true, breaks: true });
  const blockPreviewRenderer = new marked.Renderer();
  blockPreviewRenderer.br = ({ raw }) => '<br>' + (raw.match(/\n([ \t]*)$/)?.[1] ?? '');

  const byId = id => document.getElementById(id);
  const paper = byId('paper');
  const main = paper.closest('main');
  const workspace = main.parentElement;
  const sidebar = byId('sidebar');
  const sidebarSplitter = byId('sidebar-splitter');
  const source = byId('source');
  const outline = byId('outline');
  const outlineDepth = byId('outline-depth');
  const outlineFilterEmpty = byId('outline-filter-empty');
  const outlineSmart = byId('outline-smart');
  const outlineCollapse = byId('outline-collapse');
  const viewport = byId('viewport');
  const blockControls = byId('block-controls');
  const blockHandle = byId('block-handle');
  const blockLabelToggle = byId('block-label-toggle');
  const sectionEditButton = byId('section-edit-button');
  const sectionMoveHandle = byId('section-move-handle');
  const sectionDropGuide = byId('section-drop-guide');
  const sectionEditDialog = byId('section-edit-dialog');
  const sectionEditTitle = byId('section-edit-title');
  const sectionPreviewControls = [
    document.querySelector('.topbar'), sidebar, sidebarSplitter, main.querySelector('.editor-header'),
    main.querySelector('.editor-outline'), paper, blockControls,
  ];
  const sectionEditError = byId('section-edit-error');
  const sectionFormatTools = byId('section-format-tools');
  const sectionFormatStatus = byId('section-format-status');
  const sectionClearFormat = byId('section-clear-format');
  const headingTools = byId('heading-tools');
  const headingToolsCount = byId('heading-tools-count');
  const headingButtons = [...headingTools.querySelectorAll('[data-heading-change]')];
  const selectionTextButtons = [...headingTools.querySelectorAll('[data-selection-action]')];
  const headingShiftTools = headingTools.querySelector('.heading-tools-shift');
  const headingLevelTools = headingTools.querySelector('.heading-tools-levels');
  const blockMenu = byId('block-menu');
  const blockLinkDialog = byId('block-link-dialog');
  let blockLinkTarget = null;
  const newButton = byId('new');
  const saveButton = byId('save');
  const desktop = window.chrome?.webview;
  const displayDialog = byId('display-dialog');
  const displayForm = byId('display-form');
  const windowMode = byId('startup-window-mode');
  const windowWidth = byId('startup-window-width');
  const windowHeight = byId('startup-window-height');
  const fontSizeInput = byId('document-font-size');
  const documentWidthInput = byId('document-width');
  const startupOutlineInput = byId('startup-outline');
  const startupBlockLabelsInput = byId('startup-block-labels');
  const displayError = byId('display-error');
  const renameDialog = byId('rename-dialog');
  const commitDialog = byId('commit-dialog');
  if (desktop) {
    document.querySelector('.topbar').hidden = true;
    const quickFileActions = byId('quick-file-actions');
    newButton.textContent = '＋ 新建 MD';
    quickFileActions.prepend(newButton, saveButton);
    quickFileActions.hidden = false;
  }
  const draftKey = 'moye.draft.v1';
  const themeKey = 'moye.theme';
  const fontSizeKey = 'moye.document-font-size';
  const documentWidthKey = 'moye.document-width';
  const blockLabelsDefaultKey = 'moye.show-block-labels';
  const storedFontSize = Number(readStorage(fontSizeKey));
  const storedDocumentWidth = Number(readStorage(documentWidthKey));
  let displaySettings = window.scriptaDisplaySettings ?? {
    windowMode: 'automatic', windowWidth: 1200, windowHeight: 800,
    fontSize: Number.isInteger(storedFontSize) && storedFontSize >= 12 && storedFontSize <= 36 ? storedFontSize : 17,
    documentWidth: Number.isInteger(storedDocumentWidth) && storedDocumentWidth >= 360 && storedDocumentWidth <= 10000
      ? storedDocumentWidth : 852,
  };
  displaySettings.openOutlineByDefault ??= false;
  displaySettings.showBlockLabelsByDefault ??= readStorage(blockLabelsDefaultKey) === 'true';
  const outlineDepthKey = 'moye.outline-depth';
  const sidebarWidthKey = 'moye.sidebar-width';
  const sidebarMinWidth = 160;
  const editorMinWidth = 360;
  let sidebarWidth = Number(readStorage(sidebarWidthKey)) || null;
  let sidebarDrag = null;
  const example = [
    '## 把想法写下来',
    '',
    '欢迎使用 **Scripta 思刻**。点击任意段落，直接修改 Markdown。按 Esc 完成这一段，排版会立即恢复。',
    '',
    '> 先把想法写完整，再回头整理结构。',
    '',
    '### 开始写作',
    '',
    '- 点击「新建」开始一篇空白文档，或「打开」已有的 .md 文件。',
    '- 在「写作」和「源码」之间切换，随时查看完整的 Markdown。',
    '- 使用左侧大纲跳转，按 Ctrl+S 保存文件。',
    '',
    '### 记录下一步',
    '',
    '- [x] 打开 Scripta 思刻',
    '- [ ] 写下今天的第一个想法',
    '',
    '### 留一个代码片段',
    '',
    '~~~js',
    'const note = "今天写了什么？";',
    'console.log(note);',
    '~~~',
    '',
  ].join('\n');
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });

  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function readDraft() {
    try {
      const draft = JSON.parse(readStorage(draftKey));
      return typeof draft?.text === 'string' && typeof draft.name === 'string' ? draft : null;
    } catch {
      return null;
    }
  }

  const restored = readDraft();
  let markdown = restored?.text ?? example;
  let filename = restored?.name ?? '开始写作.md';
  let savedText = restored?.savedText ?? (restored?.dirty ? null : markdown);
  let initialSavedTokens = marked.lexer(savedText ?? '');
  let lineEnding = restored?.lineEnding === '\r\n' ? '\r\n' : '\n';
  let hasBom = restored?.hasBom === true;
  let handle = null;
  let desktopToken = null;
  let active = null;
  let visual = null;
  let visualReturn = null;
  let blockHover = null;
  let blockTarget = null;
  let menuBlock = null;
  let menuAnchor = null;
  let showBlockLabels = displaySettings.showBlockLabelsByDefault;
  let menuSelection = [];
  let blockLayout = 0;
  let textSelectionBlocks = new Set();
  let headingToolsRange = null;
  let visualFolds = new Set();
  let editorUndo = [];
  let editorRedo = [];
  let editorHistory = null;
  let editorTyping = null;
  let cursor = 0;
  let blocks = [];
  const outlineOverrides = new Map();
  let outlineRows = [];
  let outlineBranches = [];
  let outlineSmartDepth = 0;
  let outlineSmartActive = false;
  const savedOutlineDepth = readStorage(outlineDepthKey);
  let outlineMaxDepth = /^[1-6]$/.test(savedOutlineDepth) ? Number(savedOutlineDepth) : Infinity;
  let writingMode = desktop ? 'visual' : 'write';
  let mode = writingMode;
  let busy = false;

  function markdownHeadingLevels(tokens) {
    const levels = [];
    marked.walkTokens(tokens, token => {
      if (token.type === 'heading') levels.push(token.depth);
      if (token.type === 'html' && !token.pre && /<h[1-6][\s/>]/i.test(token.raw)) {
        const fragment = document.createElement('template');
        fragment.innerHTML = token.raw;
        for (const heading of fragment.content.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
          levels.push(Number(heading.tagName[1]));
        }
      }
    });
    return levels;
  }

  function updateEditedDocument() {
    const parsed = parseBlocks();
    renderOutline(parsed);
    updateBodyFolds();
    updateCount();
    persist();
  }

  function setStatus(message) {
    byId('status').textContent = message;
  }

  function updateDocumentLabel() {
    const label = byId('filename');
    label.textContent = filename;
    label.title = filename;
    document.title = filename + ' · Scripta 思刻';
  }

  function updateCount() {
    let count = 0;
    // Line breaks are word boundaries. Segment one line at a time to bound temporary allocations.
    for (const line of markdown.split('\n')) {
      for (const segment of segmenter.segment(line)) {
        if (segment.isWordLike) count++;
      }
    }
    byId('count').textContent = count.toLocaleString('zh-CN') + ' 词';
  }

  function persist(message = '草稿已保存在本机') {
    const draft = JSON.stringify({ text: markdown, name: filename, savedText, lineEnding, hasBom });
    setStatus(writeStorage(draftKey, draft) ? message : '本机草稿不可用，请保存文件');
  }

  function parseBlocks(tokens, text = markdown) {
    tokens ??= marked.lexer(text);
    const parsed = [];
    let position = 0;

    for (const token of tokens) {
      if (!token.raw) continue;
      const start = text.indexOf(token.raw, position);
      if (start < 0) {
        // A lexer normalization must never alter the source range used for editing.
        return [{ start: 0, end: text.length, tokens }];
      }
      if (start > position) parsed.push({ start: position, end: start, tokens: [] });
      const end = start + token.raw.length;
      const contentEnd = token.type === 'def' ? end : end - (token.raw.match(/\n+$/)?.[0].length ?? 0);
      if (token.type !== 'space' && contentEnd > start) {
        const lines = mode === 'visual' ? visualMarkdown.paragraphLines(token) : [{ offset: 0, token }];
        for (const line of lines) {
          const lineStart = start + line.offset;
          parsed.push({ start: lineStart, end: Math.min(contentEnd, lineStart + line.token.raw.length), tokens: [line.token] });
        }
      }
      if (end > contentEnd || token.type === 'space') {
        parsed.push({ start: token.type === 'space' ? start : contentEnd, end, space: true });
      }
      position = end;
    }

    if (position < text.length) parsed.push({ start: position, end: text.length, tokens: [] });
    parsed.push({ start: text.length, end: text.length, append: true });
    return parsed;
  }

  function renderBlock(block, text) {
    const element = document.createElement('div');
    element.className = 'block';

    if (block.space) {
      element.dataset.space = '';
      if (block.end - block.start < 2) element.classList.add('single-break');
      element.setAttribute('aria-hidden', 'true');
      return element;
    }

    element.tabIndex = 0;
    if (block.append) {
      element.classList.add('append');
      element.setAttribute('aria-label', '添加段落');
      element.textContent = '＋ 添加段落';
    } else {
      const previewOptions = mode === 'write' ? { renderer: blockPreviewRenderer } : undefined;
      const content = DOMPurify.sanitize(marked.parser(block.tokens, previewOptions), {
        RETURN_DOM_FRAGMENT: true,
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'form', 'button', 'textarea'],
        FORBID_ATTR: ['style', 'autofocus', 'tabindex'],
        SANITIZE_NAMED_PROPS: true,
        ALLOW_DATA_ATTR: false,
      });
      for (const image of content.querySelectorAll('img[src]')) prepareNoteImage(image);
      element.append(content);
      if (!element.firstElementChild && !element.textContent.trim()) {
        element.classList.add('unrendered');
        element.textContent = text.slice(block.start, block.end).trim();
      }
      for (const link of element.querySelectorAll('a[href]')) {
        if (!link.getAttribute('href').startsWith('#')) {
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
      }
    }

    element.addEventListener('click', event => {
      if (event.target.closest('a[href]')) {
        if (mode !== 'visual' || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
      }
      if (mode === 'write') focusBlock(block);
    });
    element.addEventListener('keydown', event => {
      if (!element.isContentEditable && event.target === element && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        if (mode === 'write') focusBlock(block);
      }
    });
    return element;
  }

  function prepareNoteImage(image, src = image.getAttribute('src')) {
    image.loading = 'lazy';
    image.decoding = 'async';
    visualMarkdown.rememberImage(image, src);
    if (desktopToken && assetReference(src, assetName(filename))) {
      const url = new URL(src, location.href);
      image.src = 'https://moye-images.invalid/note-image/' + desktopToken + url.pathname + url.search + url.hash;
    }
  }

  function renderOutline(parsed, text = markdown) {
    const entries = [];
    const usedIds = new Set();
    const counts = Array(7).fill(0);
    const visualHeadings = visual ? [...paper.children].filter(node => /^H[1-6]$/.test(node.tagName)) : [];
    let visualHeading = 0;
    for (const block of parsed) {
      const headings = block.tokens?.filter(token => token.type === 'heading');
      if (!headings?.length) continue;
      const elements = block.element?.querySelectorAll('h1,h2,h3,h4,h5,h6');

      for (const [index, heading] of headings.entries()) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'outline-heading';
        const target = visual ? visualHeadings[visualHeading++] : elements?.[index];
        const title = target?.textContent ?? DOMPurify.sanitize(marked.Parser.parseInline(heading.tokens), {
          RETURN_DOM_FRAGMENT: true,
        }).textContent;
        const label = title || '无标题';
        button.title = label;
        if (desktop) {
          const text = document.createElement('span');
          text.className = 'outline-title';
          text.textContent = label;
          const level = document.createElement('span');
          level.className = 'outline-level';
          level.textContent = 'H' + heading.depth;
          button.append(text, level);
        } else {
          button.textContent = label;
        }
        const id = nextOutlineId(label, usedIds);
        if (target) target.id = id;

        button.addEventListener('click', () => {
          if (!editorOutlineSlot.hidden && getComputedStyle(editorOutlineSlot.parentElement).position === 'absolute') {
            setEditorOutline(false);
            editorOutlineToggle.focus({ preventScroll: true });
          }
          if (mode === 'source') {
            source.focus();
            source.setSelectionRange(block.start, block.start);
            const lines = markdown.slice(0, block.start).split('\n').length - 1;
            source.scrollTop = lines * parseFloat(getComputedStyle(source).lineHeight);
          } else if (visual) {
            revealVisualBlock(target);
            target?.scrollIntoView({ block: 'start' });
          } else {
            finishBlock();
            const destination = blocks.find(candidate => candidate.start === block.start);
            destination?.element.scrollIntoView({ block: 'start' });
          }
          if (matchMedia('(max-width: 680px)').matches) toggleSidebar(false);
        });

        const range = block.tokens.length === 1 && text.slice(block.start, block.end) === heading.raw.replace(/\n+$/, '')
          ? { start: block.start, end: block.end } : null;
        entries.push({ button, id, depth: heading.depth, range, contentHeading: target });
        counts[heading.depth]++;
      }
    }
    const fragment = document.createDocumentFragment();
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.textContent = '添加标题以生成大纲';
      fragment.append(empty);
    }

    const parents = [];
    outlineRows = [];
    outlineBranches = [];
    outlineSmartDepth = counts.indexOf(Math.max(...counts));
    for (const [index, { button, id, depth, range, contentHeading }] of entries.entries()) {
      while (parents.length && parents.at(-1).depth >= depth) parents.pop();
      const parent = parents.at(-1);
      const container = parent?.group ?? fragment;
      const row = document.createElement('div');
      row.className = 'outline-row';
      row.style.paddingInlineStart = parents.length * 10 + 'px';
      const openSectionMenu = (x, y) => {
        let next = index + 1;
        while (entries[next]?.depth > depth) next++;
        if (range && (!entries[next] || entries[next].range)) {
          showOutlineMenu(button, contentHeading, range, entries[next]?.range.start ?? text.length, x, y);
        }
      };
      row.addEventListener('contextmenu', event => {
        event.preventDefault();
        openSectionMenu(event.clientX, event.clientY);
      });
      row.addEventListener('keydown', event => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault();
        const bounds = button.getBoundingClientRect();
        openSectionMenu(bounds.left, bounds.bottom);
      });
      if (index === 0) row.classList.add('outline-first');
      container.append(row);
      outlineRows.push({ row, depth, parent });
      if (parent) parent.shallowestChild = Math.min(parent.shallowestChild, depth);

      if (entries[index + 1]?.depth > depth) {
        const group = document.createElement('div');
        group.id = 'outline:children:' + index;
        container.append(group);

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'outline-toggle';
        toggle.setAttribute('aria-controls', group.id);
        const branch = { id, depth, group, toggle, label: button.title, shallowestChild: Infinity };
        parents.push(branch);
        outlineBranches.push(branch);
        toggle.addEventListener('click', () => {
          outlineOverrides.set(id, !group.hidden);
          updateOutlineFolding();
        });
        row.append(toggle);
      }
      row.append(button);
    }
    outline.replaceChildren(fragment);
    outlineSmart.title = outlineSmartDepth
      ? `显示至 H${outlineSmartDepth}（${counts[outlineSmartDepth]} 个 H${outlineSmartDepth} 标题）` : '';
    updateOutlineFolding();
  }

  function updateOutlineFolding() {
    const cutoff = outlineSmartActive ? outlineSmartDepth : Infinity;
    for (const { row, depth, parent } of outlineRows) {
      row.hidden = depth > outlineMaxDepth ||
        (depth > cutoff && (!parent || outlineOverrides.get(parent.id) !== false));
    }
    for (const { id, group, toggle, label, shallowestChild } of outlineBranches) {
      toggle.hidden = shallowestChild > outlineMaxDepth;
      group.hidden = toggle.hidden || (outlineOverrides.get(id) ?? shallowestChild > cutoff);
      toggle.setAttribute('aria-expanded', String(!group.hidden));
      toggle.title = (group.hidden ? '展开 ' : '折叠 ') + label;
      toggle.setAttribute('aria-label', toggle.title);
    }
    outlineFilterEmpty.hidden = !outlineRows.length || outlineRows.some(({ depth }) => depth <= outlineMaxDepth);
    outlineSmart.hidden = !desktop || !outlineSmartDepth;
    outlineCollapse.hidden = !desktop || (!outlineBranches.some(({ toggle }) => !toggle.hidden) &&
      !outlineRows.some(({ row, depth }) => row.hidden && depth <= outlineMaxDepth));
    outlineCollapse.textContent = outlineBranches.some(({ group }) => !group.hidden) ? '折叠全部' : '展开全部';
  }

  function render(tokens, text = markdown) {
    const scroll = viewport.scrollTop;
    closeBlockMenu();
    if (noteMenuTarget instanceof HTMLTableCellElement) closeNoteMenu();
    blockHover = blockTarget = sectionHover = null;
    for (const control of blockControls.querySelectorAll('.block-fold, .code-tools, .block-type-label')) control.remove();
    blocks = parseBlocks(tokens, text);
    const fragment = document.createDocumentFragment();
    visual = null;
    paper.classList.toggle('visual-active', mode === 'visual');
    if (mode === 'visual') paper.contentEditable = 'true';
    else paper.removeAttribute('contenteditable');
    if (mode === 'visual') {
      const original = new Map();
      let previousEnd = 0;
      for (const block of blocks) {
        if (block.space || block.append) continue;
        const wrapper = renderBlock(block, text);
        const node = wrapper.firstElementChild;
        const editable = node && wrapper.children.length === 1 && !['def', 'html'].includes(block.tokens?.[0]?.type);
        block.element = editable ? node : wrapper;
        if (editable) prepareVisualBlockCaret(node);
        if (!editable) {
          wrapper.contentEditable = 'false';
          wrapper.removeAttribute('tabindex');
        }
        original.set(block.element, {
          element: block.element,
          index: original.size,
          start: block.start,
          end: block.end,
          value: text.slice(block.start, block.end),
          separator: text.slice(previousEnd, block.start),
          readOnly: !editable,
        });
        previousEnd = block.end;
        fragment.append(block.element);
      }
      if (!fragment.childNodes.length) {
        const empty = document.createElement('p');
        empty.append(document.createElement('br'));
        fragment.append(empty);
      }
      paper.replaceChildren(fragment);
      for (const { node, value } of visualMarkdown.sections(paper)) {
        if (original.has(node)) original.get(node).baseline = value;
      }
      visual = { editor: paper, original, tail: text.slice(previousEnd), ranges: original };
    } else if (mode === 'write') {
      for (const block of blocks) {
        block.element = renderBlock(block, text);
        fragment.append(block.element);
      }
    }
    if (!visual) paper.replaceChildren(fragment);
    renderOutline(blocks, text);
    if (visual) {
      visual.folded = new Set([...paper.children].filter(node => node.id && visualFolds.has(node.id)));
    }
    updateBodyFolds();
    updateTextSelectionBlocks();
    viewport.scrollTop = scroll;
  }

  function resize(editor) {
    editor.style.height = '0';
    editor.style.height = editor.scrollHeight + 'px';
  }

  function recordInput(editor, inputType) {
    if (editor === source) {
      markdown = editor.value;
      cursor = editor.selectionStart;
    } else {
      const { left, right, prefix } = active;
      const inserted = editor.value ? prefix + editor.value : '';
      markdown = left + inserted + right;
      cursor = left.length + (inserted ? prefix.length + editor.selectionStart : 0);
      resize(editor);
    }
    updateEditedDocument();
    rememberEditorChange(inputType);
  }

  function finishBlock() {
    if (!active) return;
    const { editor, left, prefix } = active;
    cursor = left.length + (editor.value ? prefix.length + editor.selectionStart : 0);
    active = null;
    render();
  }

  function focusBlock(block, selection) {
    if (active) {
      const start = block.start + (block.start >= active.end ? markdown.length - active.initialLength : 0);
      finishBlock();
      block = blockAt(start);
    }

    const editor = document.createElement('textarea');
    editor.className = 'block-editor';
    const preview = block.element.firstElementChild;
    if (preview?.matches('h1, h2, h3, h4, h5, h6, pre')) {
      editor.dataset.previewTag = preview.localName;
    }
    editor.setAttribute('aria-label', '编辑段落');
    editor.spellcheck = false;
    editor.rows = 1;
    editor.value = markdown.slice(block.start, block.end);
    if (!block.append) editor.style.height = block.element.getBoundingClientRect().height + 'px';

    const left = markdown.slice(0, block.start);
    const prefix = block.append && left ? '\n'.repeat(Math.max(0, 2 - (left.match(/\n+$/)?.[0].length ?? 0))) : '';
    active = { editor, left, right: markdown.slice(block.end), prefix, end: block.end, initialLength: markdown.length };
    block.element.removeAttribute('tabindex');
    block.element.replaceChildren(editor);
    editor.addEventListener('input', event => recordInput(editor, event.inputType));
    editor.addEventListener('beforeinput', handleHistoryInput);
    editor.addEventListener('blur', event => {
      if (desktop && !event.relatedTarget) return;
      if (event.relatedTarget?.closest('.toolbar, .topbar, .sidebar, #paper .block')) return;
      if (active?.editor === editor) finishBlock();
    });
    editor.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key === 'Enter')) {
        event.preventDefault();
        finishBlock();
        const next = event.key === 'Escape' ? blockAt(cursor) : blocks.at(-1);
        if (event.key === 'Escape') next.element.focus();
        else focusBlock(next);
      }
    });

    editor.focus();
    const offset = selection ?? editor.value.length;
    editor.setSelectionRange(offset, offset);
    if (editorHistory?.text === markdown) {
      editorHistory.cursor = left.length + (editor.value ? prefix.length + offset : 0);
    }
    if (block.append) resize(editor);
  }

  function blockAt(position) {
    return blocks.find(block => !block.space && position >= block.start && position <= block.end)
      || blocks.find(block => !block.space && block.start >= position)
      || blocks.at(-1);
  }

  function focusVisual(node = paper, atEnd = false, textOffset = null) {
    revealVisualBlock(node);
    paper.focus({ preventScroll: true });
    if (!paper.contains(node) || node.getAttribute('contenteditable') === 'false') node = paper;
    const caret = document.createRange();
    caret.selectNodeContents(node);
    caret.collapse(!atEnd);
    if (textOffset !== null) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        if (textOffset <= text.length) {
          caret.setStart(text, textOffset);
          caret.collapse(true);
          break;
        }
        textOffset -= text.length;
      }
    }
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(caret);
    scheduleBlockLayout();
  }

  function removeVisualPrefix(caret) {
    const container = caret.startContainer;
    const element = container instanceof Element ? container : container.parentElement;
    const prefix = element?.closest('h1, h2, h3, h4, h5, h6, li, blockquote');
    if (!prefix || !paper.contains(prefix) || prefix.closest('[contenteditable="false"]')) return false;

    const before = document.createRange();
    before.selectNodeContents(prefix);
    before.setEnd(container, caret.startOffset);
    if (before.toString().replace(/[\r\n\t]/g, '') ||
        before.cloneContents().querySelector('br, img, pre, table, hr, ol, ul')) return false;

    const replacement = document.createDocumentFragment();
    if (headingDepth(prefix)) {
      const paragraph = document.createElement('p');
      paragraph.append(...prefix.childNodes);
      replacement.append(paragraph);
    } else if (prefix.matches('li')) {
      const list = prefix.parentElement;
      if (!list?.matches('ol, ul')) return false;
      const index = [...list.children].indexOf(prefix);
      const rest = list.cloneNode(false);
      if (list.matches('ol')) rest.start = list.start + index + 1;
      while (prefix.nextElementSibling) rest.append(prefix.nextElementSibling);
      prefix.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]')?.remove();
      let paragraph;
      for (const child of [...prefix.childNodes]) {
        if (child instanceof Element && child.matches('p, div, h1, h2, h3, h4, h5, h6, blockquote, pre, ol, ul, table, hr')) {
          replacement.append(child);
          paragraph = null;
        } else {
          if (!paragraph) {
            if (child.nodeType === Node.TEXT_NODE && !child.textContent.trim()) continue;
            paragraph = document.createElement('p');
            replacement.append(paragraph);
          }
          paragraph.append(child);
        }
      }
      const target = replacement.firstElementChild ?? document.createElement('p');
      if (!replacement.firstElementChild) replacement.append(target);
      const beforeItem = list.firstElementChild !== prefix;
      prefix.remove();
      if (rest.childElementCount) replacement.append(rest);
      if (beforeItem) list.after(replacement);
      else list.replaceWith(replacement);
      finishVisualPrefixRemoval(target);
      return true;
    } else {
      replacement.append(...prefix.childNodes);
    }
    const target = replacement.firstElementChild ?? document.createElement('p');
    if (!replacement.firstElementChild) {
      target.append(replacement);
      replacement.append(target);
    }
    prefix.replaceWith(replacement);
    finishVisualPrefixRemoval(target);
    return true;
  }

  function finishVisualPrefixRemoval(target) {
    if (target.matches('p:empty')) {
      target.dataset.insertedBlock = '';
      target.append(document.createElement('br'));
    }
    focusVisual(target);
    recordVisualInput(undefined, { preserveTail: true });
  }

  function recordVisualInput(event, { preserveTail = false } = {}) {
    if (!visual) return;
    const { original, tail } = visual;
    const ranges = new Map();
    let text = '';
    let previous = null;
    for (const { node, value } of visualMarkdown.sections(paper)) {
      const entry = original.get(node);
      const unchanged = entry && (entry.readOnly || value === entry.baseline);
      const contents = unchanged ? entry.value : value;
      if (!contents) continue;
      if (!text) {
        if (entry?.index === 0) text = entry.separator;
      } else {
        text += previous && entry?.index === previous.index + 1 ? entry.separator : '\n\n';
      }
      if (node) ranges.set(node, { element: node, start: text.length, end: text.length + contents.length });
      text += contents;
      previous = entry;
    }
    if (preserveTail || previous?.index === original.size - 1) text += tail;
    visual.ranges = ranges;
    visual.codeRevision = (visual.codeRevision ?? 0) + 1;
    markdown = text;
    updateVisualCursor();
    updateEditedDocument();
    rememberEditorChange(event?.inputType);
  }

  function updateVisualCursor() {
    const selection = getSelection();
    if (!visual || !paper.contains(selection.focusNode)) return;
    const range = visualRangeAt(selection.focusNode);
    if (!range) {
      cursor = markdown.length;
      return;
    }
    const caret = document.createRange();
    caret.selectNodeContents(range.element);
    caret.setEnd(selection.focusNode, selection.focusOffset);
    const offset = caret.toString().length;
    const raw = markdown.slice(range.start, range.end);
    const spans = visualTextSpans(range.element, raw);
    const span = spans.findLast(entry => entry.visible <= offset);
    cursor = range.start + (span ? span.source + Math.min(offset - span.visible, span.length) : 0);
    visualReturn = { text: markdown, cursor, offset };
  }

  function visualTextSpans(node, raw) {
    const spans = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let visible = 0;
    let after = 0;
    while (walker.nextNode()) {
      const { data, length } = walker.currentNode;
      const source = raw.indexOf(data, after);
      if (length && source >= 0) {
        spans.push({ source, visible, length });
        after = source + length;
      }
      visible += length;
    }
    return spans;
  }

  function visualRangeAt(target) {
    if (!visual) return;
    for (const [node, range] of visual.ranges) {
      if (node.contains(target)) return range;
    }
  }

  function visualBlockAt(node) {
    if (!node || node === paper || !paper.contains(node)) return null;
    while (node.parentNode !== paper) node = node.parentNode;
    return node instanceof HTMLElement ? node : null;
  }

  function headingDepth(node) {
    return /^H[1-6]$/.test(node?.tagName) ? Number(node.tagName[1]) : 0;
  }

  let sectionShadeFrame = 0;
  let sectionHover = null;
  let sectionEdit = null;
  let sectionDrag = null;
  const foldHeadingTargets = new WeakMap();

  function sectionHeadingDepth(node) {
    const content = node?.classList.contains('block') ? node.firstElementChild : node;
    return headingDepth(content) || Number(content?.dataset?.previewTag?.slice(1)) || 0;
  }

  function setSectionHover(node) {
    const heading = sectionHeadingDepth(node) ? node : null;
    if (heading === sectionHover) return;
    sectionHover = heading;
    scheduleSectionShading();
  }

  function scheduleSectionShading() {
    if (!sectionShadeFrame) sectionShadeFrame = requestAnimationFrame(updateSectionShading);
  }

  function nextSectionHeading(first) {
    const depth = sectionHeadingDepth(first);
    for (let node = first.nextElementSibling; node; node = node.nextElementSibling) {
      const nextDepth = sectionHeadingDepth(node);
      if (nextDepth && nextDepth <= depth) return node;
    }
    return null;
  }

  function placeSectionEditor(anchor, view) {
    const gap = 8;
    const right = view.left + viewport.clientWidth;
    sectionEditDialog.style.setProperty('--section-panel-max-width', Math.max(0, viewport.clientWidth - 2 * gap) + 'px');
    sectionEditDialog.style.setProperty('--section-panel-max-height', Math.max(0, view.height - 2 * gap) + 'px');
    const { width, height } = sectionEditDialog.getBoundingClientRect();
    const minLeft = view.left + gap;
    const maxLeft = right - width - gap;
    const leftSide = anchor.left - gap - width;
    const rightSide = anchor.right + gap;
    const left = rightSide > maxLeft && leftSide >= minLeft ? leftSide : rightSide;
    sectionEditDialog.style.left = Math.max(minLeft, Math.min(left, maxLeft)) + 'px';
    sectionEditDialog.style.top = Math.max(view.top + gap, Math.min(anchor.top, view.bottom - height - gap)) + 'px';
  }

  function updateSectionShading() {
    sectionShadeFrame = 0;
    const first = sectionEdit ? sectionEdit.element : sectionDrag?.element ?? sectionHover;
    const arrow = visual?.foldButtons?.get(first);
    const hoveringButton = [sectionEditButton, sectionMoveHandle].some(button =>
      !button.hidden && button.matches(':hover'));
    if (paper.hidden || first?.parentNode !== paper || first.hasAttribute('data-fold-hidden') ||
        !(sectionEdit || sectionDrag || first.matches(':hover') || arrow?.matches(':hover') || hoveringButton)) {
      paper.style.removeProperty('--section-band');
      sectionEditButton.hidden = sectionMoveHandle.hidden = true;
      return;
    }
    const next = sectionEdit?.last ? sectionEdit.last.nextElementSibling : nextSectionHeading(first);
    let last = first;
    for (let node = first.nextElementSibling; node && node !== next; node = node.nextElementSibling) {
      if (!node.matches('[data-fold-hidden], [data-space], .append')) last = node;
    }
    const heading = first.getBoundingClientRect();
    const top = paper.getBoundingClientRect().top + parseFloat(getComputedStyle(paper).paddingBlockStart);
    const start = Math.max(0, heading.top - top);
    const end = last.getBoundingClientRect().bottom - top;
    // Paint behind the editable DOM, including the vertical gaps between blocks.
    paper.style.setProperty('--section-band',
      `linear-gradient(to bottom, transparent ${start}px, var(--section-background) ${start}px ${end}px, transparent ${end}px)`);
    const view = viewport.getBoundingClientRect();
    if (sectionEdit) placeSectionEditor(heading, view);
    if (sectionDrag) return;
    sectionEditButton.hidden = sectionMoveHandle.hidden = Boolean(sectionEdit) || !visual?.ranges.has(first) ||
      heading.bottom <= view.top || heading.top >= view.bottom;
    if (!sectionEditButton.hidden) {
      const right = Math.min(heading.right, view.left + viewport.clientWidth);
      const editLeft = right - view.left + viewport.scrollLeft - sectionEditButton.offsetWidth - 8;
      sectionEditButton.style.left = editLeft + 'px';
      sectionMoveHandle.style.left = editLeft - sectionMoveHandle.offsetWidth - 4 + 'px';
      sectionMoveHandle.style.top = sectionEditButton.style.top =
        Math.max(heading.top, view.top) - view.top + viewport.scrollTop + 4 + 'px';
    }
  }

  function sectionBounds(element) {
    const range = visual.ranges.get(element);
    if (!range) return;
    const next = nextSectionHeading(element);
    const boundary = visual.ranges.get(next)?.start ?? markdown.length;
    const end = sectionContentEnd(range.start, boundary);
    return { start: range.start, end, boundary };
  }

  function sectionContentEnd(start, boundary) {
    const tail = markdown.slice(start, boundary).match(/(?:\n[ \t]*)+$/)?.[0].length ?? 0;
    return boundary - tail;
  }

  function openSectionEditor() {
    if (busy || fileDialogOpen() || !visual || !sectionHover) return;
    const element = sectionHover;
    const bounds = sectionBounds(element);
    if (!bounds) return;
    const { start, end } = bounds;
    showSectionEditor({ element, last: visualSourceRanges(start, end).at(-1)?.element, start, end });
  }

  function showSectionEditor({ element, last, start, end, pasted = false }) {
    captureVisualCaret();
    sectionEdit = {
      element, last, original: markdown, preview: markdown, draft: markdown.slice(start, end),
      start, end, pasted, scroll: viewport.scrollTop,
      controls: sectionPreviewControls.filter(control => !control.inert),
    };
    sectionEditTitle.textContent = pasted ? '整段编辑 · 本次粘贴' : '整段编辑';
    sectionEditError.textContent = '';
    sectionFormatStatus.textContent = '';
    for (const input of sectionFormatTools.querySelectorAll('input:checked')) input.checked = false;
    sectionClearFormat.disabled = true;
    sectionEditDialog.show();
    for (const control of sectionEdit.controls) control.inert = true;
    placeSectionEditor(element.getBoundingClientRect(), viewport.getBoundingClientRect());
    scheduleSectionShading();
  }

  function sectionDraftDocument({ original, start, end, draft }) {
    return original.slice(0, start) + draft + original.slice(end);
  }

  function updateSectionPreview() {
    if (!sectionEditDialog.open || !sectionEdit || !visual || markdown !== sectionEdit.original) return;
    const updated = sectionDraftDocument(sectionEdit);
    if (updated === sectionEdit.preview) return;

    // Render the draft without changing the Markdown used by autosave and undo.
    const folds = visualFolds;
    render(undefined, updated);
    visualFolds = folds;
    const { start, draft } = sectionEdit;
    const visible = visualSourceRanges(start, start + draft.length);
    sectionEdit.preview = updated;
    sectionEdit.element = visible[0]?.element;
    sectionEdit.last = visible.at(-1)?.element;
  }

  function startSectionDrag(event) {
    if (event.button !== 0 || sectionDrag || busy || fileDialogOpen() || !visual || !sectionHover) return;
    const bounds = sectionBounds(sectionHover);
    const frontMatter = sectionFrontMatterEnd(markdown);
    if (!bounds || bounds.start < frontMatter) return;
    event.preventDefault();
    captureVisualCaret();
    sectionDrag = {
      ...bounds, element: sectionHover, original: markdown, pointer: event.pointerId,
      x: event.clientX, y: event.clientY, frontMatter,
    };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('section-moving');
    sectionDrag.frame = requestAnimationFrame(updateSectionDropGuide);
  }

  function updateSectionDropGuide() {
    const drag = sectionDrag;
    if (!drag) return;
    const view = viewport.getBoundingClientRect();
    const inside = sectionPointerInside(drag, view);
    if (inside) {
      const edge = Math.min(48, viewport.clientHeight / 4);
      viewport.scrollTop += Math.min(0, drag.y - view.top - edge) / 3 +
        Math.max(0, drag.y - view.bottom + edge) / 3;
    }
    locateSectionDrop(view, inside);
    drag.frame = requestAnimationFrame(updateSectionDropGuide);
  }

  function sectionPointerInside({ x, y }, view) {
    return x >= view.left && x < view.left + viewport.clientWidth && y >= view.top && y <= view.bottom;
  }

  function locateSectionDrop(view, inside) {
    const drag = sectionDrag;
    drag.position = null;
    sectionDropGuide.hidden = true;
    if (!inside || !visual || markdown !== drag.original) return;

    let position = markdown.length;
    let line;
    for (const range of visual.ranges.values()) {
      const node = range.element;
      if (range.start < drag.frontMatter || node.parentNode !== paper || node.hasAttribute('data-fold-hidden')) continue;
      const rect = node.getBoundingClientRect();
      if (drag.y < (rect.top + rect.bottom) / 2) {
        position = range.start;
        line = rect.top;
        break;
      }
      line = rect.bottom;
    }
    if (line === undefined || position >= drag.start && position <= drag.boundary) return;
    drag.position = position;
    const content = paper.getBoundingClientRect();
    const inset = parseFloat(getComputedStyle(paper).paddingInlineStart);
    sectionDropGuide.style.left = content.left - view.left + viewport.scrollLeft + inset + 'px';
    sectionDropGuide.style.width = content.width - inset - parseFloat(getComputedStyle(paper).paddingInlineEnd) + 'px';
    sectionDropGuide.style.top = Math.max(view.top, Math.min(view.bottom - 3, line - 2)) -
      view.top + viewport.scrollTop + 'px';
    sectionDropGuide.hidden = false;
  }

  function finishSectionDrag(drop) {
    const drag = sectionDrag;
    if (!drag) return;
    sectionDrag = null;
    cancelAnimationFrame(drag.frame);
    if (viewport.hasPointerCapture(drag.pointer)) viewport.releasePointerCapture(drag.pointer);
    viewport.classList.remove('section-moving');
    sectionDropGuide.hidden = true;
    scheduleSectionShading();
    if (!drop || drag.position == null || !visual || busy || fileDialogOpen() || markdown !== drag.original) return;

    const { start, end, boundary, position } = drag;
    const section = markdown.slice(start, end);
    const movingUp = position < start;
    const middleStart = movingUp ? position : boundary;
    const middleEnd = sectionContentEnd(middleStart, movingUp ? start : position);
    if (middleEnd <= middleStart) return;
    const middle = markdown.slice(middleStart, middleEnd);
    const gap = movingUp ? markdown.slice(middleEnd, start) : markdown.slice(end, boundary);
    const first = movingUp ? section : middle;
    const second = movingUp ? middle : section;
    const separator = gap.includes('\n\n') ? gap : markdownBlockSeparator(first, second);
    const from = movingUp ? position : start;
    const to = movingUp ? end : middleEnd;
    markdown = markdown.slice(0, from) + first + separator + second + markdown.slice(to);
    cursor = movingUp ? from : from + first.length + separator.length;
    render();
    focusVisual(blockAt(cursor).element ?? paper);
    updateEditedDocument();
    rememberEditorChange();
    setStatus('已移动整段');
  }

  function updateBodyFolds() {
    scheduleSectionShading();
    blockControls.hidden = mode !== 'visual' || !visual;
    if (blockControls.hidden) {
      blockHandle.hidden = true;
      for (const button of blockControls.querySelectorAll('.block-fold')) button.remove();
      return;
    }
    const ancestors = [];
    visual.foldable = new Set();
    visual.covered = new Map();
    for (const node of paper.children) {
      const depth = headingDepth(node);
      while (depth && ancestors.length && ancestors.at(-1).depth >= depth) ancestors.pop();
      if (ancestors.length) visual.foldable.add(ancestors.at(-1).node);
      const covering = ancestors.filter(entry => visual.folded.has(entry.node));
      if (covering.length) visual.covered.set(node, covering);
      node.toggleAttribute('data-fold-hidden', covering.length > 0);
      if (depth) ancestors.push({ depth, node });
    }
    visual.folded = new Set([...visual.folded].filter(node => visual.foldable.has(node)));
    visualFolds = new Set([...visual.folded].map(node => node.id).filter(Boolean));
    scheduleBlockLayout();
  }

  function revealVisualBlock(node) {
    const covering = visual?.covered?.get(node);
    if (!covering?.length) return;
    for (const entry of covering) visual.folded.delete(entry.node);
    updateBodyFolds();
  }

  function revealFoldedSelection(range) {
    if (!visual || range.collapsed) return false;
    const covered = [...visual.covered].filter(([node]) => range.intersectsNode(node));
    if (!covered.length) return false;
    for (const [, ancestors] of covered) {
      for (const { node } of ancestors) visual.folded.delete(node);
    }
    updateBodyFolds();
    setStatus('已展开选区中的章节，请确认选区后重试');
    return true;
  }

  function toggleBodyFold(node) {
    closeBlockMenu();
    if (visual.folded.delete(node)) {
      updateBodyFolds();
      return;
    }
    visual.folded.add(node);
    updateBodyFolds();
    const selection = getSelection();
    if (selection.rangeCount && [...visual.covered.keys()].some(block => selection.getRangeAt(0).intersectsNode(block))) {
      const focused = document.activeElement;
      focusVisual(node);
      if (blockControls.contains(focused)) focused.focus({ preventScroll: true });
    }
  }

  function scheduleBlockLayout() {
    if (!blockLayout) blockLayout = requestAnimationFrame(layoutBlockControls);
  }

  function blockLabel(node) {
    if (headingDepth(node)) return node.tagName;
    if (node.tagName === 'P' && !node.textContent.trim() && node.querySelector('img')) return '图片';
    if (isBlankParagraph(node)) return '空行';
    return { P: 'T', DIV: 'T', UL: '列表', OL: '列表', BLOCKQUOTE: '引用',
      PRE: '代码', TABLE: '表格', HR: '分隔' }[node.tagName] ?? '块';
  }

  function isBlankParagraph(node) {
    return node.contentEditable !== 'false' && node.matches('p, div') && !node.textContent.trim() &&
      !node.querySelector('img, input, hr, table, pre, ul, ol, blockquote');
  }

  function prepareVisualBlockCaret(node) {
    const target = node.matches('ul, ol, pre') ? node.querySelector('li, code') ?? node : node;
    if (target.matches('p, h1, h2, h3, h4, h5, h6, blockquote, li, code') && !target.hasChildNodes()) {
      target.append(document.createElement('br'));
    }
    return target;
  }

  function layoutBlockLabels(position) {
    const labels = visual.blockLabels ??= new Map();
    for (const [node, button] of labels) {
      if (showBlockLabels && node.parentNode === paper) continue;
      button.remove();
      labels.delete(node);
    }
    if (!showBlockLabels) return;
    for (const node of paper.children) {
      let button = labels.get(node);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'block-type-label';
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-controls', 'block-menu');
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('mousedown', event => event.preventDefault());
        button.addEventListener('click', () => showBlockMenu(node, button));
        labels.set(node, button);
        blockControls.append(button);
      }
      const type = node.matches('ol, ul') ? (node.querySelector('input[type="checkbox"]') ? '任务' :
        node.tagName === 'OL' ? '有序' : '无序') : blockLabel(node);
      const label = type === 'T' ? '正文' : type;
      if (button.textContent !== label) {
        button.textContent = label;
        button.setAttribute('aria-label', '段落操作 · ' + label);
      }
      button.hidden = node.hasAttribute('data-fold-hidden') ||
        (node === blockTarget && !blockHandle.hidden) || !position(button, node, 67);
    }
  }

  function placeBlockMenu() {
    if (blockMenu.hidden || !menuAnchor) return;
    const anchor = menuAnchor.getBoundingClientRect();
    const menuWidth = blockMenu.offsetWidth;
    const left = anchor.left - menuWidth - 8;
    const x = left >= 6 ? left : anchor.right + 8;
    blockMenu.style.left = Math.max(6, Math.min(x, innerWidth - menuWidth - 6)) + 'px';
    const below = anchor.bottom + 4;
    const top = below + blockMenu.offsetHeight <= innerHeight - 6 ? below : anchor.top - blockMenu.offsetHeight - 4;
    blockMenu.style.top = Math.max(6, Math.min(top, innerHeight - blockMenu.offsetHeight - 6)) + 'px';
  }

  function layoutBlockControls() {
    blockLayout = 0;
    if (blockControls.hidden) return;
    const view = viewport.getBoundingClientRect();
    const position = (button, node, left) => {
      const rect = node.getBoundingClientRect();
      button.style.left = rect.left - view.left + viewport.scrollLeft - left + 'px';
      button.style.top = rect.top - view.top + viewport.scrollTop + 'px';
      return rect.bottom > view.top && rect.top < view.bottom;
    };
    const available = node => node?.parentNode === paper && !node.hasAttribute('data-fold-hidden');
    const caret = document.activeElement === paper && visualBlockAt(getSelection().focusNode);
    const selection = menuBlock ? menuSelection : [...textSelectionBlocks];
    const batchAnchor = selection.length > 1 ? selection.find(node => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > view.top && rect.top < view.bottom;
    }) : null;
    const candidate = menuBlock ?? batchAnchor ?? blockHover ?? (document.activeElement === blockHandle ? blockTarget : caret);
    const previousTarget = blockTarget;
    blockTarget = available(candidate) ? candidate : null;
    const floatingHandle = !showBlockLabels || (menuBlock ? menuAnchor === blockHandle : selection.length > 1);
    blockHandle.hidden = !floatingHandle || !blockTarget || !position(blockHandle, blockTarget, 67);
    if (previousTarget !== blockTarget) previousTarget?.removeAttribute('data-list-handle-target');
    const targetsList = !blockHandle.hidden && blockTarget.matches('ol, ul');
    blockTarget?.toggleAttribute('data-list-handle-target', targetsList);
    blockHandle.toggleAttribute('data-list-handle', targetsList);
    if (blockTarget && !blockHandle.hidden) {
      const label = selection.length > 1 ? String(selection.length) : blockLabel(blockTarget);
      blockHandle.textContent = label;
      blockHandle.setAttribute('aria-label', selection.length > 1 ? '批量段落操作 · ' + label + ' 个块' :
        '段落操作 · ' + (label === 'T' ? '正文' : label));
    }
    layoutBlockLabels(position);
    if (menuAnchor && (!menuAnchor.isConnected || menuAnchor.hidden)) closeBlockMenu();
    else placeBlockMenu();
    layoutHeadingTools(view);
    layoutCodeTools(position);

    visual.foldButtons ??= new Map();
    for (const [node, button] of visual.foldButtons) {
      if (visual.foldable.has(node)) continue;
      button.remove();
      visual.foldButtons.delete(node);
    }
    for (const node of visual.foldable) {
      let button = visual.foldButtons.get(node);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'block-fold';
        foldHeadingTargets.set(button, node);
        button.addEventListener('click', () => toggleBodyFold(node));
        visual.foldButtons.set(node, button);
        blockControls.append(button);
      }
      button.hidden = !available(node) || !position(button, node, 24);
      const expanded = !visual.folded.has(node);
      button.setAttribute('aria-expanded', String(expanded));
      button.setAttribute('aria-label', (expanded ? '折叠章节 ' : '展开章节 ') + node.textContent);
    }
  }

  function layoutCodeTools(position) {
    const widgets = visual.codeWidgets ??= new Map();
    for (const [pre, widget] of widgets) {
      if (paper.contains(pre)) continue;
      widget.root.remove();
      widgets.delete(pre);
    }
    for (const pre of paper.querySelectorAll('pre')) {
      if (pre.closest('[contenteditable="false"]')) continue;
      let widget = widgets.get(pre);
      if (!widget) {
        widget = createCodeTools(pre);
        widgets.set(pre, widget);
        pre.setAttribute('data-code-tools', '');
      }
      widget.root.hidden = Boolean(pre.closest('[data-fold-hidden]')) || !position(widget.root, pre, 0);
      if (widget.root.hidden) continue;
      widget.root.style.width = pre.getBoundingClientRect().width + 'px';
      if (widget.revision === visual.codeRevision) continue;
      widget.revision = visual.codeRevision;
      const language = visualMarkdown.codeLanguage(pre) || '纯文本';
      widget.language.textContent = language;
      widget.language.setAttribute('aria-label', '修改代码语言 · ' + language);
      const count = visualMarkdown.codeText(pre).split('\n').length;
      widget.lines.textContent = Array.from({ length: count }, (_, index) => index + 1).join('\n');
      const digits = String(count).length;
      pre.style.setProperty('--code-digits', digits);
      widget.root.style.setProperty('--code-digits', digits);
    }
  }

  function createCodeTools(pre) {
    const root = document.createElement('div');
    root.className = 'code-tools';
    const header = document.createElement('div');
    header.className = 'code-tools-header';
    const language = document.createElement('button');
    language.type = 'button';
    language.className = 'code-language';
    language.title = '修改代码语言';
    language.addEventListener('click', () => editCodeLanguage(pre));
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '复制';
    copy.setAttribute('aria-label', '复制代码');
    copy.addEventListener('click', () => void copyCode(pre));
    const lines = document.createElement('div');
    lines.className = 'code-lines';
    lines.setAttribute('aria-hidden', 'true');
    header.append(language, copy);
    root.append(header, lines);
    blockControls.append(root);
    return { root, language, lines, revision: -1 };
  }

  async function copyCode(pre) {
    if (busy) return;
    const contents = visualMarkdown.codeText(pre);
    if (!contents) {
      setStatus('代码块为空');
      return;
    }
    busy = true;
    try {
      if (desktop) await desktopRequest({ action: 'copy-editor-text', contents });
      else await navigator.clipboard.writeText(contents);
      setStatus('已复制代码');
    } catch (error) {
      setStatus(error.message);
    } finally {
      busy = false;
    }
  }

  function editCodeLanguage(pre) {
    if (busy || !visual) return;
    const current = visualMarkdown.codeLanguage(pre);
    const language = window.prompt('代码语言（例如 javascript、c# 或 bash，留空为纯文本）', current)?.trim?.();
    if (language == null || language === current) return;
    if (language && !/^[\w+.#-]{1,40}$/.test(language)) {
      setStatus('请输入有效的代码语言名称');
      return;
    }
    captureVisualCaret();
    const range = visual.ranges.get(pre);
    if (range) {
      const raw = markdown.slice(range.start, range.end);
      const fence = /^( {0,3}(?:\x60{3,}|~{3,}))([ \t]*)([^ \t\n]*)([^\n]*)/.exec(raw);
      const replacement = fence
        ? fence[1] + (language ? fence[2] + language + fence[4] : '') + raw.slice(fence[0].length)
        : visualMarkdown.fenceCode(visualMarkdown.codeText(pre), language);
      markdown = markdown.slice(0, range.start) + replacement + markdown.slice(range.end);
      cursor = range.start;
      render();
      const restored = blocks.find(block => block.start === cursor && block.element)?.element;
      if (restored) focusVisual(visualMarkdown.codeContent(restored));
      updateEditedDocument();
      rememberEditorChange();
      return;
    }
    const code = visualMarkdown.codeContent(pre);
    if (current) code.classList.remove('language-' + current);
    if (language) code.classList.add('language-' + language);
    focusVisual(code);
    recordVisualInput();
  }

  function selectedVisualBlocks(range = getSelection().rangeCount ? getSelection().getRangeAt(0) : null) {
    if (!visual || !range || range.collapsed ||
        !paper.contains(range.startContainer) || !paper.contains(range.endContainer)) return [];
    const first = visualBlockAt(range.startContainer);
    const last = visualBlockAt(range.endContainer);
    return [...paper.children].filter(block => {
      if (block.hasAttribute('data-fold-hidden') || !range.intersectsNode(block)) return false;
      if (block !== first && block !== last) return true;
      const part = document.createRange();
      part.selectNodeContents(block);
      if (block === first) part.setStart(range.startContainer, range.startOffset);
      if (block === last) part.setEnd(range.endContainer, range.endOffset);
      return Boolean(part.toString() || part.cloneContents().querySelector('img, input, hr'));
    });
  }

  function updateTextSelectionBlocks() {
    const focus = document.activeElement;
    const selected = new Set(focus === paper ? selectedVisualBlocks() :
      headingTools.contains(focus) ? selectedVisualBlocks(headingToolsRange) : []);
    for (const block of textSelectionBlocks) {
      if (!selected.has(block)) block.removeAttribute('data-text-selected');
    }
    for (const block of selected) {
      if (!textSelectionBlocks.has(block)) block.setAttribute('data-text-selected', '');
    }
    textSelectionBlocks = selected;
  }

  function selectedHeadingBlocks() {
    if (!visual) return [];
    return [...textSelectionBlocks].filter(node => headingDepth(node) && visual.ranges.has(node));
  }

  function headingChangeAllowed(headings, change) {
    const depths = headings.map(headingDepth);
    if (change === 'up') return depths.every(depth => depth > 1);
    if (change === 'down') return depths.every(depth => depth < 6);
    return depths.some(depth => depth !== Number(change));
  }

  function selectedParagraphBlocks() {
    return [...textSelectionBlocks].filter(node =>
      node.matches('p') && visual.ranges.has(node) && node.textContent.trim() && !node.querySelector('img'));
  }

  function layoutHeadingTools(view) {
    const selection = getSelection();
    const range = headingToolsRange ?? (selection.rangeCount ? selection.getRangeAt(0) : null);
    headingTools.hidden = !range || range.collapsed || !textSelectionBlocks.size || Boolean(menuBlock);
    if (headingTools.hidden) return;
    const headings = selectedHeadingBlocks();
    const paragraphs = headings.length ? [] : selectedParagraphBlocks();
    headingToolsCount.textContent = headings.length ? headings.length + ' 个标题' :
      paragraphs.length ? paragraphs.length + ' 个段落' : '已选内容';
    headingShiftTools.hidden = !headings.length;
    headingLevelTools.hidden = !headings.length && !paragraphs.length;
    for (const button of headingButtons) {
      button.disabled = headings.length ? !headingChangeAllowed(headings, button.dataset.headingChange) : !paragraphs.length;
    }
    const canFormatText = Boolean(range.toString()) &&
      ![...textSelectionBlocks].some(node => node.matches('pre') || node.querySelector('pre'));
    for (const button of selectionTextButtons) {
      button.disabled = button.dataset.selectionAction !== 'copy' && !canFormatText;
    }
    const anchor = [...textSelectionBlocks].find(node => node.getBoundingClientRect().bottom > view.top);
    if (!anchor || anchor.getBoundingClientRect().top >= view.bottom) {
      headingTools.hidden = true;
      return;
    }
    const left = Math.min(paper.getBoundingClientRect().right + 10, view.right - headingTools.offsetWidth - 10);
    const top = Math.max(view.top + 8, Math.min(anchor.getBoundingClientRect().top,
      view.bottom - headingTools.offsetHeight - 8));
    headingTools.style.left = Math.max(8, left - view.left + viewport.scrollLeft) + 'px';
    headingTools.style.top = top - view.top + viewport.scrollTop + 'px';
  }

  function selectVisualBlockSpan(first, last) {
    if (first?.parentNode !== paper || last?.parentNode !== paper) return false;
    focusVisual(first);
    const range = document.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    updateTextSelectionBlocks();
    return true;
  }

  function selectVisualSourceSpan(start, end) {
    const selected = visualSourceRanges(start, end);
    return selectVisualBlockSpan(selected[0]?.element, selected.at(-1)?.element);
  }

  function visualSourceRanges(start, end) {
    if (start >= end) return [];
    return [...visual.ranges.values()].filter(range => range.start < end && range.end > start &&
      !range.element.hasAttribute('data-fold-hidden'));
  }

  function applyHeadingChange(change) {
    if (!visual || busy) return;
    const headings = selectedHeadingBlocks();
    if (!headings.length) {
      if (/^[1-6]$/.test(change)) applyBatchFormat(batchEditableBlocks(selectedParagraphBlocks()), 'h' + change);
      return;
    }
    if (!headingChangeAllowed(headings, change)) return;
    const selectionRanges = [...textSelectionBlocks].map(node => visual.ranges.get(node)).filter(Boolean);
    const start = selectionRanges[0].start;
    let end = selectionRanges.at(-1).end;
    const edits = headings.flatMap(node => {
      const range = visual.ranges.get(node);
      const depth = headingDepth(node);
      const level = change === 'up' ? depth - 1 : change === 'down' ? depth + 1 : Number(change);
      if (level === depth) return [];
      const raw = markdown.slice(range.start, range.end);
      const heading = marked.lexer(raw)[0];
      if (heading?.type !== 'heading') return [];
      const hashes = '#'.repeat(level);
      const text = /^ {0,3}#/.test(raw)
        ? raw.replace(/^( {0,3})#{1,6}/, '$1' + hashes)
        : hashes + ' ' + heading.text.replace(/\s*\n\s*/g, ' ').replace(/(?<=\s)#+$/, '\\$&');
      return [{ range, text }];
    });
    if (!edits.length) return;
    captureVisualCaret();
    let previousEnd = 0;
    const parts = [];
    for (const { range, text } of edits) {
      parts.push(markdown.slice(previousEnd, range.start), text);
      previousEnd = range.end;
      end += text.length - (range.end - range.start);
    }
    parts.push(markdown.slice(previousEnd));
    markdown = parts.join('');
    cursor = start;
    render();
    selectVisualSourceSpan(start, end);
    updateEditedDocument();
    rememberEditorChange();
    setStatus('已调整 ' + edits.length + ' 个标题');
  }

  function closeBlockMenu(restoreFocus = false) {
    if (!menuBlock) return;
    for (const node of menuSelection) node.removeAttribute('data-block-selected');
    menuSelection = [];
    menuBlock = null;
    blockMenu.hidden = true;
    const anchor = menuAnchor;
    menuAnchor = null;
    anchor?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) anchor?.focus({ preventScroll: true });
    scheduleBlockLayout();
  }

  const blockFormats = [
    ['h0', '正文'], ['h1', 'H1'], ['h2', 'H2'], ['h3', 'H3'], ['h4', 'H4'], ['h5', 'H5'], ['h6', 'H6'],
    ['unordered', '无序列表'], ['ordered', '有序列表'], ['task', '任务列表'],
    ['quote', '引用'], ['fence', '代码块'],
  ];

  const blockMenuIcons = {
    h0: 'M3 4h10M3 8h10M3 12h7',
    unordered: 'M6 4h7M6 8h7M6 12h7M3 4h.01M3 8h.01M3 12h.01',
    ordered: 'M7 5h6M7 11h6M2 3h1.5v4M2 7h3M2 10h2.5v1.5H2V13h3',
    task: 'M12 7v5H3V3h6M6 7l2 2 5-5',
    quote: 'M7 4C4 5 3 7 3 10h4V7H3.5M13 4c-3 1-4 3-4 6h4V7H9.5',
    fence: 'm5.5 5-3 3 3 3m5-6 3 3-3 3',
    link: 'M6.5 9.5l3-3M5.5 10.5H4a2.5 2.5 0 0 1 0-5h2m4 0H12a2.5 2.5 0 0 1 0 5h-2',
    above: 'M3 12h10M8 3v6M5 6h6',
    below: 'M3 4h10M8 7v6m-3-3h6',
    copy: 'M6 6h7v7H6zM10 3H3v7',
    cut: 'm5.5 6 7 6m-7-2 7-7M5.5 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm0 6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z',
    remove: 'M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.5 8.5h7l.5-8.5M6.5 7v3.5m3-3.5v3.5',
  };

  function editableBlockSource(node, range) {
    if (node.contentEditable === 'false') return null;
    if (isBlankParagraph(node)) return { action: 'h0', body: '', plain: '' };
    const token = range && marked.lexer(markdown.slice(range.start, range.end))[0];
    if (!token) return null;
    let body = token.text;
    let action = token.type === 'heading' ? 'h' + token.depth : 'h0';
    if (token.type === 'blockquote') {
      if (token.tokens.length > 1 || (token.tokens.length && token.tokens[0].type !== 'paragraph')) return null;
      body = token.tokens[0]?.text ?? '';
      action = 'quote';
    } else if (token.type === 'list') {
      const [item] = token.items;
      action = token.items.every(entry => entry.task) ? 'task' : token.ordered ? 'ordered' : 'unordered';
      if (token.items.length !== 1 || item.tokens.length > 1 ||
          (item.tokens.length && !['text', 'paragraph'].includes(item.tokens[0].type))) {
        return { action, body: token.raw, items: token.items };
      }
      body = item.task && item.text === '&nbsp;' ? '' : item.text;
    } else if (token.type === 'code') {
      action = 'fence';
      const paragraph = document.createElement('p');
      token.text.split('\n').forEach((line, index) => {
        if (index) paragraph.append(document.createElement('br'));
        paragraph.append(line);
      });
      body = visualMarkdown.serialize(paragraph);
    } else if (!['paragraph', 'heading'].includes(token.type)) {
      return null;
    }
    return { action, body, plain: token.type === 'code' ? token.text : body ? node.textContent : '' };
  }

  function showBlockMenu(node = blockTarget, anchor = blockHandle) {
    if (!visual || !node || busy || main.inert || node.parentNode !== paper) return;
    if (menuBlock === node) {
      closeBlockMenu(true);
      return;
    }
    const selected = selectedVisualBlocks();
    const batch = selected.length > 1 ? batchEditableBlocks(selected) : null;
    closeBlockMenu();
    closeNoteMenu();
    menuBlock = node;
    menuAnchor = anchor;
    menuSelection = batch ? selected : [node];
    for (const block of menuSelection) block.setAttribute('data-block-selected', '');
    blockMenu.replaceChildren();
    blockMenu.setAttribute('aria-label', batch ? '批量段落操作' : '段落操作');
    blockMenu.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    const add = (parent, action, label, checked = null, disabled = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      if (blockMenuIcons[action]) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add('block-menu-icon');
        const path = document.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute('d', blockMenuIcons[action]);
        svg.append(path);
        button.append(svg, label);
      } else {
        button.classList.add('block-menu-level');
        button.textContent = label;
      }
      if (action === 'remove') button.classList.add('block-menu-remove');
      button.setAttribute('role', checked === null ? 'menuitem' : 'menuitemradio');
      if (checked !== null) button.setAttribute('aria-checked', String(checked));
      button.disabled = disabled;
      button.addEventListener('click', () => {
        if (batch) {
          closeBlockMenu(true);
          applyBatchFormat(batch, action);
        } else void runBlockAction(node, action);
      });
      parent.append(button);
    };
    const addGroup = (label, layout) => {
      const group = document.createElement('div');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
      if (layout) group.className = layout;
      blockMenu.append(group);
      return group;
    };
    if (batch) {
      const summary = document.createElement('p');
      summary.className = 'block-menu-summary';
      summary.textContent = batch.length === selected.length ? '已选 ' + selected.length + ' 个块' :
        '已选 ' + selected.length + ' 个块，' + batch.length + ' 个可排版';
      blockMenu.append(summary);
      const headings = addGroup('批量设置段落与标题', 'block-menu-headings');
      const formats = addGroup('批量设置列表、引用和代码', 'block-menu-formats');
      for (const [action, label] of blockFormats) {
        add(action.startsWith('h') ? headings : formats, action, label,
          batch.length > 0 && batch.every(({ editable }) => editable.action === action),
          !batch.length);
      }
    } else {
      const range = visual.ranges.get(node);
      const editable = editableBlockSource(node, range);
      if (editable) {
        const availableFormats = editable.items ? blockFormats.filter(([action]) =>
          ['ordered', 'unordered', 'task'].includes(action)) : blockFormats;
        const headings = editable.items ? null : addGroup('段落与标题', 'block-menu-headings');
        const formats = addGroup('列表、引用和代码', 'block-menu-formats');
        for (const [action, label] of availableFormats) {
          add(action.startsWith('h') ? headings : formats, action, label,
            action === editable.action);
        }
        if (node.matches('p, h1, h2, h3, h4, h5, h6') && !node.querySelector('img') &&
            (!node.querySelector('a[href]') || standaloneBlockLink(node))) {
          add(formats, 'link', '超链接');
        }
      }
      const insert = addGroup('插入段落');
      add(insert, 'above', '在上方插入正文段');
      add(insert, 'below', '在下方插入正文段');
      const edit = addGroup('编辑段落');
      add(edit, 'copy', '复制 Markdown', null, !range);
      add(edit, 'cut', '剪切段落', null, !range);
      add(edit, 'remove', '删除段落');
    }
    if (blockLayout) cancelAnimationFrame(blockLayout);
    layoutBlockControls();
    (blockMenu.querySelector('button:not(:disabled)') ?? blockMenu).focus({ preventScroll: true });
  }

  function formatBlockSource(action, editable) {
    if (action === 'fence') return visualMarkdown.fenceCode(editable.plain);
    if (action === 'h0') return editable.body;
    if (/^h[1-6]$/.test(action)) {
      return '#'.repeat(Number(action[1])) + ' ' + editable.body.replace(/\s*\n\s*/g, ' ').replace(/(?<=\s)#+$/, '\\$&');
    }
    const items = editable.items ?? [{ text: editable.body }];
    return items.map((item, index) => {
      const marker = { quote: '> ', unordered: '- ', ordered: (index + 1) + '. ', task: '- ' }[action];
      const task = action === 'task' ? (item.checked ? '[x] ' : '[ ] ') : '';
      if (task && !item.text) return marker + task + '&nbsp;';
      return item.text.split('\n').map((line, lineIndex) => {
        if (!lineIndex) return marker + task + line;
        if (action === 'quote') return marker + line;
        return line ? ' '.repeat(marker.length) + line : '';
      }).join('\n');
    }).join('\n');
  }

  function standaloneBlockLink(node) {
    if (!node.matches('p, h1, h2, h3, h4, h5, h6') || node.querySelector('img, br')) return null;
    const title = node.textContent.trim();
    const links = node.querySelectorAll('a[href]');
    if (links.length === 1 && title === links[0].textContent.trim()) {
      return { title, link: links[0].cloneNode(false) };
    }
    if (links.length || !/^https?:\/\/[^\s<>]+$/i.test(title)) return null;
    try { new URL(title); } catch { return null; }
    const link = document.createElement('a');
    link.setAttribute('href', title);
    return { title, link };
  }

  function showBlockLinkDialog(node) {
    const previous = standaloneBlockLink(node);
    const address = previous?.link.getAttribute('href') ?? '';
    const text = byId('block-link-text');
    const url = byId('block-link-url');
    text.value = previous?.title === address ? '' : previous?.title ?? node.textContent.trim().replace(/\s+/g, ' ');
    url.value = address;
    byId('block-link-error').textContent = '';
    blockLinkTarget = { node, previous, editor: visual };
    blockLinkDialog.showModal();
    (address ? text : url).select();
  }

  byId('block-link-cancel').addEventListener('click', () => blockLinkDialog.close());
  blockLinkDialog.addEventListener('close', () => { blockLinkTarget = null; });
  byId('block-link-form').addEventListener('submit', event => {
    event.preventDefault();
    const target = blockLinkTarget;
    if (!target || target.editor !== visual || target.node.parentNode !== paper) {
      blockLinkDialog.close();
      return;
    }
    const address = byId('block-link-url').value.trim();
    try {
      if (!address || !['https:', 'http:', 'mailto:'].includes(new URL(address, location.href).protocol)) throw new Error();
    } catch {
      byId('block-link-error').textContent = '请输入有效的网页地址、邮件链接或笔记相对路径。';
      return;
    }
    const link = target.previous?.link ?? document.createElement('a');
    link.setAttribute('href', address);
    link.textContent = byId('block-link-text').value.trim() || address;
    blockLinkDialog.close();
    target.node.replaceChildren(link);
    focusVisual(target.node, true);
    recordVisualInput(undefined, { preserveTail: true });
    scheduleBlockLayout();
  });

  function batchEditableBlocks(selected) {
    return selected.flatMap(node => {
      if (!node.matches('p, h1, h2, h3, h4, h5, h6') || node.querySelector('img')) return [];
      const range = visual.ranges.get(node);
      const editable = range && editableBlockSource(node, range);
      return editable?.body?.trim() ? [{ range, editable }] : [];
    });
  }

  function applyBatchFormat(batch, action) {
    if (!visual || busy) return;
    const edits = batch.filter(({ editable }) => editable.action !== action);
    if (!edits.length) return;
    const pieces = [];
    let length = 0;
    let tail = '';
    let previousEnd = 0;
    let firstPosition;
    let lastPosition;
    function append(value, separate) {
      if (!value) return length;
      const separator = separate ? markdownBlockSeparator(tail, value) : '';
      const start = length + separator.length;
      pieces.push(separator, value);
      tail = value.length >= 2 ? value.slice(-2) : (tail + separator + value).slice(-2);
      length = start + value.length;
      return start;
    }
    for (const { range, editable } of edits) {
      const gap = markdown.slice(previousEnd, range.start);
      append(gap, previousEnd > 0 && Boolean(gap.trim()));
      lastPosition = append(formatBlockSource(action, editable), true);
      firstPosition ??= lastPosition;
      previousEnd = range.end;
    }
    const after = markdown.slice(previousEnd);
    const afterStart = append(after, Boolean(after.trim()));
    if (batch[0].range.start < edits[0].range.start) firstPosition = batch[0].range.start;
    if (batch.at(-1).range.start >= previousEnd) lastPosition = afterStart + batch.at(-1).range.start - previousEnd;
    captureVisualCaret();
    markdown = pieces.join('');
    cursor = firstPosition;
    render();
    const first = blockAt(firstPosition + 1).element;
    const last = blockAt(lastPosition + 1).element;
    if (!selectVisualBlockSpan(first, last)) focusVisual(first ?? paper);
    updateEditedDocument();
    rememberEditorChange();
    setStatus('已排版 ' + edits.length + ' 个块');
  }

  async function runBlockAction(node, action) {
    if (!visual || node !== menuBlock || busy) return;
    const range = visual.ranges.get(node);
    closeBlockMenu(true);
    if (action === 'link') {
      captureVisualCaret();
      showBlockLinkDialog(node);
      return;
    }
    if (action === 'copy' || action === 'cut') {
      if (!range) return;
      const snapshot = markdown;
      const contents = markdown.slice(range.start, range.end);
      busy = true;
      try {
        if (desktop) await desktopRequest({ action: 'copy-editor-text', contents });
        else await navigator.clipboard.writeText(contents);
        if (action === 'copy' || markdown !== snapshot || node.parentNode !== paper) return;
      } catch (error) {
        setStatus(error.message);
        return;
      } finally {
        busy = false;
      }
    }
    if (action === 'above' || action === 'below') {
      captureVisualCaret();
      if (action === 'below' && visual.folded.delete(node)) updateBodyFolds();
      const paragraph = document.createElement('p');
      paragraph.dataset.insertedBlock = '';
      paragraph.append(document.createElement('br'));
      node[action === 'above' ? 'before' : 'after'](paragraph);
      focusVisual(paragraph);
      paragraph.scrollIntoView({ block: 'nearest' });
      updateBodyFolds();
      rememberEditorChange();
      return;
    }
    const editable = action !== 'cut' && action !== 'remove' ? editableBlockSource(node, range) : null;
    if (editable?.body === '') {
      if (editable.action === action) return;
      captureVisualCaret();
      const replacement = formatBlockSource(action, editable).trimEnd();
      const target = replacement
        ? renderBlock({ start: 0, end: replacement.length, tokens: marked.lexer(replacement) }, replacement).firstElementChild
        : document.createElement('p');
      if (!replacement) target.dataset.insertedBlock = '';
      const caret = prepareVisualBlockCaret(target);
      node.replaceWith(target);
      focusVisual(caret, action === 'task');
      target.scrollIntoView({ block: 'nearest' });
      recordVisualInput(undefined, { preserveTail: true });
      return;
    }
    if (!range) {
      const neighbor = node.nextElementSibling ?? node.previousElementSibling;
      if (!neighbor) {
        focusVisual(node);
        return;
      }
      captureVisualCaret();
      node.remove();
      focusVisual(neighbor);
      updateBodyFolds();
      rememberEditorChange();
      return;
    }
    let { start, end } = range;
    let replacement = '';
    if (action === 'cut' || action === 'remove') {
      const previous = [...visual.ranges.values()].findLast(item => item.end <= start);
      const next = [...visual.ranges.values()].find(item => item.start >= end);
      if (next) end = next.start;
      else if (previous) start = previous.end;
    } else {
      if (!editable?.body) return;
      const linkedHeading = /^h[1-6]$/.test(action) && standaloneBlockLink(node);
      if (linkedHeading) {
        const { link, title } = linkedHeading;
        const initial = title === link.getAttribute('href') ? '' : title;
        const label = window.prompt('链接标题（留空使用原文字）', initial);
        if (typeof label !== 'string') return;
        link.textContent = label.trim() || title;
        const paragraph = document.createElement('p');
        paragraph.append(link);
        replacement = formatBlockSource(action, { ...editable, body: visualMarkdown.serialize(paragraph) });
      } else {
        if (editable.action === action) return;
        replacement = formatBlockSource(action, editable);
      }
      if (replacement === markdown.slice(start, end)) return;
    }
    captureVisualCaret();
    const left = markdown.slice(0, start);
    const inserted = joinMarkdownBlocks(left, replacement);
    markdown = joinMarkdownBlocks(inserted, markdown.slice(end));
    cursor = replacement ? inserted.length - replacement.length : start;
    render();
    const target = blockAt(cursor).element ?? paper.firstElementChild ?? paper;
    focusVisual(target);
    target.scrollIntoView({ block: 'nearest' });
    updateEditedDocument();
    rememberEditorChange();
  }

  function editorSnapshot() {
    if (!visual) return { text: markdown, cursor, blanks: [], index: -1, offset: 0, blockStart: active?.left.length };
    const selection = getSelection();
    const node = visualBlockAt(selection.focusNode);
    const children = [...paper.children];
    let offset = 0;
    if (node) {
      const caret = document.createRange();
      caret.selectNodeContents(node);
      caret.setEnd(selection.focusNode, selection.focusOffset);
      offset = caret.toString().length;
    }
    return {
      text: markdown,
      cursor,
      blanks: children.flatMap((child, index) =>
        child.hasAttribute('data-inserted-block') && !visual.ranges.has(child) ? [index] : []),
      index: children.indexOf(node),
      offset,
    };
  }

  function resetEditorHistory() {
    editorUndo = [];
    editorRedo = [];
    editorTyping = null;
    editorHistory = editorSnapshot();
    byId('undo-edit').disabled = true;
  }

  function captureVisualCaret() {
    if (editorHistory?.text !== markdown) return;
    const { index, offset } = editorSnapshot();
    if (index >= 0) Object.assign(editorHistory, { index, offset });
  }

  function rememberEditorChange(inputType) {
    const next = editorSnapshot();
    if (editorHistory?.text === next.text && editorHistory.blanks.join() === next.blanks.join()) return;
    const typing = /^(insertText|insertCompositionText|deleteContentBackward|deleteContentForward)$/.test(inputType)
      ? (inputType === 'insertCompositionText' ? 'insertText' : inputType) : null;
    const now = performance.now();
    if (editorHistory && (!typing || editorTyping?.type !== typing || editorTyping.index !== next.index ||
        editorTyping.blockStart !== next.blockStart ||
        now - editorTyping.time > 750)) {
      editorUndo.push(editorHistory);
      if (editorUndo.length > 100) editorUndo.shift();
    }
    editorHistory = next;
    editorTyping = typing ? { type: typing, index: next.index, blockStart: next.blockStart, time: now } : null;
    editorRedo.length = 0;
    byId('undo-edit').disabled = !editorUndo.length;
  }

  function stepEditorHistory(redo) {
    const from = redo ? editorRedo : editorUndo;
    const to = redo ? editorUndo : editorRedo;
    const previous = from.pop();
    if (!previous) return;
    if (visual) captureVisualCaret();
    const continueEditing = Boolean(active);
    to.push(editorHistory);
    active = null;
    markdown = previous.text;
    cursor = Math.min(previous.cursor, markdown.length);
    render();
    if (visual) {
      for (const index of previous.blanks) {
        const paragraph = document.createElement('p');
        paragraph.dataset.insertedBlock = '';
        paragraph.append(document.createElement('br'));
        paper.insertBefore(paragraph, paper.children[index] ?? null);
      }
      if (!visual.ranges.size && previous.blanks.length) {
        paper.querySelector('p:not([data-inserted-block])')?.remove();
      }
      const target = paper.children[previous.index] ?? blockAt(cursor).element ?? paper;
      focusVisual(target, false, previous.index < 0 ? null : previous.offset);
      target.scrollIntoView({ block: 'nearest' });
    } else if (mode === 'source') {
      source.value = markdown;
      source.focus({ preventScroll: true });
      source.setSelectionRange(cursor, cursor);
    } else {
      const block = blockAt(cursor);
      block.element.scrollIntoView({ block: 'nearest' });
      if (continueEditing) focusBlock(block, Math.max(0, cursor - block.start));
    }
    updateEditedDocument();
    editorHistory = previous;
    editorTyping = null;
    byId('undo-edit').disabled = !editorUndo.length;
    desktop?.postMessage({ action: redo ? 'editor-redo' : 'editor-undo' });
    setStatus(redo ? '已重做' : '已撤回上一步');
  }

  function handleHistoryInput(event) {
    if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return;
    event.preventDefault();
    stepEditorHistory(event.inputType === 'historyRedo');
  }

  function syncModeButtons() {
    byId('source-mode').setAttribute('aria-pressed', String(mode === 'source'));
    byId('write-mode').setAttribute('aria-pressed', String(mode === 'write'));
    byId('visual-mode').setAttribute('aria-pressed', String(mode === 'visual'));
    blockLabelToggle.hidden = mode !== 'visual';
    blockLabelToggle.closest('.editor-outline').hidden = !desktop && mode !== 'visual';
  }

  function setMode(next) {
    if (mode === next) return;
    if (mode === 'source') cursor = source.selectionStart;
    else if (visual) updateVisualCursor();
    closeBlockMenu();
    if (noteMenuTarget instanceof HTMLTableCellElement) closeNoteMenu();
    finishBlock();
    mode = next;
    editorTyping = null;
    if (mode !== 'source') writingMode = mode;
    syncModeButtons();
    paper.hidden = mode === 'source';
    source.hidden = mode !== 'source';

    if (mode === 'source') {
      updateBodyFolds();
      updateTextSelectionBlocks();
      source.value = markdown;
      source.focus();
      source.setSelectionRange(cursor, cursor);
      source.scrollTop = (markdown.slice(0, cursor).split('\n').length - 1) * parseFloat(getComputedStyle(source).lineHeight);
    } else {
      render();
      const block = blockAt(cursor);
      revealVisualBlock(block.element);
      block.element?.scrollIntoView({ block: 'nearest' });
      if (mode === 'write') focusBlock(block, Math.max(0, cursor - block.start));
      else {
        let offset = null;
        if (visualReturn?.text === markdown && visualReturn.cursor === cursor) {
          offset = visualReturn.offset;
        } else if (block.element) {
          const position = cursor - block.start;
          const spans = visualTextSpans(block.element, markdown.slice(block.start, block.end));
          const span = spans.findLast(entry => entry.source <= position);
          offset = span ? span.visible + Math.min(position - span.source, span.length) : 0;
        }
        focusVisual(block.element ?? paper, cursor > block.start, offset);
      }
    }
  }

  function format(action) {
    if (action === 'heading') action = 'h2';
    if (mode === 'visual') {
      captureVisualCaret();
      formatVisual(action);
      return;
    }
    const wrappers = {
      bold: ['**', '**', '粗体'],
      italic: ['*', '*', '斜体'],
      link: ['[', '](https://)', '链接文字'],
      code: ['\x60', '\x60', '代码'],
    };
    if (mode === 'write' && !active) focusBlock(blockAt(cursor));
    const editor = mode === 'source' ? source : active.editor;
    let start = editor.selectionStart;
    let end = editor.selectionEnd;
    const hasSelection = start !== end;
    let inserted;
    let selectionStart;
    let selectionEnd;

    if (action in wrappers) {
      const [before, after, placeholder] = wrappers[action];
      const selected = editor.value.slice(start, end) || placeholder;
      inserted = before + selected + after;
      selectionStart = start + before.length;
      selectionEnd = selectionStart + selected.length;
      if (action === 'link' && hasSelection) {
        selectionStart = start + before.length + selected.length + 2;
        selectionEnd = selectionStart + 'https://'.length;
      }
    } else {
      const heading = /^h([0-6])$/.exec(action);
      const prefixes = { task: '- [ ] ', quote: '> ', ordered: '1. ', unordered: '- ' };
      const prefix = heading ? (heading[1] === '0' ? '' : '#'.repeat(Number(heading[1])) + ' ') : prefixes[action];
      if (prefix === undefined && action !== 'fence') return;
      const lineStart = start ? editor.value.lastIndexOf('\n', start - 1) + 1 : 0;
      const lineEnd = editor.value.indexOf('\n', end);
      const lines = editor.value.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
      const oldPrefix = heading ? lines.match(/^ {0,3}#{1,6}[ \t]+/)?.[0].length ?? 0 : 0;
      const preceding = action === 'fence' ? '~~~\n' : prefix;
      inserted = action === 'fence' ? preceding + lines + '\n~~~' :
        lines.split('\n').map(line => prefix + (heading ? line.replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '') : line)).join('\n');
      selectionStart = lineStart + preceding.length + (hasSelection ? 0 : Math.max(0, start - lineStart - oldPrefix));
      selectionEnd = hasSelection ? lineStart + inserted.length : selectionStart;
      start = lineStart;
      end = lineStart + lines.length;
    }

    editor.focus();
    editor.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, inserted)) {
      editor.setRangeText(inserted, start, end);
      recordInput(editor);
    }
    editor.setSelectionRange(selectionStart, selectionEnd);
  }

  function formatVisual(action) {
    if (!visual) return;
    const { editor } = visual;
    if (!editor.isContentEditable) return;
    editor.focus({ preventScroll: true });
    const selection = getSelection();
    if (!editor.contains(selection.anchorNode)) return;
    if (blockFormats.some(([format]) => format === action)) {
      const selected = selectedVisualBlocks();
      if (selected.length > 1) {
        applyBatchFormat(batchEditableBlocks(selected), action);
        return;
      }
    }
    if (selection.rangeCount && revealFoldedSelection(selection.getRangeAt(0))) return;
    const commands = { bold: 'bold', italic: 'italic', ordered: 'insertOrderedList', unordered: 'insertUnorderedList' };
    const blocks = { h0: 'p', quote: 'blockquote', fence: 'pre' };
    if (/^h[1-6]$/.test(action) || action in blocks) {
      document.execCommand('formatBlock', false, blocks[action] ?? action);
    } else if (action in commands) {
      document.execCommand(commands[action]);
    } else if (action === 'task') {
      let item = selection.anchorNode.parentElement?.closest('li');
      if (!item) {
        document.execCommand('insertUnorderedList');
        item = selection.anchorNode.parentElement?.closest('li');
      }
      if (item?.querySelector(':scope > input[type=checkbox]')) {
        item.querySelector(':scope > input[type=checkbox]').remove();
      } else if (item) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.disabled = true;
        item.prepend(checkbox);
      }
    } else if (action === 'link' || action === 'code') {
      const element = document.createElement(action === 'code' ? 'code' : 'a');
      if (action === 'link') {
        const node = selection.anchorNode;
        const old = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('a[href]');
        const address = window.prompt('链接地址', old?.getAttribute('href') ?? 'https://')?.trim?.();
        if (!address) return;
        try {
          if (!['https:', 'http:', 'mailto:'].includes(new URL(address, location.href).protocol)) return;
        } catch {
          return;
        }
        element.setAttribute('href', address);
        if (old && selection.isCollapsed) {
          old.setAttribute('href', address);
          recordVisualInput();
          return;
        }
        element.textContent = selection.toString() || address;
      } else {
        element.textContent = selection.toString() || '代码';
      }
      document.execCommand('insertHTML', false, element.outerHTML);
    }
    recordVisualInput();
  }

  function canReplace() {
    return markdown === savedText || window.confirm('当前文档仍有更改，确定要切换文档吗？');
  }

  async function switchDesktopDocument(openNext, onError = setStatus) {
    if (busy || fileDialogOpen()) return false;
    busy = main.inert = true;
    try {
      finishBlock();
      let savedName;
      if (markdown !== savedText) {
        if (!await saveCurrentDocument(true)) return false;
        savedName = filename;
        setStatus('已自动保存 ' + savedName);
      }
      await openNext(savedName);
      return true;
    } catch (error) {
      onError(error.message);
      return false;
    } finally {
      busy = main.inert = false;
    }
  }

  function replaceDocument(text, name, newHandle = null, bom = false, token = null) {
    active = null;
    visual = null;
    visualFolds.clear();
    visualReturn = null;
    outlineOverrides.clear();
    outlineSmartActive = false;
    lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
    hasBom = bom;
    markdown = text.replace(/\r\n?/g, '\n');
    savedText = markdown;
    const tokens = marked.lexer(markdown);
    notesTree.querySelector('[aria-current]')?.removeAttribute('aria-current');
    filename = name;
    handle = newHandle;
    desktopToken = token;
    cursor = 0;
    source.value = markdown;
    source.setSelectionRange(0, 0);
    render(tokens);
    resetEditorHistory();
    viewport.scrollTop = 0;
    source.scrollTop = 0;
    updateDocumentLabel();
    updateCount();
    persist();
  }

  async function useFile(file, newHandle) {
    const buffer = await file.arrayBuffer();
    const firstBytes = new Uint8Array(buffer, 0, Math.min(3, buffer.byteLength));
    const bom = firstBytes[0] === 0xef && firstBytes[1] === 0xbb && firstBytes[2] === 0xbf;
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    replaceDocument(content, file.name, newHandle, bom);
    setStatus('已打开 ' + filename);
  }

  function desktopRequest(request, files, onPullProgress) {
    return new Promise((resolve, reject) => {
      function receive(event) {
        if (event.data.pullProgress) {
          onPullProgress?.(event.data.pullProgress);
          return;
        }
        desktop.removeEventListener('message', receive);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data);
      }
      desktop.addEventListener('message', receive);
      try {
        if (files) desktop.postMessageWithAdditionalObjects(request, files);
        else desktop.postMessage(request);
      } catch (error) {
        desktop.removeEventListener('message', receive);
        reject(error);
      }
    });
  }

  async function restoreDesktopNote() {
    if (!desktop || typeof restored?.savedText !== 'string') return;
    busy = true;
    try {
      const contents = (hasBom ? '\uFEFF' : '') + savedText.replace(/\n/g, lineEnding);
      const restoredNote = await desktopRequest({ action: 'restore-note', name: filename, contents, dirty: markdown !== savedText });
      if (typeof restoredNote.contents === 'string') {
        showOpenedDocument(restoredNote);
        initialSavedTokens = marked.lexer(markdown);
        setStatus('已载入原文件的最新版本');
      } else {
        desktopToken = restoredNote.token ?? null;
        if (restoredNote.diskChanged) setStatus('已恢复草稿，原文件也有修改');
      }
    } catch {
      // The draft remains editable if its source file is unavailable.
    } finally {
      busy = false;
    }
  }

  function showOpenedDocument(opened, savedName) {
    const bom = opened.contents.startsWith('\uFEFF');
    replaceDocument(bom ? opened.contents.slice(1) : opened.contents, opened.name, null, bom, opened.token);
    setStatus(savedName ? `已自动保存 ${savedName}，已打开 ${filename}` : '已打开 ' + filename);
  }

  function jumpToNoteAnchor(fragment) {
    if (!fragment) return;
    let id;
    try { id = decodeURIComponent(fragment); }
    catch { id = fragment; }
    finishBlock();
    const headings = [...paper.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')];
    const target = headings.find(node => node.id === id) ?? headings.find(node => node.id === outlineSlug(id));
    if (!target) {
      setStatus(`已打开 ${filename}，找不到链接中的标题。`);
      return;
    }
    revealVisualBlock(target);
    target.scrollIntoView({ block: 'start' });
  }

  async function openLinkedNote(path, fragment) {
    if (!desktopToken) {
      setStatus('请先打开或保存这篇笔记。');
      return;
    }
    await switchDesktopDocument(async savedName => {
      const opened = await desktopRequest({ action: 'open-linked-note', token: desktopToken, notePath: path });
      showOpenedDocument(opened, savedName);
      if (opened.notePath) {
        const note = [...notesTree.querySelectorAll('button[data-note-path]')]
          .find(row => row.dataset.notePath.toLowerCase() === opened.notePath.toLowerCase());
        if (note) {
          note.setAttribute('aria-current', 'true');
          selectRepositoryFolder(note.closest('details')?.dataset.path ?? '');
        }
      }
      jumpToNoteAnchor(fragment);
    });
  }

  const repositoryPanel = byId('repository-panel');
  const outlinePanel = byId('outline-panel');
  const repositoryView = byId('repository-view');
  const outlineView = byId('outline-view');
  const editorOutlineToggle = byId('editor-outline-toggle');
  const editorOutlineSlot = byId('editor-outline-slot');
  const sidebarMedia = matchMedia('(max-width: 680px)');

  function showSidebarView(repository) {
    if (!repository && !editorOutlineSlot.hidden) setEditorOutline(false);
    repositoryPanel.hidden = !repository;
    outlinePanel.hidden = repository && editorOutlineSlot.hidden;
    repositoryView.setAttribute('aria-pressed', String(repository));
    outlineView.setAttribute('aria-pressed', String(!repository));
  }
  function setEditorOutline(visible) {
    editorOutlineSlot.hidden = !visible;
    editorOutlineToggle.setAttribute('aria-expanded', String(visible));
    if (visible) {
      editorOutlineSlot.append(outlinePanel);
      showSidebarView(true);
    } else {
      sidebar.insertBefore(outlinePanel, byId('theme'));
      outlinePanel.hidden = !repositoryPanel.hidden;
    }
  }
  const notesStatus = byId('notes-status');
  const notesTree = byId('notes-tree');
  const notesChoose = byId('notes-choose');
  const repositoryHeader = repositoryPanel.querySelector('.repository-header');
  const repositoryRoot = byId('notes-root');
  const notesOverview = byId('notes-overview');
  const notesCreate = byId('notes-create');
  const notesCreateName = byId('notes-create-name');
  let activeFolder = '';
  let pendingEntry = null;
  const noteMenu = byId('note-menu');
  const noteIconDialog = byId('note-icon-dialog');
  const noteIcons = new Map([
    ['📌', '重点'], ['⭐', '常用'], ['💡', '提示'], ['⚠️', '注意'], ['✅', '已完成'], ['📋', '待办'],
    ['📁', '分类'], ['📘', '教程'], ['🧩', '开发'], ['💻', '编程'], ['🔧', '工具'], ['⚡', '硬件'],
    ['🤖', '机器人'], ['🧪', '科研'], ['📐', '工程'], ['📊', '数据'], ['🌐', '网络'], ['💬', '语言'],
    ['🌍', '世界'], ['⚖️', '法律'], ['📝', '随记'], ['📎', '参考资料'], ['📥', '待整理'], ['📦', '归档'],
  ]);
  let noteMenuTarget = null;
  let noteClipboard = null;
  const selectedNotePaths = new Set();
  let draggedEntry = null;
  let highlightedFolder = null;

  function fileDialogOpen() {
    return renameDialog.open || commitDialog.open || searchDialog.open || syncDialog.open || displayDialog.open ||
      moveSectionDialog.open || sectionEditDialog.open || noteIconDialog.open || blockLinkDialog.open;
  }

  const searchDialog = byId('note-search');
  const searchQuery = byId('note-search-query');
  const searchStatus = byId('note-search-status');
  const searchResults = byId('note-search-results');
  let searchTimer;
  let lastSearch = null;

  function showNoteSearch() {
    if (busy || fileDialogOpen()) return;
    if (repositoryRoot.hidden) {
      setStatus('请先选择笔记仓库。');
      return;
    }
    lastSearch = null;
    searchDialog.showModal();
    searchQuery.focus();
    searchQuery.select();
    scheduleNoteSearch();
  }

  function scheduleNoteSearch() {
    clearTimeout(searchTimer);
    if (!searchDialog.open || busy) return;
    const query = searchQuery.value.trim();
    if (query === lastSearch) return;
    searchResults.replaceChildren();
    searchStatus.textContent = query ? '正在搜索…' : '输入关键词搜索当前笔记仓库。';
    if (!query) {
      lastSearch = null;
      return;
    }
    searchTimer = setTimeout(() => runNoteSearch(query), 160);
  }

  async function runNoteSearch(query) {
    if (!searchDialog.open || busy) return;
    busy = true;
    lastSearch = query;
    try {
      const { searchResults: results, searchTruncated, skippedCount } =
        await desktopRequest({ action: 'search-notes', query });
      if (!searchDialog.open || searchQuery.value.trim() !== query) return;
      searchStatus.textContent = (results.length ? '显示 ' + results.length + ' 条结果' : '没有匹配的笔记') +
        (searchTruncated ? '，可缩小搜索范围' : '') + (skippedCount ? '，跳过 ' + skippedCount + ' 个无法读取的项目' : '') + '。';
      for (const hit of results) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        for (const text of [hit.path, hit.heading, hit.preview]) {
          if (!text) continue;
          const line = document.createElement('span');
          line.textContent = text;
          button.append(line);
        }
        button.addEventListener('click', () => openNoteHit(hit, query));
        item.append(button);
        searchResults.append(item);
      }
    } catch (error) {
      searchStatus.textContent = error.message;
    } finally {
      busy = false;
      scheduleNoteSearch();
    }
  }

  async function openNoteHit(hit, query) {
    if (busy || searchQuery.value.trim() !== query) return;
    searchDialog.close();
    await switchDesktopDocument(async savedName => {
      const opened = await desktopRequest({ action: 'open-note', notePath: hit.path });
      showOpenedDocument(opened, savedName);
      const note = [...notesTree.querySelectorAll('button[data-note-path]')].find(row => row.dataset.notePath === hit.path);
      note?.setAttribute('aria-current', 'true');
      selectRepositoryFolder(note?.closest('details')?.dataset.path ?? '');
      if (hit.line == null) return;
      const lines = markdown.split('\n');
      const start = lines[hit.line]?.indexOf(hit.match) ?? -1;
      if (start < 0) {
        setStatus('笔记在搜索后已更改，请重新搜索定位。');
        return;
      }
      cursor = start + hit.line + lines.slice(0, hit.line).reduce((length, line) => length + line.length, 0);
      requestAnimationFrame(() => {
        if (desktopToken !== opened.token) return;
        if (mode === 'source') {
          source.focus();
          source.setSelectionRange(cursor, cursor + hit.match.length);
          source.scrollTop = hit.line * parseFloat(getComputedStyle(source).lineHeight);
        } else {
          const target = blockAt(cursor)?.element;
          target?.scrollIntoView({ block: 'center' });
          target?.focus({ preventScroll: true });
        }
      });
    });
  }

  function setNotesStatus(text) {
    notesStatus.textContent = text;
    notesStatus.hidden = !text;
  }

  const syncDialog = byId('repository-sync');
  const syncContent = byId('repository-sync-content');
  const syncFolder = byId('repository-sync-folder');
  const syncChoose = byId('repository-sync-choose');
  const syncUnbind = byId('repository-sync-unbind');
  const syncStatus = byId('repository-sync-status');
  const setupGitButton = byId('repository-setup-git');
  const syncUrl = byId('repository-sync-url');
  const syncBind = byId('repository-sync-bind');
  const syncClone = byId('repository-sync-clone');
  const syncRefresh = byId('repository-sync-refresh');
  const localModeButton = byId('repository-mode-local');
  const directModeButton = byId('repository-mode-direct');
  const localSyncPanel = byId('repository-local');
  const directSyncPanel = byId('repository-direct');
  const syncDesktop = byId('repository-sync-desktop');
  const syncExplorer = byId('repository-sync-explorer');
  const syncPull = byId('repository-sync-pull');
  const syncPush = byId('repository-sync-push');
  const pullProgress = byId('repository-pull-progress');
  const pullCancel = byId('repository-pull-cancel');
  const pullTime = byId('repository-pull-time');
  const partialForm = byId('repository-partial-form');
  const partialUrl = byId('repository-partial-url');
  const partialPath = byId('repository-partial-path');
  const partialChoose = byId('repository-partial-choose');
  const partialPull = byId('repository-partial-pull');
  let pullState = null;
  const repositoryModeKey = 'scripta.repository-sync-mode';
  let directSyncMode = readStorage(repositoryModeKey) === 'direct';

  function renderRepositorySync(state) {
    syncFolder.textContent = state.folder ? `当前本地文件夹：${state.folder}` : '尚未绑定本地笔记文件夹';
    syncFolder.title = state.folder || '';
    syncUrl.value = state.gitHub || '';
    if (!partialUrl.value && state.gitHub) partialUrl.value = state.gitHub;
    syncBind.disabled = !state.folder;
    syncDesktop.disabled = !state.isGit;
    syncExplorer.disabled = syncRefresh.disabled = syncUnbind.disabled = !state.folder;
    syncPull.disabled = syncPush.disabled = !state.gitHub;
    if (!directSyncMode) {
      syncStatus.textContent = '';
      return;
    }
    syncStatus.textContent = state.gitHub
      ? '直接拉取会更新上方的本地文件夹。推送会上传当前分支中已提交的内容。'
      : '可以新建同名子文件夹并绑定，或下载已有 GitHub 仓库。';
  }

  function readRepositoryMode() {
    return runRepositorySync(directSyncMode ? 'repository-sync' : 'repository-local');
  }

  function showRepositoryMode() {
    localModeButton.setAttribute('aria-pressed', String(!directSyncMode));
    directModeButton.setAttribute('aria-pressed', String(directSyncMode));
    localSyncPanel.hidden = directSyncMode;
    directSyncPanel.hidden = !directSyncMode;
    syncContent.scrollTop = 0;
    pullProgress.hidden = true;
    syncStatus.textContent = '';
  }

  function switchRepositoryMode(direct) {
    if (busy || pullState || direct === directSyncMode) return;
    directSyncMode = direct;
    writeStorage(repositoryModeKey, direct ? 'direct' : 'local');
    showRepositoryMode();
    void readRepositoryMode();
  }

  async function showRepositorySync() {
    if (pullState && !syncDialog.open) {
      syncDialog.showModal();
      return;
    }
    if (busy || fileDialogOpen()) return;
    closeNoteMenu();
    showRepositoryMode();
    renderRepositorySync({});
    syncDialog.showModal();
    await readRepositoryMode();
  }

  async function runRepositorySync(action, query) {
    if (busy) return;
    busy = true;
    try {
      if (action === 'repository-sync') {
        const { sync } = await desktopRequest({ action: 'repository-local' });
        renderRepositorySync(sync);
        syncBind.disabled = true;
      }
      const { sync, syncMessage } = await desktopRequest({ action, query });
      if (sync) renderRepositorySync(sync);
      if (syncMessage) {
        busy = false;
        const notice = await refreshRepository(true);
        syncStatus.textContent = notice ? syncMessage + ' ' + notice : syncMessage;
      }
      if (action === 'open-github-desktop') syncDialog.close();
    } catch (error) {
      syncStatus.textContent = error.message;
    } finally {
      busy = false;
    }
  }

  async function setupGit() {
    if (busy) return;
    busy = setupGitButton.disabled = true;
    syncStatus.textContent = '正在检查 Git，缺失时会通过 WinGet 下载安装…';
    let notice = '';
    try {
      const { syncMessage } = await desktopRequest({ action: 'setup-git' });
      notice = syncMessage;
      const { sync } = await desktopRequest({ action: 'repository-sync' });
      const repositoryAddress = syncUrl.value;
      renderRepositorySync(sync);
      if (repositoryAddress) syncUrl.value = repositoryAddress;
      syncStatus.textContent = notice;
    } catch (error) {
      syncStatus.textContent = notice ? notice + ' ' + error.message : error.message;
    } finally {
      busy = setupGitButton.disabled = false;
      if (!syncDialog.open) setStatus(syncStatus.textContent);
    }
  }

  function updatePullTime() {
    const now = performance.now();
    const elapsed = Math.floor((now - pullState.startedAt) / 1000);
    const waiting = Math.floor((now - pullState.updatedAt) / 1000);
    pullTime.textContent = `已用时 ${elapsed} 秒` + (waiting >= 10 ? ` · ${waiting} 秒未收到新的进度` : '');
  }

  function showPullProgress({ stage, percent, canCancel = true }) {
    if (pullState.cancelling && canCancel) return;
    pullState.updatedAt = performance.now();
    pullCancel.disabled = !canCancel;
    syncStatus.textContent = percent == null ? stage : `${stage} ${percent}%`;
    if (percent == null) pullProgress.removeAttribute('value');
    else pullProgress.value = percent;
    updatePullTime();
    if (!syncDialog.open) setStatus(syncStatus.textContent);
  }

  function cancelRepositoryPull() {
    if (!pullState || pullCancel.disabled) return;
    desktop.postMessage({ action: 'cancel-pull' });
    showPullProgress({ stage: '正在中断拉取，等待 Git 退出…', canCancel: false });
    pullState.cancelling = true;
  }

  function closeRepositorySync() {
    syncDialog.close();
    if (pullState) {
      cancelRepositoryPull();
      setStatus(syncStatus.textContent);
    }
  }

  async function choosePartialFolder() {
    if (busy) return;
    busy = true;
    try {
      const { partialFolder, partialSelection } = await desktopRequest({ action: 'choose-partial-folder' });
      if (partialFolder) {
        byId('repository-partial-folder').textContent = partialFolder;
        partialPull.disabled = false;
        partialPull.textContent = '拉取选定内容';
        if (partialSelection) {
          partialUrl.value = partialSelection.url;
          partialPath.value = partialSelection.path;
          partialPull.textContent = '继续拉取';
        }
      }
    } catch (error) {
      syncStatus.textContent = error.message;
    } finally {
      busy = false;
    }
  }

  async function transferRepository(action, fields = {}) {
    if (busy) return;
    busy = true;
    const original = syncStatus.textContent;
    const pulling = action !== 'push-github';
    const partial = action === 'pull-github-partial';
    const cloning = action === 'clone-github';
    const pullButton = cloning ? syncClone : partial ? partialPull : syncPull;
    const pullLabel = cloning ? '首次下载并绑定' : partial ? '拉取选定内容' : '直接拉取更新';
    const { disabled: originalDisabled } = syncPull;
    const partialDisabled = partialPull.disabled;
    let currentSync;
    pullProgress.hidden = !pulling;
    let timer;
    if (pulling) {
      pullState = { startedAt: performance.now(), cancelling: false };
      syncPull.disabled = syncPush.disabled = partialPull.disabled = true;
      byId('repository-sync-form').inert = true;
      partialUrl.disabled = partialPath.disabled = partialChoose.disabled = true;
      pullCancel.hidden = pullTime.hidden = false;
      showPullProgress(cloning
        ? { stage: '正在准备首次下载…', canCancel: false }
        : { stage: '正在检查仓库和分支…' });
      timer = setInterval(updatePullTime, 1000);
    } else syncStatus.textContent = '正在推送…';
    try {
      const { sync, syncMessage, pullInterrupted } = await desktopRequest({ action, ...fields }, undefined, pulling ? showPullProgress : undefined);
      currentSync = sync;
      if (pullInterrupted) {
        if (!cloning) pullButton.textContent = '继续拉取';
        pullProgress.hidden = true;
        syncStatus.textContent = syncMessage;
        return;
      }
      if (pulling) pullButton.textContent = pullLabel;
      if (!pulling || partial || !syncMessage) {
        syncStatus.textContent = syncMessage || original;
        if (partial && syncMessage) pullProgress.value = 100;
        else if (!syncMessage) pullProgress.hidden = true;
        return;
      }
      showPullProgress({ stage: '正在刷新笔记…', canCancel: false });
      busy = false;
      const notice = await refreshRepository(true);
      syncStatus.textContent = notice ? syncMessage + ' ' + notice : syncMessage;
      pullProgress.value = 100;
    } catch (error) {
      pullProgress.hidden = true;
      syncStatus.textContent = error.message;
    } finally {
      if (pulling) {
        clearInterval(timer);
        pullState = null;
        pullCancel.hidden = pullTime.hidden = true;
        syncPull.disabled = syncPush.disabled = originalDisabled;
        partialPull.disabled = partialDisabled;
        partialUrl.disabled = partialPath.disabled = partialChoose.disabled = false;
        byId('repository-sync-form').inert = false;
        if (currentSync) {
          const notice = syncStatus.textContent;
          renderRepositorySync(currentSync);
          syncStatus.textContent = notice;
        }
        if (!syncDialog.open) setStatus(syncStatus.textContent);
      }
      busy = false;
    }
  }

  async function refreshRepository(fromSync = false) {
    if (busy || (fileDialogOpen() && fromSync !== true)) return;
    if (await loadNotes('list-notes') === false) return notesStatus.textContent;
    if (busy || (fileDialogOpen() && fromSync !== true) || !desktopToken) return;
    busy = main.inert = true;
    try {
      finishBlock();
      const opened = await desktopRequest({ action: 'refresh-synced-note', token: desktopToken, dirty: markdown !== savedText });
      if (opened.name) {
        const current = notesTree.querySelector('[aria-current]');
        showOpenedDocument(opened);
        current?.setAttribute('aria-current', 'true');
        setStatus('已从磁盘刷新 ' + filename);
      } else if (opened.diskChanged) {
        const notice = '磁盘版本已更新，当前草稿已保留。';
        setStatus(notice);
        return notice;
      }
    } catch (error) {
      setStatus(error.message);
      return error.message;
    } finally {
      busy = main.inert = false;
    }
  }

  const repositorySizeFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
  const repositoryCountFormat = new Intl.NumberFormat('zh-CN');

  function formatRepositorySize(bytes) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let unit = 0;
    while (bytes >= 1024 && unit < units.length - 1) {
      bytes /= 1024;
      unit++;
    }
    return repositorySizeFormat.format(bytes) + ' ' + units[unit];
  }

  function noteIconKey(repository) {
    return 'scripta.note-icons:' + repository.toLowerCase();
  }

  function readNoteIcons(repository) {
    try {
      const saved = JSON.parse(readStorage(noteIconKey(repository)));
      return new Map(Object.entries(saved ?? {}).filter(([, icon]) => noteIcons.has(icon)));
    } catch {
      return new Map();
    }
  }

  function writeNoteIcons(repository, icons) {
    return writeStorage(noteIconKey(repository), JSON.stringify(Object.fromEntries(icons)));
  }

  function renderNoteIcon(row, icon) {
    const previous = row.querySelector(':scope > .note-tree-icon');
    if (!icon) {
      previous?.remove();
      return;
    }
    const badge = previous ?? document.createElement('span');
    badge.className = 'note-tree-icon';
    badge.dataset.icon = icon;
    badge.setAttribute('aria-hidden', 'true');
    if (!previous) row.prepend(badge);
  }

  function showNoteIconPicker(row, path, folder) {
    const repository = repositoryRoot.title;
    const icons = readNoteIcons(repository);
    const current = icons.get(path);
    const status = byId('note-icon-status');
    const remove = byId('note-icon-remove');
    byId('note-icon-name').textContent = folder ? row.querySelector('.note-folder-name').textContent : row.textContent;
    status.hidden = true;
    remove.disabled = !current;

    function choose(icon) {
      if (icon) icons.set(path, icon);
      else icons.delete(path);
      if (!writeNoteIcons(repository, icons)) {
        status.textContent = '无法保存图标设置。';
        status.hidden = false;
        return;
      }
      renderNoteIcon(row, icon);
      noteIconDialog.close();
    }

    remove.onclick = () => choose(null);
    const choices = [...noteIcons].map(([icon, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = icon;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(icon === current));
      button.addEventListener('click', () => choose(icon));
      return button;
    });
    byId('note-icon-options').replaceChildren(...choices);
    noteIconDialog.showModal();
    (choices.find(button => button.getAttribute('aria-pressed') === 'true') ?? choices[0]).focus();
  }

  function noteList(entries, expanded, largestFolder, icons) {
    const list = document.createElement('ul');
    for (const entry of entries) {
      const item = document.createElement('li');
      if (entry.children) {
        const folder = document.createElement('details');
        folder.dataset.path = entry.path;
        if (entry.resource) folder.dataset.resourceFolder = '';
        folder.open = expanded.has(entry.path);
        const label = document.createElement('summary');
        label.draggable = true;
        const name = document.createElement('span');
        name.className = 'note-folder-name';
        name.textContent = entry.name;
        label.append(name);
        renderNoteIcon(label, icons.get(entry.path));
        label.title = entry.name;
        if (entry.sizeBytes != null && entry.fileCount != null) {
          const size = formatRepositorySize(entry.sizeBytes);
          const count = repositoryCountFormat.format(entry.fileCount);
          const bar = document.createElement('span');
          bar.className = 'note-folder-size';
          bar.setAttribute('aria-hidden', 'true');
          bar.style.setProperty('--folder-size', (largestFolder ? 100 * entry.sizeBytes / largestFolder : 0) + '%');
          const badge = document.createElement('span');
          badge.className = 'note-folder-count';
          badge.textContent = count;
          badge.setAttribute('aria-hidden', 'true');
          label.title = `${entry.name} · ${size} · ${count} 个可浏览文件`;
          label.setAttribute('aria-label', label.title);
          label.append(bar, badge);
        }
        folder.append(label);
        if (entry.children.length) folder.append(noteList(entry.children, expanded, largestFolder, icons));
        else {
          const empty = document.createElement('p');
          empty.className = 'notes-empty';
          empty.textContent = entry.resource ? '暂无资料' : '暂无 Markdown 笔记';
          folder.append(empty);
        }
        item.append(folder);
      } else {
        const note = document.createElement('button');
        note.type = 'button';
        note.textContent = entry.name;
        renderNoteIcon(note, icons.get(entry.path));
        if (entry.resource) {
          note.title = '在资源管理器中定位 ' + entry.name;
          note.addEventListener('click', () => runNoteMenuAction('reveal-resource', note, entry.path, false));
        } else {
          note.draggable = true;
          note.dataset.notePath = entry.path;
          note.title = entry.name;
        }
        item.append(note);
      }
      list.append(item);
    }
    return list;
  }

  function readMergeRecords(repository) {
    try {
      const records = JSON.parse(readStorage('scripta.merge-originals:' + repository));
      return Array.isArray(records) ? records.filter(record => typeof record?.destination === 'string' &&
        Array.isArray(record.originals) && record.originals.every(original =>
          typeof original?.path === 'string' && typeof original.fingerprint === 'string')) : [];
    } catch {
      return [];
    }
  }

  function writeMergeRecords(repository, records) {
    return writeStorage('scripta.merge-originals:' + repository, JSON.stringify(records));
  }

  function markMergedNotes(repository) {
    const rows = new Map([...notesTree.querySelectorAll('button[data-note-path]')]
      .map(row => [row.dataset.notePath, row]));
    for (const record of readMergeRecords(repository)) {
      const { destination } = record;
      const result = rows.get(destination);
      if (!result) continue;
      const originals = record.originals.filter(original => original.path !== destination && rows.has(original.path));
      if (!originals.length) continue;
      for (const { path } of originals) {
        const row = rows.get(path);
        row.classList.add('merged-original');
        row.title = row.textContent + '（已合并）';
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'delete-merge-originals';
      button.textContent = '删除原稿';
      button.title = '将「' + result.textContent + '」的原稿移到回收站';
      button.addEventListener('click', event => {
        event.stopPropagation();
        void deleteRepositoryNote(originals.map(original => original.path), false, false, { destination, originals });
      });
      result.parentElement.classList.add('merge-result');
      result.after(button);
    }
  }

  async function loadNotes(action, movedEntry, destinationFolder, selectedNote) {
    if (busy) return;
    closeNoteMenu();
    closeRepositoryCreation();
    busy = true;
    const rootLabel = byId('notes-root');
    const moves = Array.isArray(movedEntry) ? movedEntry : movedEntry ? [movedEntry] : [];
    const updatedPath = path => {
      const move = path && moves.find(({ from }) => path === from || path.startsWith(from + '\\'));
      return move ? move.to + path.slice(move.from.length) : path;
    };
    const expanded = new Set([...notesTree.querySelectorAll('details[open]')].map(folder => updatedPath(folder.dataset.path)));
    for (let path = destinationFolder; path; path = path.slice(0, Math.max(0, path.lastIndexOf('\\'))))
      expanded.add(path);
    const previousRepository = rootLabel.title;
    const selected = selectedNote ?? updatedPath(notesTree.querySelector('[aria-current="true"]')?.dataset.notePath);
    notesOverview.hidden = true;
    byId('notes-tools').hidden = true;
    rootLabel.hidden = notesChoose.hidden = true;
    setNotesStatus('正在读取笔记仓库…');
    try {
      const { repository, notes, repositorySizeBytes, repositoryFileCount } = await desktopRequest({ action });
      if (repository !== previousRepository) {
        noteClipboard = null;
        selectedNotePaths.clear();
      } else if (noteClipboard) {
        for (const entry of noteClipboard.entries) entry.path = updatedPath(entry.path);
      }
      if (repository) {
        rootLabel.textContent = repository.split(/[\\/]/).filter(Boolean).at(-1) || repository;
        rootLabel.title = repository;
        rootLabel.hidden = false;
        byId('notes-tools').hidden = false;
        if (repositorySizeBytes != null && repositoryFileCount != null) {
          notesOverview.textContent = `${formatRepositorySize(repositorySizeBytes)} · ${repositoryCountFormat.format(repositoryFileCount)} 个可浏览文件`;
          notesOverview.title = '容量包含图床和资料。条形以最大的一级文件夹为基准，折叠数字统计目录树中的笔记和资料文件。';
          notesOverview.hidden = false;
        }
        const largestFolder = notes.reduce((largest, entry) => entry.children ? Math.max(largest, entry.sizeBytes ?? 0) : largest, 0);
        let icons = readNoteIcons(repository);
        if (repository === previousRepository && moves.length && icons.size) {
          icons = new Map([...icons].map(([path, icon]) => [updatedPath(path), icon]));
          if (!writeNoteIcons(repository, icons)) setStatus('移动后的图标设置无法保存。');
        }
        notesTree.replaceChildren(noteList(notes, repository === previousRepository ? expanded : new Set(), largestFolder, icons));
        if (repository === previousRepository && moves.length) {
          const records = readMergeRecords(repository);
          if (records.length) writeMergeRecords(repository, records.map(record => ({
            destination: updatedPath(record.destination),
            originals: record.originals.map(original => ({ ...original, path: updatedPath(original.path) })),
          })));
        }
        markMergedNotes(repository);
        const available = new Set([...notesTree.querySelectorAll('button[data-note-path]')].map(row => row.dataset.notePath));
        const retained = [...selectedNotePaths].map(updatedPath).filter(path => available.has(path));
        selectedNotePaths.clear();
        for (const path of retained) selectedNotePaths.add(path);
        updateNoteSelection();
        const folderPath = repository === previousRepository ? updatedPath(activeFolder) : '';
        selectRepositoryFolder(folderPath);
        if (repository === previousRepository || selectedNote) {
          const current = [...notesTree.querySelectorAll('button')].find(note => note.dataset.notePath === selected);
          current?.setAttribute('aria-current', 'true');
        }
        notesTree.hidden = !notes.length;
        if (movedEntry?.to) {
          const folder = [...notesTree.querySelectorAll('details')].find(entry => entry.dataset.path === movedEntry.to);
          const movedNote = [...notesTree.querySelectorAll('button[data-note-path]')].find(note => note.dataset.notePath === movedEntry.to);
          (folder?.querySelector('summary') ?? movedNote)?.focus({ preventScroll: true });
        }
        setNotesStatus(notes.length ? '' : '暂无笔记文件夹');
      } else {
        rootLabel.title = '';
        notesTree.replaceChildren();
        notesTree.hidden = true;
        selectRepositoryFolder('');
        setNotesStatus('尚未绑定笔记文件夹。');
        notesChoose.hidden = false;
      }
    } catch (error) {
      setNotesStatus(error.message);
      notesChoose.hidden = false;
      return false;
    } finally {
      busy = false;
    }
  }

  function selectRepositoryFolder(path) {
    const folders = [...notesTree.querySelectorAll('details[data-path]')];
    const target = folders.find(folder => folder.dataset.path === path);
    activeFolder = target?.dataset.path ?? '';
    for (const folder of folders) folder.classList.toggle('creation-folder', folder === target);
  }

  function updateNoteSelection() {
    for (const row of notesTree.querySelectorAll('button[data-note-path]')) {
      if (selectedNotePaths.size) row.setAttribute('aria-pressed', String(selectedNotePaths.has(row.dataset.notePath)));
      else row.removeAttribute('aria-pressed');
    }
  }

  function clearNoteSelection() {
    if (!selectedNotePaths.size) return;
    selectedNotePaths.clear();
    updateNoteSelection();
  }

  function closeRepositoryCreation() {
    pendingEntry = null;
    notesCreate.hidden = true;
  }

  function showRepositoryCreation(folder) {
    if (busy || fileDialogOpen() || repositoryRoot.hidden) return;
    pendingEntry = { folder, path: activeFolder };
    const destination = activeFolder.split('\\').at(-1) || repositoryRoot.textContent;
    byId('notes-create-label').textContent = (folder ? '新建文件夹' : '新建 Markdown') + ' · ' + destination;
    notesCreateName.value = '';
    notesCreateName.placeholder = folder ? '文件夹名称' : '笔记名称';
    notesCreate.hidden = false;
    setNotesStatus('');
    notesCreateName.focus();
  }

  async function createRepositoryEntry(event) {
    event.preventDefault();
    const entry = pendingEntry;
    const name = notesCreateName.value.trim();
    if (!entry || !name || busy || fileDialogOpen()) return;
    let created;
    const request = { action: 'create-note-entry', notePath: entry.path, name, folder: entry.folder };
    if (entry.folder) {
      busy = true;
      try {
        created = await desktopRequest(request);
      } catch (error) {
        setNotesStatus(error.message);
      } finally {
        busy = false;
      }
    } else {
      await switchDesktopDocument(async savedName => {
        created = await desktopRequest(request);
        showOpenedDocument(created, savedName);
      }, setNotesStatus);
    }
    if (!created?.notePath) return;
    closeRepositoryCreation();
    await loadNotes('list-notes', null, entry.path, entry.folder ? undefined : created.notePath);
    selectRepositoryFolder(entry.folder ? created.notePath : entry.path);
    setStatus('已新建 ' + created.name);
  }

  function startNoteDrag(event) {
    const row = event.target.closest('summary, button[data-note-path]');
    if (!row || busy || fileDialogOpen()) {
      event.preventDefault();
      return;
    }
    const folder = row.matches('summary');
    const path = folder ? row.parentElement.dataset.path : row.dataset.notePath;
    draggedEntry = { path, folder };
    event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData('application/x-scripta-note', path);
    closeNoteMenu();
  }

  function noteDropTarget(target) {
    if (!draggedEntry || busy || fileDialogOpen()) return null;
    const row = target.closest('summary, button[data-note-path], .repository-header');
    if (!row && target !== repositoryPanel) return null;
    const parentFolder = row?.closest('details');
    const path = parentFolder?.dataset.path ?? '';
    if (!path && (byId('notes-root').hidden || (row && row !== repositoryHeader))) return null;
    const source = draggedEntry.path;
    if (source.slice(0, Math.max(0, source.lastIndexOf('\\'))) === path ||
        source === path || path.startsWith(source + '\\')) return null;
    return { row: parentFolder?.querySelector('summary') ?? repositoryHeader, path };
  }

  function highlightDropFolder(row = null) {
    if (row === highlightedFolder) return;
    highlightedFolder?.classList.remove('drop-target');
    highlightedFolder = row;
    highlightedFolder?.classList.add('drop-target');
  }

  let hoveredDropFolder = null;
  let expandDropFolderTimer;

  function expandFolderOnHover(folder = null) {
    if (hoveredDropFolder === folder) return;
    clearTimeout(expandDropFolderTimer);
    hoveredDropFolder = folder;
    if (folder && !folder.open) {
      expandDropFolderTimer = setTimeout(() => { folder.open = true; }, 400);
    }
  }

  function clearDropTarget() {
    highlightDropFolder();
    expandFolderOnHover();
  }

  function resourceDropTarget(target) {
    if (busy || fileDialogOpen()) return null;
    return target.closest('details[data-resource-folder]');
  }

  async function dropResourceFiles(event) {
    const target = resourceDropTarget(event.target);
    const files = Array.from(event.dataTransfer.files);
    clearDropTarget();
    event.preventDefault();
    if (!target || !files.length) return;

    const path = target.dataset.path;
    busy = true;
    setNotesStatus('正在添加资料…');
    let result;
    try {
      result = await desktopRequest({ action: 'import-resources', destinationPath: path }, files);
    } catch (error) {
      setNotesStatus(error.message);
    } finally {
      busy = false;
    }
    if (!result) return;
    await loadNotes('list-notes', null, path);
    const skipped = result.skippedCount ? '，跳过 ' + result.skippedCount + ' 项同名或无法复制的文件' : '';
    setStatus('已添加 ' + result.importedCount + ' 个资料文件' + skipped);
  }

  async function dropNote(event) {
    const target = noteDropTarget(event.target);
    const entry = draggedEntry;
    draggedEntry = null;
    clearDropTarget();
    if (!target || !entry) return;
    event.preventDefault();
    await transferNote(entry, target.path, event.ctrlKey);
  }

  async function transferNote(entry, targetPath, copy = false) {
    const action = copy ? 'copy-note' : 'move-note';
    busy = true;
    setNotesStatus('');
    let destination;
    try {
      const result = await desktopRequest({
        action, notePath: entry.path, destinationPath: targetPath, folder: entry.folder,
      });
      destination = result.notePath;
    } catch (error) {
      setNotesStatus(error.message);
    } finally {
      busy = false;
    }
    if (!destination) return false;
    const parent = destination.slice(0, Math.max(0, destination.lastIndexOf('\\')));
    await loadNotes('list-notes', copy ? null : { from: entry.path, to: destination }, parent);
    setStatus((copy ? '已复制 ' : '已移动 ') + destination.split('\\').at(-1));
    return true;
  }

  async function openRepositoryNote(note) {
    clearNoteSelection();
    setNotesStatus('');
    const switched = await switchDesktopDocument(async savedName => {
      const opened = await desktopRequest({ action: 'open-note', notePath: note.dataset.notePath });
      showOpenedDocument(opened, savedName);
      note.setAttribute('aria-current', 'true');
      selectRepositoryFolder(note.closest('details')?.dataset.path ?? '');
    }, setNotesStatus);
    if (switched && sidebarMedia.matches) {
      toggleSidebar(false);
      byId('sidebar-toggle').focus();
    }
    return switched;
  }

  function closeNoteMenu(restoreFocus = false) {
    if (noteMenu.hidden) return;
    closeNoteMoveMenu();
    noteMenu.hidden = true;
    if (noteMenuTarget instanceof HTMLTableCellElement) {
      noteMenuTarget.removeAttribute('data-table-context');
      if (restoreFocus && visual && paper.contains(noteMenuTarget)) focusVisual(noteMenuTarget);
    } else if (restoreFocus) {
      noteMenuTarget?.focus({ preventScroll: true });
    }
    noteMenuTarget = null;
  }

  function positionContextMenu(target, label, x, y) {
    closeNoteMoveMenu();
    noteMenuTarget = target;
    noteMenu.setAttribute('aria-label', label);
    noteMenu.hidden = false;
    noteMenu.style.left = Math.max(6, Math.min(x, window.innerWidth - noteMenu.offsetWidth - 6)) + 'px';
    noteMenu.style.top = Math.max(6, Math.min(y, window.innerHeight - noteMenu.offsetHeight - 6)) + 'px';
    (noteMenu.querySelector('button:not(:disabled)') ?? noteMenu).focus({ preventScroll: true });
  }

  const noteMoveMenu = byId('note-move-menu');
  let noteMoveAnchor;

  function closeNoteMoveMenu(restoreFocus = false) {
    const anchor = noteMoveAnchor;
    noteMoveAnchor = null;
    noteMoveMenu.hidden = true;
    anchor?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) anchor?.focus({ preventScroll: true });
  }

  function showNoteMoveMenu(anchor, path, folder, selected, focus = false) {
    if (noteMoveAnchor !== anchor) {
      const paths = selected.length > 1 ? selected : [path];
      const parents = paths.map(path => path.split('\\').slice(0, -1).join('\\').toLowerCase());
      const source = path.toLowerCase();
      const destinations = [...notesTree.querySelectorAll('details[data-path]:not([data-resource-folder])')]
        .map(node => ({
          path: node.dataset.path,
          label: node.querySelector(':scope > summary .note-folder-name').textContent,
        }));
      if (folder) destinations.unshift({ path: '', label: '仓库根目录' });
      const items = destinations.map(destination => {
        const name = destination.path.toLowerCase();
        const button = document.createElement('button');
        button.type = 'button';
        button.tabIndex = -1;
        button.setAttribute('role', 'menuitem');
        button.textContent = destination.label;
        button.title = destination.path || destination.label;
        button.style.paddingInlineStart = 9 + Math.max(0, destination.path.split('\\').length - 1) * 12 + 'px';
        button.disabled = parents.every(parent => parent === name) ||
          (folder && (name === source || name.startsWith(source + '\\')));
        button.addEventListener('click', () => {
          closeNoteMenu(true);
          if (busy || fileDialogOpen()) return;
          if (paths.length > 1) void transferSelectedNotes(paths, destination.path);
          else void transferNote({ path, folder }, destination.path);
        });
        return button;
      });
      if (!items.some(item => !item.disabled)) {
        const empty = document.createElement('p');
        empty.textContent = '没有可移动到的文件夹';
        items.push(empty);
      }
      noteMoveMenu.replaceChildren(...items);
      noteMoveAnchor = anchor;
      anchor.setAttribute('aria-expanded', 'true');
      noteMoveMenu.hidden = false;
      const menuBounds = noteMenu.getBoundingClientRect();
      const itemBounds = anchor.getBoundingClientRect();
      const width = noteMoveMenu.offsetWidth;
      const right = menuBounds.right - 1;
      const left = menuBounds.left - width + 1;
      const x = right + width <= innerWidth - 6 ? right : left;
      noteMoveMenu.style.left = Math.max(6, Math.min(x, innerWidth - width - 6)) + 'px';
      noteMoveMenu.style.top = Math.max(6, Math.min(itemBounds.top - 4, innerHeight - noteMoveMenu.offsetHeight - 6)) + 'px';
    }
    if (focus) (noteMoveMenu.querySelector('button:not(:disabled)') ?? noteMoveMenu).focus({ preventScroll: true });
  }

  const moveSectionDialog = byId('move-section-dialog');
  const moveSectionFolder = byId('move-section-folder');
  const moveSectionFile = byId('move-section-file');
  const moveSectionPosition = byId('move-section-position');
  const moveSectionConfirm = byId('move-section-confirm');
  const moveSectionCancel = byId('move-section-cancel');
  const moveSectionError = byId('move-section-error');
  const moveSectionTarget = byId('move-section-target');
  const moveSectionNew = byId('move-section-new');
  const moveSectionCreate = byId('move-section-create');
  const moveSectionNewName = byId('move-section-new-name');
  const moveSectionCreateConfirm = byId('move-section-create-confirm');
  let sectionMoveSource;
  let sectionMoveFolders;
  let sectionMove;

  function outlineSlug(label) {
    return label.trim().toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/\s+/g, '-') || 'heading';
  }

  function nextOutlineId(label, usedIds) {
    const slug = outlineSlug(label);
    let id = slug;
    for (let suffix = 1; usedIds.has(id); suffix++) id = slug + '-' + suffix;
    usedIds.add(id);
    return id;
  }

  function sectionHeadingLocations(text, start = 0, paragraphs) {
    const headings = [];
    const ids = new Set();
    let cursor = start;
    for (const token of marked.lexer(text.slice(start))) {
      if (!token.raw) continue;
      const offset = text.indexOf(token.raw, cursor);
      if (offset < 0) return [];
      cursor = offset + token.raw.length;
      if (paragraphs && token.type === 'paragraph') {
        const preview = DOMPurify.sanitize(marked.Parser.parseInline(token.tokens), {
          RETURN_DOM_FRAGMENT: true,
        }).textContent.trim().replace(/\s+/g, ' ');
        const label = Array.from(preview);
        paragraphs.push({ offset, end: cursor, label: label.length > 45 ? label.slice(0, 45).join('') + '…' : preview || '图片段落' });
      }
      if (token.type !== 'heading') continue;
      const label = DOMPurify.sanitize(marked.Parser.parseInline(token.tokens), {
        RETURN_DOM_FRAGMENT: true,
      }).textContent || '无标题';
      headings.push({ offset, depth: token.depth, label, id: nextOutlineId(label, ids) });
    }
    return headings;
  }

  function sectionFrontMatterEnd(text) {
    const matter = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
    return matter && /^[\p{L}_][\p{L}\p{N}_ .-]*:/mu.test(matter[1]) ? matter[0].length : 0;
  }

  function placeSectionMoveDialog() {
    if (!moveSectionDialog.open || !sectionMoveSource?.anchor.isConnected) return;
    const bounds = sectionMoveSource.anchor.getBoundingClientRect();
    const gap = 8;
    const available = innerWidth - bounds.right - 2 * gap;
    moveSectionDialog.style.width = Math.min(870, innerWidth - 2 * gap, Math.max(520, available)) + 'px';
    const { width, height } = moveSectionDialog.getBoundingClientRect();
    moveSectionDialog.style.left = Math.max(gap, Math.min(bounds.right + gap, innerWidth - width - gap)) + 'px';
    moveSectionDialog.style.top = Math.max(gap, Math.min(bounds.top, innerHeight - height - gap)) + 'px';
  }

  new ResizeObserver(placeSectionMoveDialog).observe(moveSectionDialog);
  window.addEventListener('resize', placeSectionMoveDialog);

  async function chooseSectionMove(original, start, end, anchor, contentHeading) {
    if (!desktopToken) {
      setStatus('请先保存此笔记，再移动章节');
      return;
    }
    busy = main.inert = true;
    try {
      const { notes, repository } = await desktopRequest({ action: 'list-notes' });
      if (!repository) throw new Error('请先打开当前笔记所在的仓库。');
      sectionMoveSource = { original, start, end, label: anchor.title, anchor, contentHeading };
      sectionMoveFolders = new Map();
      moveSectionFolder.replaceChildren(new Option('仓库根目录', ''));
      function addFolders(entries, depth) {
        for (const folder of entries) {
          if (folder.resource || !folder.children) continue;
          const item = new Option('　'.repeat(depth) + folder.name, folder.path);
          item.title = folder.path;
          moveSectionFolder.append(item);
          sectionMoveFolders.set(folder.path, folder.children);
          addFolders(folder.children, depth + 1);
        }
      }
      sectionMoveFolders.set('', notes ?? []);
      addFolders(notes ?? [], 0);
      moveSectionFolder.selectedIndex = 0;
      updateSectionMoveFiles();
      anchor.setAttribute('data-section-move-source', '');
      contentHeading?.setAttribute('data-section-move-source', '');
      moveSectionDialog.showModal();
      placeSectionMoveDialog();
    } catch (error) {
      setStatus(error.message);
    } finally {
      busy = main.inert = false;
    }
  }

  function resetSectionMovePosition() {
    sectionMove = null;
    moveSectionPosition.replaceChildren();
    moveSectionPosition.disabled = moveSectionConfirm.disabled = true;
    moveSectionError.textContent = '';
  }

  function updateSectionMoveFiles() {
    resetSectionMovePosition();
    toggleSectionNoteCreation(false);
    const entries = sectionMoveFolders.get(moveSectionFolder.value) ?? [];
    const files = entries.filter(entry => !entry.resource && !entry.children);
    moveSectionFile.replaceChildren(...files.map(entry => new Option(entry.name, entry.path)));
    moveSectionFile.selectedIndex = -1;
    moveSectionFile.disabled = !files.length;
    moveSectionTarget.textContent = files.length ? '请选择目标 Markdown 文件。' : '此文件夹没有 Markdown 文件，可以新建。';
  }

  function toggleSectionNoteCreation(open) {
    moveSectionCreate.hidden = !open;
    moveSectionNew.setAttribute('aria-expanded', String(open));
    moveSectionNewName.value = '';
    if (open) moveSectionNewName.focus();
  }

  function setSectionMoveBusy(pending) {
    busy = moveSectionFolder.disabled = moveSectionCancel.disabled = moveSectionNew.disabled =
      moveSectionNewName.disabled = moveSectionCreateConfirm.disabled = pending;
    moveSectionFile.disabled = pending || !moveSectionFile.options.length;
  }

  async function createSectionNote() {
    const name = moveSectionNewName.value.trim();
    if (busy || !sectionMoveSource || !name) return;
    const folder = moveSectionFolder.value;
    moveSectionError.textContent = '';
    setSectionMoveBusy(true);
    let created;
    try {
      created = await desktopRequest({ action: 'create-section-note', notePath: folder, name });
      if (!created.notePath) throw new Error('未能新建目标笔记。');
      sectionMoveSource.createdNote = true;
      sectionMoveFolders.get(folder).push({ name: created.name, path: created.notePath });
      updateSectionMoveFiles();
      moveSectionFile.value = created.notePath;
    } catch (error) {
      moveSectionError.textContent = error.message;
    } finally {
      setSectionMoveBusy(false);
    }
    if (created?.notePath) await loadSectionMoveDestination();
    else moveSectionNewName.focus();
  }

  moveSectionNew.addEventListener('click', () => toggleSectionNoteCreation(moveSectionCreate.hidden));
  moveSectionCreateConfirm.addEventListener('click', createSectionNote);
  moveSectionNewName.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    void createSectionNote();
  });
  moveSectionFolder.addEventListener('change', updateSectionMoveFiles);
  moveSectionFile.addEventListener('change', loadSectionMoveDestination);
  async function loadSectionMoveDestination() {
    if (busy || !sectionMoveSource || !moveSectionFile.value) return;
    resetSectionMovePosition();
    const { original, start, end, label } = sectionMoveSource;
    setSectionMoveBusy(true);
    moveSectionTarget.textContent = '正在读取目标笔记…';
    try {
      const { sectionDestination: target } = await desktopRequest({
        action: 'choose-section-destination', token: desktopToken, notePath: moveSectionFile.value,
      });
      if (!target) throw new Error('目标笔记不可用，请重新选择。');
      const text = target.sameFile ? original : target.contents.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
      const frontMatter = sectionFrontMatterEnd(text);
      const paragraphs = [];
      const headings = sectionHeadingLocations(text, frontMatter, paragraphs);
      function option(label, offset, group = moveSectionPosition) {
        const item = new Option(label, String(offset));
        item.disabled = target.sameFile && offset >= start && offset <= end;
        item.title = label;
        group.append(item);
      }
      option('文档开头', frontMatter);
      option('文档末尾', text.length);
      for (const [index, heading] of headings.entries()) {
        const name = 'H' + heading.depth + ' · ' + heading.label;
        let next = index + 1;
        while (headings[next]?.depth > heading.depth) next++;
        option('插在「' + name + '」之前', heading.offset);
        option('插在「' + name + '」章节之后', headings[next]?.offset ?? text.length);
      }
      if (paragraphs.length) {
        const group = document.createElement('optgroup');
        group.label = '段落';
        for (const paragraph of paragraphs) {
          option('插在段落前 · ' + paragraph.label, paragraph.offset, group);
          option('插在段落后 · ' + paragraph.label, paragraph.end, group);
        }
        moveSectionPosition.append(group);
      }
      const selection = [...moveSectionPosition.options].find(item => !item.disabled && Number(item.value) === text.length) ??
        [...moveSectionPosition.options].find(item => !item.disabled);
      if (selection) selection.selected = true;
      moveSectionPosition.disabled = moveSectionConfirm.disabled = !selection;
      moveSectionError.textContent = selection ? '' : '当前文档没有可用的其他插入位置。';
      moveSectionTarget.textContent = '将「' + label + '」移到 ' + target.path +
        (target.sameFile ? '，并保存当前笔记。' : '，并保存源笔记和目标笔记。');
      sectionMove = { original, start, end, target, text };
    } catch (error) {
      moveSectionTarget.textContent = '';
      moveSectionError.textContent = error.message;
      moveSectionFile.selectedIndex = -1;
    } finally {
      setSectionMoveBusy(false);
    }
  }

  function insertMovedSection(text, position, section) {
    const body = section.replace(/\n+$/, '');
    const after = text.slice(position);
    const result = joinMarkdownBlocks(joinMarkdownBlocks(text.slice(0, position), body), after);
    return after || !text.endsWith('\n') ? result : result + '\n';
  }

  function prepareMovedSection(plan, position) {
    const { original, start, end, target, text } = plan;
    let remaining = original.slice(0, start) + original.slice(end);
    if (target.sameFile) {
      const offset = position > end ? position - (end - start) : position;
      return { remaining: insertMovedSection(remaining, offset, original.slice(start, end)), assets: [] };
    }

    const assets = new Set();
    const sourceAssets = assetName(target.sourceName);
    const assetFolder = encodeAssetPath(assetName(target.name) + '/' + target.assetFolder);
    const sourceFolder = target.sourceFolder === '.' ? '' :
      encodeAssetPath(target.sourceFolder.replace(/\\/g, '/')) + '/';
    const sourceFile = sourceFolder + encodeAssetPath(target.sourceName);
    const headings = sectionHeadingLocations(original, sectionFrontMatterEnd(original));
    const targetIds = new Set(sectionHeadingLocations(text, sectionFrontMatterEnd(text))
      .filter(item => item.offset < position).map(item => item.id));
    const retainedIds = new Set();
    const headingLinks = new Map(headings.map(item => [item.id, item.offset < start || item.offset >= end
      ? sourceFile + '#' + encodeURIComponent(nextOutlineId(item.label, retainedIds))
      : '#' + encodeURIComponent(nextOutlineId(item.label, targetIds))]));
    const definitions = [];
    const section = rewriteMarkdownTargets(original, value => {
      if (value.startsWith('#')) {
        let anchor = value.slice(1);
        try { anchor = decodeURIComponent(anchor); } catch { /* Preserve invalid fragments. */ }
        return headingLinks.get(anchor) ?? value;
      }
      if (value.startsWith('?')) return sourceFile + value;
      if (/^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(value)) return value;
      if (assetReference(value, sourceAssets)) {
        const relative = value.replace(/^(?:\.\/)*[^/]+\//, '');
        assets.add(decodeURIComponent(relative.split(/[?#]/, 1)[0]));
        return assetFolder + '/' + relative;
      }
      return sourceFolder + value.replace(/^(?:\.\/)+/, '');
    }, { expandReferences: true, section: { start, end, definitions } });
    if (definitions.length)
      remaining = joinMarkdownBlocks(joinMarkdownBlocks(original.slice(0, start), definitions.join('\n')), original.slice(end));
    return { remaining, targetText: insertMovedSection(text, position, section), assets: [...assets] };
  }

  byId('move-section-form').addEventListener('submit', async event => {
    event.preventDefault();
    const plan = sectionMove;
    const selected = moveSectionPosition.selectedOptions[0];
    if (busy || !plan || !selected || selected.disabled || markdown !== plan.original) return;
    setSectionMoveBusy(true);
    moveSectionConfirm.disabled = moveSectionPosition.disabled = true;
    moveSectionError.textContent = '';
    try {
      const prepared = prepareMovedSection(plan, Number(selected.value));
      const contents = (hasBom ? '\uFEFF' : '') + prepared.remaining.replace(/\n/g, lineEnding);
      const targetContents = prepared.targetText === undefined ? undefined :
        (plan.target.contents.startsWith('\uFEFF') ? '\uFEFF' : '') +
        prepared.targetText.replace(/\n/g, plan.target.contents.includes('\r\n') ? '\r\n' : '\n');
      const result = await desktopRequest({ action: 'move-note-section', token: desktopToken, contents,
        sectionMove: { id: plan.target.id, targetContents, assets: prepared.assets } });
      if (!result.name || typeof result.contents !== 'string') throw new Error('未能保存移动结果。');
      moveSectionDialog.close();
      showOpenedDocument(result, filename);
      setStatus('已移动章节到 ' + plan.target.path);
    } catch (error) {
      moveSectionError.textContent = error.message;
    } finally {
      setSectionMoveBusy(false);
      moveSectionConfirm.disabled = moveSectionPosition.disabled = false;
    }
  });
  moveSectionCancel.addEventListener('click', () => moveSectionDialog.close());
  moveSectionDialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  moveSectionDialog.addEventListener('close', () => {
    const session = sectionMoveSource;
    session?.anchor.removeAttribute('data-section-move-source');
    session?.contentHeading?.removeAttribute('data-section-move-source');
    sectionMove = sectionMoveSource = sectionMoveFolders = null;
    if (session?.createdNote) void loadNotes('list-notes');
  });

  function showOutlineMenu(target, contentHeading, heading, sectionEnd, x, y) {
    if (busy || fileDialogOpen()) return;
    const original = markdown;
    const headingEnd = heading.end;
    const contents = original.slice(headingEnd, sectionEnd);
    const start = headingEnd + (contents.match(/^\n{1,2}/)?.[0].length ?? 0);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.tabIndex = -1;
    remove.setAttribute('role', 'menuitem');
    remove.className = 'destructive';
    remove.textContent = '删除标题下的内容';
    remove.disabled = !contents.trim();
    remove.addEventListener('click', () => {
      closeNoteMenu(true);
      if (busy || markdown !== original ||
          !window.confirm(`删除「${target.title}」下的正文和子标题？当前标题将保留。`)) return;
      if (mode === 'source') {
        source.focus();
        source.setSelectionRange(start, sectionEnd);
        if (!document.execCommand('delete')) {
          source.setRangeText('', start, sectionEnd, 'start');
          recordInput(source);
        }
      } else {
        if (visual) captureVisualCaret();
        active = null;
        markdown = original.slice(0, start) + original.slice(sectionEnd);
        cursor = headingEnd;
        render();
        if (visual) focusVisual(blockAt(cursor).element ?? paper, true);
        updateEditedDocument();
        rememberEditorChange();
      }
      desktop?.postMessage({ action: 'editor-delete-section' });
      setStatus('已删除标题下的内容');
    });
    noteMenu.replaceChildren(remove);
    if (desktop) {
      const move = document.createElement('button');
      move.type = 'button';
      move.tabIndex = -1;
      move.setAttribute('role', 'menuitem');
      move.textContent = '移动整个章节…';
      move.addEventListener('click', () => {
        closeNoteMenu(true);
        if (!busy && markdown === original) void chooseSectionMove(original, heading.start, sectionEnd, target, contentHeading);
      });
      noteMenu.prepend(move);
    }
    positionContextMenu(target, '标题操作', x, y);
  }

  function showNoteMenu(target, x, y) {
    if (busy || fileDialogOpen()) return;
    const folder = target.matches('summary');
    const path = folder ? target.parentElement.dataset.path : target.dataset.notePath;
    const selected = selectedNotePaths.has(path) && !folder ? [...selectedNotePaths] : [];
    if (!selected.length && !folder) clearNoteSelection();
    const batch = selected.length > 1;
    const actions = batch ? [
      ['合并 Markdown…', 'merge-selected-notes'],
      ['移动选中的笔记到…', 'choose-move-destination'],
      ['剪切选中的笔记', 'cut-note'],
      ['复制选中的笔记', 'copy-tree-note'],
      ['将选中的笔记移到回收站', 'delete-note'],
      ['取消多选', 'clear-note-selection'],
    ] : [
      folder ? ['打开文件夹', 'open-note-folder'] : ['打开笔记', 'open-note'],
      ['在资源管理器中显示', 'reveal-note'],
      ['新建 Markdown…', 'new-note-here'],
      ['新建文件夹…', 'new-folder-here'],
      ['移动到…', 'choose-move-destination'],
      ['剪切', 'cut-note'],
      ['复制', 'copy-tree-note'],
      ['粘贴', 'paste-note'],
      ['复制路径', 'copy-note-path'],
      ['复制相对路径', 'copy-relative-note-path'],
    ];
    if (!batch) {
      actions.splice(2, 0, ['设置图标…', 'set-note-icon']);
      actions.push(folder ? ['重命名文件夹', 'rename-folder'] : ['重命名笔记', 'rename-note']);
      if (!folder) actions.push(['移到回收站', 'delete-note']);
      actions.push(['永久删除', 'delete-note-permanently']);
    }

    noteMenu.replaceChildren(...actions.map(([label, action]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.tabIndex = -1;
      button.setAttribute('role', 'menuitem');
      button.textContent = label;
      button.disabled = action === 'paste-note' && !noteClipboard;
      if (action === 'delete-note-permanently') button.classList.add('destructive');
      if (action === 'choose-move-destination') {
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-controls', 'note-move-menu');
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('pointerenter', event => {
          if (event.pointerType !== 'touch') showNoteMoveMenu(button, path, folder, selected);
        });
        button.addEventListener('click', () => showNoteMoveMenu(button, path, folder, selected, true));
        button.addEventListener('keydown', event => {
          if (event.key !== 'ArrowRight') return;
          event.preventDefault();
          showNoteMoveMenu(button, path, folder, selected, true);
        });
        return button;
      }
      button.addEventListener('pointerenter', () => closeNoteMoveMenu());
      button.addEventListener('click', () => {
        closeNoteMenu(true);
        if (batch) runSelectedNoteAction(action, selected);
        else runNoteMenuAction(action, target, path, folder);
      });
      return button;
    }));
    positionContextMenu(target, batch ? `已选中 ${selected.length} 份笔记` : '笔记操作', x, y);
  }

  function showTableMenu(cell, x, y) {
    if (!visual || !cell || busy || fileDialogOpen() || cell.closest('[contenteditable="false"]')) return false;
    const table = cell.closest('table');
    if (!table?.tHead || table.tHead.rows.length !== 1 || !paper.contains(table)) return false;
    const header = table.tHead.rows[0];
    const row = cell.parentElement;
    const width = header.cells.length;
    if ([...table.rows].some(entry => entry.cells.length !== width ||
        [...entry.cells].some(item => item.colSpan !== 1 || item.rowSpan !== 1))) return false;

    closeNoteMenu();
    closeBlockMenu();
    focusVisual(cell);
    captureVisualCaret();
    cell.setAttribute('data-table-context', '');
    const actions = [
      ['在上方插入行', 'row-above', row === header],
      ['在下方插入行', 'row-below'],
      ['在左侧插入列', 'column-left'],
      ['在右侧插入列', 'column-right'],
      ['删除当前行', 'delete-row', row === header],
      ['删除当前列', 'delete-column', width <= 1],
    ];
    noteMenu.replaceChildren(...actions.map(([label, action, disabled]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.tabIndex = -1;
      button.setAttribute('role', 'menuitem');
      button.textContent = label;
      button.disabled = Boolean(disabled);
      if (action === 'delete-row') button.classList.add('table-menu-delete');
      button.addEventListener('click', () => {
        closeNoteMenu();
        if (visual && !busy && paper.contains(cell)) editTable(cell, action);
      });
      return button;
    }));
    positionContextMenu(cell, '表格操作', x, y);
    return true;
  }

  function editTable(cell, action) {
    const table = cell.closest('table');
    const row = cell.parentElement;
    const header = table.tHead.rows[0];
    const rowIndex = row.rowIndex;
    const column = cell.cellIndex;
    const newCell = (targetRow, index, align) => {
      const item = document.createElement(targetRow === header ? 'th' : 'td');
      if (align) item.align = align;
      item.append(document.createElement('br'));
      targetRow.insertBefore(item, targetRow.cells[index] ?? null);
      return item;
    };
    let target;
    if (action === 'row-above' || action === 'row-below') {
      const inserted = document.createElement('tr');
      for (const [index, item] of [...header.cells].entries()) newCell(inserted, index, item.align);
      if (row === header) (table.tBodies[0] ?? table.createTBody()).prepend(inserted);
      else row[action === 'row-above' ? 'before' : 'after'](inserted);
      target = inserted.cells[column];
    } else if (action === 'column-left' || action === 'column-right') {
      const index = column + (action === 'column-right' ? 1 : 0);
      const align = header.cells[column].align;
      for (const entry of table.rows) {
        const inserted = newCell(entry, index, align);
        if (entry === row) target = inserted;
      }
    } else if (action === 'delete-row') {
      row.remove();
      target = table.rows[Math.min(rowIndex, table.rows.length - 1)].cells[column];
    } else {
      for (const entry of table.rows) entry.deleteCell(column);
      target = row.cells[Math.min(column, row.cells.length - 1)];
    }
    focusVisual(target);
    recordVisualInput(undefined, { preserveTail: true });
  }

  function showImageMenu(event) {
    const image = event.target.closest('img[src]');
    if (mode !== 'visual' || !image || busy || fileDialogOpen()) return;
    const block = visualRangeAt(image);
    if (!block) return;
    event.preventDefault();

    const src = visualMarkdown.imageSource(image);
    const local = src && !/^(?:[a-z][a-z\d+.-]*:|[/\\]|#|\?)/i.test(src);
    const replacement = desktopToken && !image.hasAttribute('srcset') && !image.closest('picture')
      ? findImageReplacement(block, image) : null;
    const menuMarkdown = markdown;
    const actions = [
      ['打开图片位置', 'reveal-image', desktopToken && local ? '' : '当前图片没有可打开的本地位置'],
      ['替换图片…', 'replace-image', replacement ? '' :
        desktopToken ? '无法定位此图片的 Markdown 引用' : '请先保存笔记'],
    ];
    noteMenu.replaceChildren(...actions.map(([label, action, reason]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.tabIndex = -1;
      button.setAttribute('role', 'menuitem');
      button.textContent = label;
      button.disabled = Boolean(reason);
      if (reason) button.title = reason;
      button.addEventListener('click', () => {
        closeNoteMenu(true);
        if (action === 'replace-image' && markdown !== menuMarkdown) {
          setStatus('笔记已修改，请重新打开图片菜单');
          return;
        }
        void runImageAction(action, src, replacement);
      });
      return button;
    }));
    positionContextMenu(paper, '图片操作', event.clientX, event.clientY);
  }

  async function runImageAction(action, src, replacement) {
    if (busy || !desktopToken || mode !== 'visual') return;
    busy = main.inert = true;
    try {
      const result = await desktopRequest({ action, token: desktopToken, notePath: src });
      if (action !== 'replace-image' || !result.notePath) return;
      const { start, end, insert } = replacement;
      captureVisualCaret();
      markdown = markdown.slice(0, start) + insert(encodeAssetPath(result.notePath)) + markdown.slice(end);
      cursor = start;
      visual = null;
      render();
      updateCount();
      rememberEditorChange();
      persist('已替换图片，请保存笔记');
    } catch (error) {
      setStatus(error.message);
    } finally {
      busy = main.inert = false;
    }
  }

  async function runNoteMenuAction(action, target, notePath, folder) {
    if (busy || fileDialogOpen()) return;
    if (action === 'set-note-icon') {
      showNoteIconPicker(target, notePath, folder);
      return;
    }
    if (action === 'new-note-here' || action === 'new-folder-here' || action === 'paste-note') {
      const destination = folder ? notePath : target.closest('details')?.dataset.path ?? '';
      if (action === 'paste-note') await pasteRepositoryEntry(destination);
      else {
        selectRepositoryFolder(destination);
        showRepositoryCreation(action === 'new-folder-here');
      }
      return;
    }
    if (action === 'cut-note' || action === 'copy-tree-note') {
      noteClipboard = { entries: [{ path: notePath, folder }], cut: action === 'cut-note' };
      const name = folder ? target.querySelector('.note-folder-name').textContent : target.textContent;
      setStatus((noteClipboard.cut ? '已剪切 ' : '已复制 ') + name);
      return;
    }
    if (action === 'open-note') {
      await openRepositoryNote(target);
      return;
    }
    if (action === 'rename-folder') {
      renameFolderPath = notePath;
      openRenameDialog('重命名文件夹', target.querySelector('.note-folder-name').textContent);
      return;
    }
    if (action === 'rename-note') {
      if (target.getAttribute('aria-current') === 'true' || await openRepositoryNote(target)) showRename();
      return;
    }
    if (action === 'delete-note' || action === 'delete-note-permanently') {
      await deleteRepositoryNote(notePath, folder, action === 'delete-note-permanently');
      return;
    }

    busy = true;
    setNotesStatus('');
    try {
      await desktopRequest({ action, notePath, folder });
      if (action === 'reveal-note') setStatus('已在资源管理器中选中');
      if (action === 'copy-note-path') setStatus('已复制路径');
      if (action === 'copy-relative-note-path') setStatus('已复制相对路径');
    } catch (error) {
      setNotesStatus(error.message);
    } finally {
      busy = false;
    }
  }

  async function pasteRepositoryEntry(destination) {
    if (!noteClipboard || busy || fileDialogOpen()) return;
    const clipboard = noteClipboard;
    if (clipboard.entries.length === 1) {
      if (await transferNote(clipboard.entries[0], destination, !clipboard.cut) && clipboard.cut) noteClipboard = null;
    } else {
      await transferSelectedNotes(clipboard.entries.map(({ path }) => path), destination, !clipboard.cut);
    }
  }

  function removeClipboardEntries(predicate) {
    if (!noteClipboard) return;
    noteClipboard.entries = noteClipboard.entries.filter(entry => !predicate(entry.path));
    if (!noteClipboard.entries.length) noteClipboard = null;
  }

  async function transferSelectedNotes(paths, destination, copy = false) {
    busy = true;
    setNotesStatus('');
    const transferred = [];
    const skipped = [];
    try {
      for (const path of paths) {
        const name = path.split('\\').at(-1);
        try {
          const { notePath } = await desktopRequest({
            action: copy ? 'copy-note' : 'move-note', notePath: path, destinationPath: destination,
          });
          if (notePath) transferred.push({ from: path, to: notePath });
          else skipped.push(name + '（已在目标文件夹）');
        } catch (error) {
          skipped.push(name + '（' + error.message + '）');
        }
      }
    } catch (error) {
      setNotesStatus(error.message);
      return;
    } finally {
      busy = false;
    }
    if (transferred.length) {
      if (!copy) {
        const movedPaths = new Set(transferred.map(move => move.from));
        for (const path of movedPaths) selectedNotePaths.delete(path);
        updateNoteSelection();
        if (noteClipboard?.cut) removeClipboardEntries(path => movedPaths.has(path));
      }
      await loadNotes('list-notes', copy ? null : transferred, destination);
      setStatus((copy ? '已复制 ' : '已移动 ') + transferred.length + ' 份笔记');
    }
    if (skipped.length) setNotesStatus('未处理：' + skipped.join('、'));
  }

  async function runSelectedNoteAction(action, paths) {
    if (busy || fileDialogOpen()) return;
    if (action === 'merge-selected-notes') {
      await mergeNotes(paths);
    } else if (action === 'clear-note-selection') {
      clearNoteSelection();
    } else if (action === 'cut-note' || action === 'copy-tree-note') {
      const cut = action === 'cut-note';
      noteClipboard = { entries: paths.map(path => ({ path, folder: false })), cut };
      setStatus((cut ? '已剪切 ' : '已复制 ') + paths.length + ' 份笔记');
    } else if (action === 'delete-note') {
      await deleteRepositoryNote(paths);
    }
  }

  async function deleteRepositoryNote(notePath, folder = false, permanent = false, merge = null) {
    if (busy || fileDialogOpen()) return;
    busy = main.inert = true;
    setNotesStatus('');
    let deletedLabel;
    let keptDraft = false;
    let notice;
    try {
      const batch = Array.isArray(notePath);
      const result = await desktopRequest(merge ? { action: 'recycle-merge-originals', notePath: merge.destination, mergeOriginals: merge.originals } :
        batch ? { action: 'recycle-notes', notePaths: notePath } :
        { action: permanent ? 'delete-note-permanently' : 'delete-note', notePath, folder });
      notice = result.batchNotice;
      const deleted = new Set(batch ? result.recycledNotes : result.name ? [notePath] : []);
      if (!deleted.size) {
        if (notice) setNotesStatus(notice);
        return;
      }
      deletedLabel = batch ? deleted.size + ' 份笔记' : result.name;
      if (merge) {
        const repository = byId('notes-root').title;
        const records = readMergeRecords(repository).map(record => ({
          ...record, originals: record.originals.filter(original => !deleted.has(original.path)),
        })).filter(record => record.originals.length);
        writeMergeRecords(repository, records);
      }
      removeClipboardEntries(path => deleted.has(path) || (folder && path.startsWith(notePath + '\\')));
      if (result.deletedCurrent) {
        keptDraft = markdown !== savedText;
        if (keptDraft) {
          finishBlock();
          desktopToken = null;
          savedText = null;
          filename = '未命名.md';
          updateDocumentLabel();
          render();
          persist();
        } else {
          replaceDocument('', '未命名.md');
        }
      }
    } catch (error) {
      setNotesStatus(error.message);
    } finally {
      busy = main.inert = false;
    }
    if (!deletedLabel) return;
    await loadNotes('list-notes');
    if (notice) setNotesStatus(notice);
    setStatus('已删除 ' + deletedLabel + (keptDraft ? '，未保存的修改已保留为草稿' : ''));
  }

  async function importAsMarkdown(action, formatName) {
    let imported = false;
    await switchDesktopDocument(async () => {
      const previousStatus = byId('status').textContent;
      setStatus('正在导入 ' + formatName + '…');
      const result = await desktopRequest({ action });
      if (result.importedCount != null) {
        if (result.name) showOpenedDocument(result);
        imported = result.importedCount > 0;
        setStatus('批量导入：成功 ' + result.importedCount + ' 个，失败 ' + result.skippedCount + ' 个');
        return;
      }
      if (!result.name) {
        setStatus(previousStatus);
        return;
      }
      showOpenedDocument(result);
      setStatus('已导入 ' + formatName + '，保存为 ' + filename);
      imported = true;
    });
    if (imported) await loadNotes('list-notes');
  }

  async function openDocument() {
    if (desktop) {
      await switchDesktopDocument(async savedName => {
        const opened = await desktopRequest({ action: 'open' });
        if (opened.name) showOpenedDocument(opened, savedName);
        else if (opened.openedPdf) setStatus('已打开 PDF ' + opened.openedPdf);
      });
      return;
    }
    if (busy || fileDialogOpen() || !canReplace()) return;
    if (!window.showOpenFilePicker) {
      byId('file').click();
      return;
    }
    busy = true;
    const original = markdown;
    try {
      const [chosen] = await window.showOpenFilePicker({
        types: [{ description: 'Markdown / 纯文本', accept: { 'text/plain': ['.md', '.markdown', '.txt'] } }],
      });
      const file = await chosen.getFile();
      if (markdown === original || canReplace()) await useFile(file, chosen);
    } catch (error) {
      if (error.name === 'SecurityError') byId('file').click();
      else if (error.name !== 'AbortError') setStatus('打开失败，请选择 UTF-8 编码的 Markdown 文件');
    } finally {
      busy = false;
    }
  }

  function download(contents) {
    const url = URL.createObjectURL(new Blob([contents], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function saveInBrowser(contents) {
    let destination = handle;
    if (!destination && window.showSaveFilePicker) {
      try {
        destination = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }],
        });
      } catch (error) {
        if (error.name !== 'SecurityError') throw error;
      }
    }
    if (!destination) {
      download(contents);
      return true;
    }

    const writer = await destination.createWritable();
    try {
      await writer.write(contents);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
    handle = destination;
    filename = destination.name;
    return false;
  }

  async function saveDocument() {
    if (busy || fileDialogOpen()) return;
    busy = true;
    saveButton.disabled = true;
    let saved;
    try {
      saved = await saveCurrentDocument();
    } finally {
      saveButton.disabled = false;
      busy = false;
    }
    if (desktop && saved) await loadNotes('list-notes');
  }

  async function exportMarkdown() {
    if (busy || fileDialogOpen()) return;
    busy = true;
    try {
      const contents = (hasBom ? '\uFEFF' : '') + markdown.replace(/\n/g, lineEnding);
      const exported = await desktopRequest({ action: 'export-markdown', token: desktopToken, name: filename, contents });
      if (exported.name) setStatus('已导出 ' + exported.name);
    } catch (error) {
      setStatus(error.message);
    } finally {
      busy = false;
    }
  }

  async function saveCurrentDocument(autoSave = false) {
    const snapshot = markdown;
    const contents = (hasBom ? '\uFEFF' : '') + snapshot.replace(/\n/g, lineEnding);
    let downloaded = false;
    try {
      if (desktop) {
        const saved = await desktopRequest({ action: 'save', token: desktopToken, name: filename, contents, autoSave });
        if (!saved.name) {
          if (autoSave) setStatus('已取消保存，仍停留在当前文档');
          return false;
        }
        desktopToken = saved.token;
        filename = saved.name;
        if (visual) {
          for (const image of paper.querySelectorAll('img[src]')) prepareNoteImage(image, visualMarkdown.imageSource(image));
        } else if (!active) render();
      } else {
        downloaded = await saveInBrowser(contents);
      }
      savedText = snapshot;
      updateDocumentLabel();
      persist(markdown === snapshot ? (downloaded ? '已发起文件下载' : '已保存到文件') : '文件已保存，后续修改仍在本机草稿中');
      return true;
    } catch (error) {
      if (desktop) setStatus(error.message);
      else if (error.name !== 'AbortError') setStatus('保存失败，草稿仍保留在编辑器中');
      return false;
    }
  }

  async function mergeNotes(notePaths) {
    let merged = false;
    let destination;
    await switchDesktopDocument(async savedName => {
      const plan = await desktopRequest({ action: 'prepare-merge', notePaths });
      if (!plan.mergeFiles) return;
      const sections = plan.mergeFiles.map((file, index) => {
        const text = file.contents.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trimEnd();
        const tokens = marked.lexer(text);
        const first = tokens.find(token => token.type !== 'space' && token.type !== 'def');
        const levels = markdownHeadingLevels(tokens);
        const highest = levels.reduce((min, depth) => Math.min(min, depth), 6);
        const hasTitle = first?.type === 'heading' && first.depth === highest &&
          levels.filter(depth => depth === highest).length === 1;
        const headingShift = levels.length ? (hasTitle ? 2 : 3) - highest : 0;
        const relativeFolder = file.relativeFolder === '.' ? '' : encodeAssetPath(file.relativeFolder.replace(/\\/g, '/')) + '/';
        const sourceAssets = assetName(file.name);
        const outputAssets = encodeAssetPath(assetName(plan.name) + '/' + (index + 1));
        const sourceReferences = assetName(file.name, '.资料');
        const outputReferences = encodeAssetPath(assetName(plan.name, '.资料') + '/' + (index + 1));
        const body = rewriteMarkdownTargets(text, value => {
          if (file.hasAssets && assetReference(value, sourceAssets)) return rewriteAssetFolder(value, outputAssets);
          if (file.hasReferences && assetReference(value, sourceReferences)) return rewriteAssetFolder(value, outputReferences);
          if (!relativeFolder || /^(?:[a-z][a-z0-9+.-]*:|[\\/#?])/i.test(value)) return value;
          return relativeFolder + value.replace(/^(?:\.\/)+/, '');
        }, { expandReferences: true, headingShift });
        if (hasTitle) return body;
        const title = file.name.replace(/\.[^.]+$/, '').replace(/[&*#<>[\]\\_~\x60]/g, '\\$&');
        return ('## ' + title + '\n\n' + body).trimEnd();
      });
      const result = await desktopRequest({ action: 'merge', contents: sections.join('\n\n') + '\n' });
      showOpenedDocument(result, savedName);
      setStatus('已合并 ' + sections.length + ' 篇笔记');
      destination = result.notePath;
      if (destination && result.repository && result.mergeOriginals?.length) {
        const records = readMergeRecords(result.repository).filter(record => record.destination !== destination);
        records.push({ destination, originals: result.mergeOriginals });
        if (!writeMergeRecords(result.repository, records)) setStatus('已合并笔记，无法保存原稿标记。');
      }
      merged = true;
    });
    if (merged) await loadNotes('list-notes', null, destination?.slice(0, Math.max(0, destination.lastIndexOf('\\'))), destination);
  }

  function assetName(name, suffix = '.assets') {
    const dot = name.lastIndexOf('.');
    return (dot < 0 ? name : name.slice(0, dot)) + suffix;
  }

  function assetReference(path, assets) {
    const folder = /^(?:\.\/)*([^/]+)\//.exec(path)?.[1];
    if (!folder) return false;
    try {
      return decodeURIComponent(folder).toLowerCase() === assets.toLowerCase();
    } catch {
      return false;
    }
  }

  function encodeAssetPath(path) {
    return path.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g,
      character => '%' + character.charCodeAt(0).toString(16).toUpperCase())).join('/');
  }

  function rewriteAssetFolder(value, encodedFolder) {
    return value.replace(/^((?:\.\/)*)([^/]+)(?=\/)/, '$1' + encodedFolder);
  }

  function renameAttachmentReferences(text, oldName, newName) {
    const folders = ['.assets', '.资料'].map(suffix => [assetName(oldName, suffix), encodeAssetPath(assetName(newName, suffix))]);
    return rewriteMarkdownTargets(text, value => {
      const match = folders.find(([oldFolder]) => assetReference(value, oldFolder));
      return match ? rewriteAssetFolder(value, match[1]) : value;
    });
  }

  function findImageReplacement(block, image) {
    const { start, end } = block;
    const rendered = [...block.element.querySelectorAll('img[src]')];
    const candidates = [];
    const rules = marked.Lexer.rules.inline.gfm;
    const inline = new RegExp(rules.link.source, 'd');
    const decoder = document.createElement('textarea');
    const normalize = value => {
      try { return new URL(value, location.href).href; }
      catch { return value; }
    };
    const decodeEntities = value => {
      decoder.innerHTML = value.replaceAll('<', '&lt;');
      return decoder.value;
    };

    visitMarkdownSource(markdown, (token, raw, offset) => {
      if (offset < start || offset >= end) return;
      if (token.type === 'image') {
        const match = inline.exec(raw);
        if (match) {
          const [left, right] = match.indices[2];
          candidates.push({ src: token.href, start: offset + left, end: offset + right,
            insert: path => match[2].startsWith('<') ? '<' + path + '>' : path });
        } else {
          const reference = rules.reflink.exec(raw) ?? rules.nolink.exec(raw);
          if (!reference) return;
          const label = reference[1];
          const title = token.title ? ' "' + token.title.replace(/[\\"]/g, '\\$&') + '"' : '';
          candidates.push({ src: token.href, start: offset, end: offset + raw.length,
            insert: path => '![' + label + '](' + path + title + ')' });
        }
        return false;
      } else if (token.type === 'html' && !token.pre && !token.inRawBlock) {
        for (const tag of raw.matchAll(/<!--[\s\S]*?-->|<img\b(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*>/gi)) {
          if (tag[0].startsWith('<!--')) continue;
          const attribute = /\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/dg;
          for (const match of tag[0].matchAll(attribute)) {
            if (match[1].toLowerCase() !== 'src') continue;
            const value = match.slice(2).findIndex(part => part !== undefined) + 2;
            if (value === 1) break;
            const [left, right] = match.indices[value];
            candidates.push({ src: decodeEntities(match[value]), start: offset + tag.index + left,
              end: offset + tag.index + right, insert: path => path });
            break;
          }
        }
      }
    });
    candidates.sort((a, b) => a.start - b.start);
    if (candidates.length !== rendered.length || rendered.some((node, index) =>
      normalize(visualMarkdown.imageSource(node)) !== normalize(candidates[index].src))) return null;
    return candidates[rendered.indexOf(image)] ?? null;
  }

  function rewriteMarkdownTargets(text, transform, { expandReferences = false, headingShift = 0, section } = {}) {
    const edits = new Map();

    function editDestinations(raw, offset, pattern) {
      let matched = false;
      for (const match of raw.matchAll(pattern)) {
        const index = match.slice(1).findIndex(value => value !== undefined) + 1;
        const [start, end] = match.indices[index];
        const original = match[index].replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_{}|~])/g, '$1');
        const updated = original ? transform(original) : original;
        if (updated !== original) edits.set(offset + start, [offset + end, updated]);
        matched = true;
      }
      return matched;
    }

    visitMarkdownSource(text, (token, raw, offset, start) => {
      if (section && (offset < section.start || start > section.end)) return false;
      if (token.type === 'image' || token.type === 'link') {
        const inline = editDestinations(raw, offset, /\]\(\s*(?:<([^>\r\n]*)>|((?:\\.|[^\s<>()]|\((?:\\.|[^()\\\s])*\))*))/dg);
        if (!inline && expandReferences && /^!?\[/.test(raw) && token.href) {
          const href = transform(token.href);
          const prefix = token.type === 'image' ? '!' : '';
          const title = token.title ? ' ' + JSON.stringify(token.title) : '';
          edits.set(offset, [start, prefix + '[' + token.text + '](<' + href + '>' + title + ')']);
          return false;
        }
      } else if (token.type === 'def') {
        if (section) {
          section.definitions.push(raw);
          edits.set(offset, [start, '']);
          return false;
        }
        editDestinations(raw, offset, /^\s*\[[^\n]+\]:\s*(?:<([^>\r\n]*)>|(\S+))/dg);
      } else if (token.type === 'heading' && headingShift) {
        const hashes = '#'.repeat(Math.max(2, Math.min(6, token.depth + headingShift)));
        const atx = /^ {0,3}(#{1,6})(?=[ \t\n]|$)/d.exec(raw);
        if (atx) {
          const marker = atx.indices[1];
          edits.set(offset + marker[0], [offset + marker[1], hashes]);
        } else {
          const underline = /\n[ \t]*(?:=+|-+)[ \t]*(?=\n*$)/.exec(raw);
          if (underline) {
            const textStart = offset + /^ {0,3}/.exec(raw)[0].length;
            edits.set(textStart, [textStart, hashes + ' ']);
            const title = raw.slice(0, underline.index);
            for (const line of title.matchAll(/\n[ \t]*/g)) {
              edits.set(offset + line.index, [offset + line.index + line[0].length, ' ']);
            }
            const closingHashes = /(?<=\s)#+(?=[ \t]*$)/.exec(title);
            if (closingHashes) {
              const position = offset + closingHashes.index;
              edits.set(position, [position, '\\']);
            }
            edits.set(offset + underline.index, [offset + underline.index + underline[0].length, '']);
          }
        }
      } else if (token.type === 'html' && !token.pre) {
        if (headingShift) {
          for (const tag of raw.matchAll(/<!--[\s\S]*?-->|<\/?h([1-6])(?=[\s/>])/dgi)) {
            if (!tag[1]) continue;
            const [start, end] = tag.indices[1];
            edits.set(offset + start, [offset + end, String(Math.max(2, Math.min(6, Number(tag[1]) + headingShift)))]);
          }
        }
        for (const tag of raw.matchAll(/<!--[\s\S]*?-->|<(?:img|a)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)) {
          if (!tag[0].startsWith('<!--'))
            editDestinations(tag[0], offset + tag.index,
              /\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^<>\s"'=]+))/dgi);
        }
      }
    });
    const base = section?.start ?? 0;
    if (section) text = text.slice(base, section.end);
    for (const [start, [end, value]] of [...edits].sort(([a], [b]) => b - a)) {
      text = text.slice(0, start - base) + value + text.slice(end - base);
    }
    return text;
  }

  function visitMarkdownSource(text, visitor) {
    const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    function visit(tokens, start, limit) {
      for (const token of tokens) {
        if (!token.raw) continue;
        let offset = text.indexOf(token.raw, start);
        let raw = token.raw;
        if (offset < 0 || offset + raw.length > limit) {
          if (!raw.includes('\n')) continue;
          // Marked removes indentation and quote markers from nested tokens.
          const pattern = new RegExp(raw.split('\n').map(escapeRegex).join('\\n[ \\t>]*?'));
          const match = pattern.exec(text.slice(start, limit));
          if (!match) continue;
          offset = start + match.index;
          raw = match[0];
        }
        start = offset + raw.length;
        if (visitor(token, raw, offset, start) === false) continue;
        if (token.type === 'list') visit(token.items, offset, start);
        else if (token.type === 'table') {
          visit([...token.header, ...token.rows.flat()].flatMap(cell => cell.tokens), offset, start);
        } else if (token.tokens) visit(token.tokens, offset, start);
      }
    }
    visit(marked.lexer(text), 0, text.length);
  }

  function editSectionDraft(transform, success) {
    if (!sectionEdit) return;
    const text = sectionEdit.draft;
    const edits = [];
    const edit = (start, end, value = '') => edits.push({ start, end, value });
    visitMarkdownSource(text, (token, raw, start, end) => transform(token, raw, start, end, edit));
    if (!edits.length) {
      sectionFormatStatus.textContent = '没有可调整的格式';
      return;
    }
    const parts = [];
    let offset = 0;
    for (const { start, end, value } of edits.sort((a, b) => a.start - b.start)) {
      if (start < offset) continue;
      parts.push(text.slice(offset, start), value);
      offset = end;
    }
    parts.push(text.slice(offset));
    sectionEdit.draft = parts.join('');
    updateSectionPreview();
    sectionFormatStatus.textContent = success;
  }

  function shiftSectionDraftHeadings(delta) {
    editSectionDraft((token, raw, start, end, edit) => {
      if (token.type !== 'heading') return;
      const depth = Math.max(1, Math.min(6, token.depth + delta));
      if (depth === token.depth) return;
      const hashes = '#'.repeat(depth);
      const prefix = /^( {0,3})(#{1,6})(?=[ \t\n]|$)/.exec(raw);
      if (prefix) {
        const marker = start + prefix[1].length;
        edit(marker, marker + prefix[2].length, hashes);
      } else {
        const title = token.text.replace(/\s*\n\s*/g, ' ').replace(/(?<=\s)#+$/, '\\$&');
        const tail = raw.slice(raw.trimEnd().length);
        edit(start, end, hashes + ' ' + title + tail);
        return false;
      }
    }, '已调整标题等级');
  }

  function plainLinkText(text) {
    return text.replace(/\b(https?):(?=\/\/)/gi, '$1&#58;')
      .replace(/\bwww\./gi, 'www&#46;').replaceAll('@', '&#64;');
  }

  function linkLabelEnd(raw) {
    let depth = 1;
    for (let index = 1; index < raw.length; index++) {
      if (raw[index] === '\\') index++;
      else if (raw[index] === '[') depth++;
      else if (raw[index] === ']' && --depth === 0) return index;
    }
    return -1;
  }

  function clearSectionDraftFormats() {
    const chosen = new Set([...sectionFormatTools.querySelectorAll('input:checked')].map(input => input.value));
    if (!chosen.size) return;
    editSectionDraft((token, raw, start, end, edit) => {
      if (!chosen.has(token.type)) return;
      if (token.type === 'codespan') {
        const literal = token.text.replace(/[&*_`~\[\]<>|\\#=+.!-]/g, char => '&#' + char.charCodeAt(0) + ';');
        edit(start, end, plainLinkText(literal));
        return false;
      }
      if (token.type === 'link') {
        const labelEnd = raw.startsWith('[') ? linkLabelEnd(raw) : -1;
        if (labelEnd >= 0) {
          const label = raw.slice(1, labelEnd);
          const plain = token.tokens.every(part => part.type === 'text') ? plainLinkText(label) : label;
          if (plain !== label) {
            edit(start, end, plain);
            return false;
          }
          edit(start, start + 1);
          edit(start + labelEnd, end);
        } else {
          edit(start, end, plainLinkText(token.text));
          return false;
        }
      } else {
        const width = token.type === 'strong' || (token.type === 'del' && raw.startsWith('~~')) ? 2 : 1;
        edit(start, start + width);
        edit(end - width, end);
      }
    }, '已清除所选格式');
  }

  const renameInput = byId('rename-name');
  const renameError = byId('rename-error');
  const renameConfirm = byId('rename-confirm');
  let renameFolderPath = null;

  function openRenameDialog(title, name, extension = '') {
    byId('rename-title').textContent = title;
    renameInput.value = name;
    byId('rename-extension').textContent = extension;
    renameError.textContent = '';
    renameDialog.showModal();
    renameInput.select();
  }

  function showRename() {
    if (!desktop || busy || fileDialogOpen()) return;
    if (!desktopToken) {
      setStatus('请先打开或保存笔记');
      return;
    }
    finishBlock();
    const dot = filename.lastIndexOf('.');
    renameFolderPath = null;
    openRenameDialog('重命名笔记', dot < 0 ? filename : filename.slice(0, dot), dot < 0 ? '' : filename.slice(dot));
  }

  async function renameDocument(event) {
    event.preventDefault();
    if (busy) return;
    const folderPath = renameFolderPath;
    const stem = renameInput.value.trim();
    if (!stem || stem.endsWith('.')) {
      renameError.textContent = folderPath ? '请输入有效的文件夹名称' : '请输入有效的笔记名称';
      return;
    }
    const name = stem + byId('rename-extension').textContent;
    if (!folderPath && name === filename) {
      renameDialog.close();
      return;
    }

    busy = true;
    renameConfirm.disabled = renameInput.disabled = byId('rename-cancel').disabled = true;
    renameError.textContent = '';
    let renamedNote = false;
    let movedFolder = null;
    try {
      if (folderPath) {
        const { notePath } = await desktopRequest({ action: 'rename-folder', notePath: folderPath, name });
        if (notePath) movedFolder = { from: folderPath, to: notePath };
      } else {
        const updated = renameAttachmentReferences(markdown, filename, name);
        const contents = (hasBom ? '\uFEFF' : '') + updated.replace(/\n/g, lineEnding);
        const renamed = await desktopRequest({ action: 'rename', token: desktopToken, name, contents });
        if (renamed.name) {
          markdown = savedText = source.value = updated;
          desktopToken = renamed.token;
          const selected = notesTree.querySelector('[aria-current="true"]');
          if (selected) {
            const path = selected.dataset.notePath;
            const separator = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
            movedFolder = { from: path, to: path.slice(0, separator + 1) + renamed.name };
          }
          filename = renamed.name;
          renamedNote = true;
          updateDocumentLabel();
          updateCount();
          render();
          resetEditorHistory();
          persist('已重命名并保存 ' + filename);
        }
      }
      renameDialog.close();
    } catch (error) {
      renameError.textContent = error.message;
    } finally {
      renameConfirm.disabled = renameInput.disabled = byId('rename-cancel').disabled = false;
      busy = false;
    }
    if (movedFolder) {
      if (!renamedNote) setStatus('已重命名文件夹为 ' + name);
      await loadNotes('list-notes', movedFolder);
    } else if (renamedNote) {
      loadNotes('list-notes');
    }
  }

  async function newDocument() {
    const startNew = savedName => {
      replaceDocument('', '未命名.md');
      if (savedName) setStatus('已自动保存 ' + savedName);
    };
    if (desktop) {
      if (!await switchDesktopDocument(startNew)) return;
    } else {
      if (busy || fileDialogOpen() || !canReplace()) return;
      startNew();
    }
    if (mode === 'source') source.focus();
    else if (mode === 'visual') focusVisual(paper, true);
    else focusBlock(blocks.at(-1));
  }

  function sidebarMaxWidth() {
    return Math.max(sidebarMinWidth, Math.min(520, workspace.clientWidth - editorMinWidth - 1));
  }

  function refreshSidebarWidth() {
    if (sidebar.hidden || sidebarMedia.matches) return;
    const max = sidebarMaxWidth();
    if (sidebarWidth !== null) {
      const width = Math.max(sidebarMinWidth, Math.min(max, sidebarWidth));
      workspace.style.setProperty('--sidebar-width', width + 'px');
    }
    sidebarSplitter.setAttribute('aria-valuemin', String(sidebarMinWidth));
    sidebarSplitter.setAttribute('aria-valuemax', String(max));
    sidebarSplitter.setAttribute('aria-valuenow', String(Math.round(sidebar.getBoundingClientRect().width)));
  }

  function resizeSidebar(width) {
    sidebarWidth = Math.max(sidebarMinWidth, Math.min(sidebarMaxWidth(), Math.round(width)));
    refreshSidebarWidth();
    if (active) resize(active.editor);
  }

  function finishSidebarDrag(event) {
    if (sidebarDrag?.pointer !== event.pointerId) return;
    if (sidebarDrag.changed) writeStorage(sidebarWidthKey, String(sidebarWidth));
    sidebarDrag = null;
    workspace.classList.remove('resizing-sidebar');
  }

  sidebarSplitter.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    sidebarDrag = { pointer: event.pointerId, x: event.clientX, width: sidebar.getBoundingClientRect().width, changed: false };
    sidebarSplitter.setPointerCapture(event.pointerId);
    workspace.classList.add('resizing-sidebar');
  });
  sidebarSplitter.addEventListener('pointermove', event => {
    if (sidebarDrag?.pointer !== event.pointerId) return;
    const delta = event.clientX - sidebarDrag.x;
    if (delta === 0 && !sidebarDrag.changed) return;
    sidebarDrag.changed = true;
    resizeSidebar(sidebarDrag.width + delta);
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'])
    sidebarSplitter.addEventListener(event, finishSidebarDrag);
  sidebarSplitter.addEventListener('keydown', event => {
    const width = sidebar.getBoundingClientRect().width;
    const sizes = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: sidebarMinWidth, End: sidebarMaxWidth() };
    if (!Object.hasOwn(sizes, event.key)) return;
    event.preventDefault();
    resizeSidebar(sizes[event.key]);
    writeStorage(sidebarWidthKey, String(sidebarWidth));
  });

  function toggleSidebar(visible = sidebar.hidden) {
    sidebar.hidden = sidebarSplitter.hidden = !visible;
    byId('sidebar-toggle').setAttribute('aria-pressed', String(visible));
    refreshSidebarWidth();
  }

  function showOutline() {
    toggleSidebar(true);
    showSidebarView(false);
  }

  function toggleSourceMode() {
    setMode(mode === 'source' ? writingMode : 'source');
  }

  function clipboardMarkdown(html) {
    const fragment = /<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/i.exec(html)?.[1] ?? html.slice(html.indexOf('<'));
    const safe = DOMPurify.sanitize(fragment, {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: ['a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4',
        'h5', 'h6', 'hr', 'i', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'strong', 'sub', 'sup',
        'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul'],
      ALLOWED_ATTR: ['href', 'title', 'class', 'start', 'align'],
      ALLOW_DATA_ATTR: false,
    });
    if (!safe.querySelector('a[href],b,blockquote,code,del,em,h1,h2,h3,h4,h5,h6,hr,i,kbd,mark,ol,pre,s,strong,sub,sup,table,u,ul'))
      return '';
    for (const heading of safe.querySelectorAll('h1')) {
      const replacement = document.createElement('h2');
      replacement.append(...heading.childNodes);
      heading.replaceWith(replacement);
    }
    return visualMarkdown.serialize(safe);
  }

  function pasteTarget() {
    if (mode === 'source') return source;
    if (mode === 'write') {
      if (!active) focusBlock(blockAt(cursor));
      return active.editor;
    }
    if (!paper.contains(getSelection().focusNode)) focusVisual(paper, true);
    return paper;
  }

  function markdownBlockSeparator(left, right) {
    if (!left || !right) return '';
    const existing = (left.match(/\n{1,2}$/)?.[0].length ?? 0) + (right.match(/^\n{1,2}/)?.[0].length ?? 0);
    return '\n'.repeat(Math.max(0, 2 - existing));
  }

  function joinMarkdownBlocks(left, right) {
    return left + markdownBlockSeparator(left, right) + right;
  }

  function plainPasteMarkdown(text) {
    const paragraph = document.createElement('p');
    return text.split('\n').map(line => {
      paragraph.textContent = line;
      return visualMarkdown.serialize(paragraph);
    }).join('\n');
  }

  function pasteVisualBlocks(range, formatted, selectPastedHeadings) {
    const sourceSide = before => {
      if (!range) return before ? markdown : '';
      const container = before ? range.startContainer : range.endContainer;
      const offset = before ? range.startOffset : range.endOffset;
      const section = visualRangeAt(container);
      if (!section) {
        let next = container === paper ? paper.childNodes[offset] : container;
        while (next && next.parentNode !== paper) next = next.parentNode;
        while (next && !visual.ranges.has(next)) next = next.nextSibling;
        const index = visual.ranges.get(next)?.start ?? markdown.length;
        return before ? markdown.slice(0, index) : markdown.slice(index);
      }
      const side = document.createRange();
      side.selectNode(section.element);
      if (before) side.setEnd(container, offset);
      else side.setStart(container, offset);
      const fragment = side.cloneContents();
      const sources = new Map([...section.element.querySelectorAll('img[src]')].map(image =>
        [image.getAttribute('src'), visualMarkdown.imageSource(image)]));
      for (const image of fragment.querySelectorAll('img[src]')) {
        const src = sources.get(image.getAttribute('src'));
        if (src != null) visualMarkdown.rememberImage(image, src);
      }
      const partial = visualMarkdown.serialize(fragment);
      return before ? joinMarkdownBlocks(markdown.slice(0, section.start), partial) :
        joinMarkdownBlocks(partial, markdown.slice(section.end));
    };
    captureVisualCaret();
    const inserted = joinMarkdownBlocks(sourceSide(true), formatted);
    const insertedStart = inserted.length - formatted.length;
    markdown = joinMarkdownBlocks(inserted, sourceSide(false));
    cursor = inserted.length;
    const tokens = marked.lexer(markdown);
    render(tokens);
    updateCount();
    persist();
    if (selectPastedHeadings && selectVisualSourceSpan(insertedStart, inserted.length)) {
      [...textSelectionBlocks][0]?.scrollIntoView({ block: 'nearest' });
    } else {
      const target = blockAt(cursor).element ?? paper;
      target.scrollIntoView({ block: 'nearest' });
      focusVisual(target, true);
    }
    rememberEditorChange();
    return { start: insertedStart, end: inserted.length };
  }

  async function pasteEditor(action) {
    if (busy || main.inert || fileDialogOpen() || !blocks.length) return;
    const editor = pasteTarget();
    const textarea = editor instanceof HTMLTextAreaElement;
    const start = textarea ? editor.selectionStart : null;
    const end = textarea ? editor.selectionEnd : null;
    const selection = getSelection();
    const range = !textarea && selection.rangeCount && editor.contains(selection.anchorNode) &&
      editor.contains(selection.focusNode) ? selection.getRangeAt(0).cloneRange() : null;
    if (range && revealFoldedSelection(range)) return;
    let reviewRange;
    busy = main.inert = true;
    try {
      const read = () => desktopRequest({ action: 'paste-editor', token: desktopToken, plainText: action !== 'paste' });
      let result = await read();
      if (result.needsImageDestination) {
        setStatus('请先选择笔记的保存位置，以便存放图片');
        if (!await saveCurrentDocument()) return;
        result = await read();
        if (result.needsImageDestination) throw new Error('无法确定图床位置，请重新粘贴。');
      }
      const text = (result.contents ?? '').replace(/\r\n?/g, '\n');
      const images = result.pastedImages ?? [];
      let formatted = '';
      if (images.length) {
        formatted = images.map(path => '![粘贴图片](<' + encodeAssetPath(path) + '>)').join('\n\n');
      } else if (action === 'paste-code' && text) {
        formatted = visualMarkdown.fenceCode(text);
      } else if (action === 'paste') {
        formatted = result.clipboardHtml ? clipboardMarkdown(result.clipboardHtml) : '';
        if (visual && /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:=+|-+)[ \t]*$)/m.test(text) &&
            !marked.lexer(formatted).some(token => token.type === 'heading') &&
            marked.lexer(text).some(token => token.type === 'heading')) formatted = text;
        if (!formatted && /^\s*(?:`{3,}|~{3,})/.test(text) &&
            marked.lexer(text).some(token => token.type === 'code')) formatted = text;
      }
      if (!formatted && !text) {
        setStatus('剪贴板中没有可粘贴的图片或文本');
        return;
      }
      const formattedTokens = formatted ? marked.lexer(formatted) : [];
      const blockPaste = formattedTokens.some(token => !['paragraph', 'space'].includes(token.type));

      main.inert = false;
      editor.focus({ preventScroll: true });
      if (textarea) {
        editor.setSelectionRange(start, end);
        let value = formatted || text;
        if (blockPaste) {
          const preceding = editor.value.slice(0, start);
          if (preceding) value = '\n'.repeat(2 - (preceding.match(/\n{1,2}$/)?.[0].length ?? 0)) + value;
          const following = editor.value.slice(end);
          if (following) value += '\n'.repeat(2 - (following.match(/^\n{1,2}/)?.[0].length ?? 0));
        }
        if (!document.execCommand('insertText', false, value)) {
          editor.setRangeText(value, start, end, 'end');
          recordInput(editor);
        }
      } else {
        if (range) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        const container = selection.anchorNode;
        const element = container instanceof Element ? container : container?.parentElement;
        const insideCode = element?.closest('pre') && !images.length;
        const pastedText = text.trim() || formatted.trim();
        const reviewPaste = action === 'paste' && !images.length &&
          !element?.closest('pre,td,th,li,blockquote') &&
          (pastedText.length >= 800 || pastedText.split('\n').filter(line => line.trim()).length >= 10);
        if (reviewPaste) {
          reviewRange = pasteVisualBlocks(range, formatted || plainPasteMarkdown(text), true);
        } else if (blockPaste && !insideCode) {
          pasteVisualBlocks(range, formatted, formattedTokens.some(token => token.type === 'heading'));
        } else if (formatted && !insideCode) {
          const existingImages = new Set(editor.querySelectorAll('img'));
          const tokens = formattedTokens.flatMap(token => visualMarkdown.paragraphLines(token).map(line => line.token));
          const safe = DOMPurify.sanitize(marked.parser(tokens), {
            USE_PROFILES: { html: true },
            FORBID_TAGS: ['style', 'form', 'button', 'textarea'],
            FORBID_ATTR: ['style', 'srcset'],
            ALLOW_DATA_ATTR: false,
          });
          if (!document.execCommand('insertHTML', false, safe)) throw new Error('无法在当前位置粘贴。');
          for (const image of editor.querySelectorAll('img[src]')) {
            if (!existingImages.has(image)) prepareNoteImage(image);
          }
          recordVisualInput();
        } else if (!insideCode && text.includes('\n') && visualBlockAt(container)?.matches('ul,ol,blockquote,table')) {
          const escaped = document.createElement('span');
          escaped.textContent = text;
          document.execCommand('insertHTML', false, escaped.innerHTML.replaceAll('\n', '<br>'));
        } else {
          document.execCommand('insertText', false, text);
        }
      }
      if (images.length) setStatus(`已粘贴 ${images.length} 张图片，记得保存笔记`);
    } catch (error) {
      setStatus(error.message);
    } finally {
      busy = main.inert = false;
    }
    if (reviewRange && visual && !fileDialogOpen()) {
      const { start, end } = reviewRange;
      const pasted = visualSourceRanges(start, end);
      if (pasted.length) showSectionEditor({ element: pasted[0].element, last: pasted.at(-1).element, start, end, pasted: true });
    }
  }

  async function runEditMenu(action) {
    const currentEditor = () => mode === 'source' ? source : active?.editor ?? visual?.editor;
    let editor = currentEditor();
    if (['paste', 'paste-plain', 'paste-code'].includes(action)) {
      await pasteEditor(action);
      return;
    }
    if (action === 'undo' || action === 'redo') {
      stepEditorHistory(action === 'redo');
      return;
    }
    if (action === 'select-all') {
      if (editor) {
        editor.focus();
        document.execCommand('selectAll');
      } else {
        const range = document.createRange();
        range.selectNodeContents(paper);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
      return;
    }
    if (action !== 'cut' && action !== 'copy') return;

    const selection = getSelection();
    const textarea = editor instanceof HTMLTextAreaElement ? editor : null;
    const start = textarea?.selectionStart;
    const end = textarea?.selectionEnd;
    const range = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const selected = textarea ? textarea.value.slice(start, end) : selection.toString();
    if (!selected) return;
    if (action === 'cut' && range && revealFoldedSelection(range)) return;
    const snapshot = markdown;
    busy = true;
    try {
      await desktopRequest({ action: 'copy-editor-text', contents: selected });
      if (action !== 'cut' || !editor || editor !== currentEditor() || snapshot !== markdown) return;
      const currentRange = selection.rangeCount ? selection.getRangeAt(0) : null;
      if (textarea ? start !== textarea.selectionStart || end !== textarea.selectionEnd :
        !editor.isContentEditable || !range || !currentRange ||
        !editor.contains(range.startContainer) || !editor.contains(range.endContainer) ||
        range.compareBoundaryPoints(Range.START_TO_START, currentRange) !== 0 ||
        range.compareBoundaryPoints(Range.END_TO_END, currentRange) !== 0) return;
      editor.focus();
      document.execCommand('delete');
    } catch (error) {
      setStatus(error.message);
    } finally {
      busy = false;
    }
  }

  if (desktop) document.addEventListener('scripta-menu', event => {
    if (busy || main.inert || fileDialogOpen()) return;
    const { action } = event.detail;
    if (action.startsWith('format:')) format(action.slice(7));
    else if (action.startsWith('mode:')) setMode(action.slice(5));
    else if (action === 'toggle-source') toggleSourceMode();
    else if (action === 'toggle-sidebar') toggleSidebar();
    else if (action === 'show-outline') showOutline();
    else if (action === 'choose-notes') {
      toggleSidebar(true);
      showSidebarView(true);
      void loadNotes(action);
    }
    else void runEditMenu(action);
  });

  function setTheme(dark) {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    byId('theme').textContent = dark ? '☼  浅色模式' : '◐  深色模式';
    desktop?.postMessage({ action: 'theme', dark });
  }

  function applyDocumentDisplaySettings({ fontSize, documentWidth } = displaySettings) {
    const style = document.documentElement.style;
    if (fontSize !== undefined) style.setProperty('--document-font-size', fontSize + 'px');
    if (documentWidth !== undefined) style.setProperty('--document-width', documentWidth + 'px');
    if (active) resize(active.editor);
    scheduleBlockLayout();
    scheduleSectionShading();
  }

  function updateStartupWindowFields() {
    const custom = windowMode.value === 'custom';
    byId('startup-window-size').hidden = !custom;
    windowWidth.disabled = windowHeight.disabled = !custom;
  }

  byId('display-settings').addEventListener('click', () => {
    if (busy || fileDialogOpen()) return;
    byId('startup-window-settings').hidden = !desktop;
    byId('startup-outline-setting').hidden = !desktop;
    windowMode.value = displaySettings.windowMode;
    windowWidth.value = displaySettings.windowWidth;
    windowHeight.value = displaySettings.windowHeight;
    fontSizeInput.value = displaySettings.fontSize;
    documentWidthInput.value = displaySettings.documentWidth;
    startupOutlineInput.checked = displaySettings.openOutlineByDefault;
    startupBlockLabelsInput.checked = displaySettings.showBlockLabelsByDefault;
    displayError.textContent = '';
    updateStartupWindowFields();
    displayDialog.showModal();
  });
  windowMode.addEventListener('change', updateStartupWindowFields);
  for (const [input, setting] of [[fontSizeInput, 'fontSize'], [documentWidthInput, 'documentWidth']]) {
    input.addEventListener('input', () => {
      if (!busy && displayDialog.open && input.validity.valid) {
        applyDocumentDisplaySettings({ [setting]: input.valueAsNumber });
      }
    });
  }
  byId('display-cancel').addEventListener('click', () => displayDialog.close());
  displayDialog.addEventListener('cancel', event => {
    if (busy) event.preventDefault();
  });
  displayDialog.addEventListener('close', () => applyDocumentDisplaySettings());
  displayForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const settings = {
      windowMode: windowMode.value,
      windowWidth: windowWidth.disabled ? displaySettings.windowWidth : windowWidth.valueAsNumber,
      windowHeight: windowHeight.disabled ? displaySettings.windowHeight : windowHeight.valueAsNumber,
      fontSize: fontSizeInput.valueAsNumber,
      documentWidth: documentWidthInput.valueAsNumber,
      openOutlineByDefault: startupOutlineInput.checked,
      showBlockLabelsByDefault: startupBlockLabelsInput.checked,
    };
    const save = byId('display-save');
    const cancel = byId('display-cancel');
    busy = save.disabled = cancel.disabled = fontSizeInput.disabled = documentWidthInput.disabled = true;
    displayError.textContent = '';
    try {
      if (desktop) await desktopRequest({ action: 'save-display-settings', displaySettings: settings });
      else if (!writeStorage(fontSizeKey, String(settings.fontSize)) ||
          !writeStorage(documentWidthKey, String(settings.documentWidth)) ||
          !writeStorage(blockLabelsDefaultKey, String(settings.showBlockLabelsByDefault))) throw new Error('无法保存显示设置。');
      if (desktop && settings.openOutlineByDefault !== displaySettings.openOutlineByDefault) {
        setEditorOutline(settings.openOutlineByDefault);
      }
      if (settings.showBlockLabelsByDefault !== displaySettings.showBlockLabelsByDefault) {
        setBlockLabels(settings.showBlockLabelsByDefault);
      }
      displaySettings = settings;
      displayDialog.close();
    } catch (error) {
      displayError.textContent = error.message;
    } finally {
      busy = save.disabled = cancel.disabled = fontSizeInput.disabled = documentWidthInput.disabled = false;
    }
  });

  const commitInput = byId('commit-message');
  const commitStatus = byId('commit-status');
  const commitConfirm = byId('commit-confirm');
  const commitCancel = byId('commit-cancel');
  const commitDetails = byId('commit-details');

  function showCommitChanges(commit, changed = false) {
    const files = commit.changes.map(({ path, kind }) => {
      const item = document.createElement('li');
      const status = document.createElement('span');
      status.textContent = kind;
      item.append(status, path);
      return item;
    });
    byId('commit-files').replaceChildren(...files);
    commitInput.value = commit.message;
    commitDetails.hidden = files.length === 0;
    commitConfirm.disabled = commitDetails.hidden;
    commitStatus.textContent = files.length === 0 ? '没有可提交的笔记变更。' :
      changed ? '文件列表已变化，请重新检查后提交。' : '';
    if (files.length) commitInput.focus();
  }

  async function showCommit() {
    if (busy || fileDialogOpen()) return;
    finishBlock();
    byId('commit-draft').hidden = markdown === savedText;
    commitDetails.hidden = commitConfirm.disabled = true;
    commitStatus.textContent = '正在检查笔记变更…';
    commitDialog.showModal();
    busy = true;
    try {
      const { commit } = await desktopRequest({ action: 'prepare-commit' });
      if (commitDialog.open) showCommitChanges(commit);
    } catch (error) {
      commitStatus.textContent = error.message;
    } finally {
      busy = false;
    }
  }

  async function submitCommit(event) {
    event.preventDefault();
    if (busy || commitDetails.hidden) return;
    const commitMessage = commitInput.value.trim();
    if (!commitMessage) {
      commitStatus.textContent = '请填写提交说明。';
      commitInput.focus();
      return;
    }
    busy = true;
    commitCancel.disabled = commitConfirm.disabled = commitInput.disabled = true;
    commitStatus.textContent = '正在提交笔记…';
    try {
      const result = await desktopRequest({ action: 'commit-notes', commitMessage });
      commitInput.disabled = false;
      if (result.commit) showCommitChanges(result.commit, true);
      else {
        commitDialog.close();
        setStatus(result.commitHash ? '已提交笔记 ' + result.commitHash : '已提交笔记');
      }
    } catch (error) {
      commitStatus.textContent = error.message;
    } finally {
      commitCancel.disabled = commitInput.disabled = false;
      commitConfirm.disabled = commitDetails.hidden;
      busy = false;
    }
  }

  byId('theme').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    setTheme(dark);
    writeStorage(themeKey, dark ? 'dark' : 'light');
  });
  byId('sidebar-toggle').addEventListener('click', () => toggleSidebar());
  if (desktop) {
    byId('note-icon-close').addEventListener('click', () => noteIconDialog.close());
    byId('note-folder-actions').hidden = false;
    for (const action of ['open-note-assets', 'open-note-references']) {
      const button = byId(action);
      button.addEventListener('click', async () => {
        if (busy || fileDialogOpen()) return;
        if (!desktopToken) {
          setStatus('请先打开或保存笔记。');
          return;
        }
        busy = true;
        let createdFolder;
        try {
          ({ notePath: createdFolder } = await desktopRequest({ action, token: desktopToken }));
        } catch (error) {
          setStatus(error.message);
        } finally {
          busy = false;
        }
        if (createdFolder) await loadNotes('list-notes');
      });
    }
    byId('sidebar-views').hidden = false;
    editorOutlineToggle.hidden = false;
    editorOutlineToggle.addEventListener('click', () => setEditorOutline(editorOutlineSlot.hidden));
    outlineDepth.value = Number.isFinite(outlineMaxDepth) ? String(outlineMaxDepth) : '';
    outlineDepth.hidden = false;
    outlineDepth.addEventListener('change', () => {
      outlineMaxDepth = Number(outlineDepth.value) || Infinity;
      writeStorage(outlineDepthKey, outlineDepth.value);
      outlineOverrides.clear();
      outlineSmartActive = false;
      updateOutlineFolding();
    });
    outlineSmart.addEventListener('click', () => {
      outlineOverrides.clear();
      outlineSmartActive = true;
      updateOutlineFolding();
    });
    outlineCollapse.addEventListener('click', () => {
      const collapse = outlineBranches.some(({ group }) => !group.hidden);
      outlineSmartActive = false;
      outlineOverrides.clear();
      if (collapse) for (const { id } of outlineBranches) outlineOverrides.set(id, true);
      updateOutlineFolding();
    });
    showSidebarView(true);
    byId('notes').addEventListener('click', () => {
      if (fileDialogOpen()) return;
      toggleSidebar(true);
      showSidebarView(true);
      void showRepositorySync();
    });
    repositoryView.addEventListener('click', () => showSidebarView(true));
    outlineView.addEventListener('click', () => showSidebarView(false));
    byId('notes-refresh').addEventListener('click', () => refreshRepository());
    byId('notes-new-file').addEventListener('click', () => showRepositoryCreation(false));
    byId('notes-new-folder').addEventListener('click', () => showRepositoryCreation(true));
    byId('notes-collapse').addEventListener('click', () => {
      for (const folder of notesTree.querySelectorAll('details[open]')) folder.open = false;
      selectRepositoryFolder('');
    });
    repositoryRoot.addEventListener('click', () => {
      selectRepositoryFolder('');
      void showRepositorySync();
    });
    repositoryRoot.addEventListener('keydown', event => {
      if (noteClipboard && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        event.stopPropagation();
        pasteRepositoryEntry('');
      }
    });
    notesTree.addEventListener('click', event => {
      if (busy || fileDialogOpen()) return;
      const row = event.target.closest('button[data-note-path]');
      if (row) {
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
          event.preventDefault();
          const path = row.dataset.notePath;
          if (!selectedNotePaths.size) {
            const current = notesTree.querySelector('button[data-note-path][aria-current="true"]');
            if (current && current !== row) selectedNotePaths.add(current.dataset.notePath);
          }
          if (!selectedNotePaths.delete(path)) selectedNotePaths.add(path);
          updateNoteSelection();
        } else {
          void openRepositoryNote(row);
        }
        return;
      }
      const folder = event.target.closest('summary')?.parentElement;
      if (folder) selectRepositoryFolder(folder.dataset.path);
      else clearNoteSelection();
    });
    notesCreate.addEventListener('submit', createRepositoryEntry);
    byId('notes-create-cancel').addEventListener('click', closeRepositoryCreation);
    notesCreate.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeRepositoryCreation();
    });
    notesChoose.addEventListener('click', () => loadNotes('choose-notes'));
    byId('open-repository').addEventListener('click', showRepositorySync);
    localModeButton.addEventListener('click', () => switchRepositoryMode(false));
    directModeButton.addEventListener('click', () => switchRepositoryMode(true));
    setupGitButton.addEventListener('click', setupGit);
    byId('repository-sync-form').addEventListener('submit', event => {
      event.preventDefault();
      if (event.submitter === syncClone) void transferRepository('clone-github', { query: syncUrl.value });
      else void runRepositorySync('bind-github', syncUrl.value);
    });
    syncRefresh.addEventListener('click', async () => {
      if (busy || pullState) return;
      const notice = await refreshRepository(true);
      syncStatus.textContent = notice || '已刷新本地笔记。';
    });
    syncDesktop.addEventListener('click', () => runRepositorySync('open-github-desktop'));
    syncExplorer.addEventListener('click', () => runRepositorySync('open-notes-root'));
    syncPull.addEventListener('click', () => transferRepository('pull-github'));
    syncPush.addEventListener('click', () => transferRepository('push-github'));
    partialChoose.addEventListener('click', choosePartialFolder);
    byId('repository-partial').addEventListener('toggle', event => {
      if (!event.currentTarget.open) return;
      if (!pullState) syncStatus.textContent = '';
      partialForm.scrollIntoView({ block: 'nearest' });
    });
    partialForm.addEventListener('submit', event => {
      event.preventDefault();
      void transferRepository('pull-github-partial', { query: partialUrl.value.trim(), notePath: partialPath.value.trim() });
    });
    pullCancel.addEventListener('click', cancelRepositoryPull);
    byId('repository-sync-close').addEventListener('click', closeRepositorySync);
    syncDialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeRepositorySync();
    });
    syncChoose.addEventListener('click', async () => {
      if (busy) return;
      await loadNotes('choose-notes');
      if (syncDialog.open) await readRepositoryMode();
    });
    syncUnbind.addEventListener('click', async () => {
      if (busy || pullState) return;
      if (await loadNotes('unbind-notes') === false) {
        syncStatus.textContent = notesStatus.textContent;
        return;
      }
      renderRepositorySync({});
      syncStatus.textContent = '已解除本地文件夹绑定。';
      if (syncDialog.open) syncChoose.focus();
    });
    notesTree.addEventListener('dragstart', startNoteDrag);
    repositoryPanel.addEventListener('dragover', event => {
      const externalFiles = event.dataTransfer.types.includes('Files');
      const hovering = (externalFiles || draggedEntry) && !busy && !fileDialogOpen()
        ? event.target.closest('summary')?.parentElement : null;
      expandFolderOnHover(hovering ?? null);
      if (externalFiles) {
        const folder = resourceDropTarget(event.target);
        highlightDropFolder(folder?.querySelector('summary'));
        event.preventDefault();
        event.dataTransfer.dropEffect = folder ? 'copy' : 'none';
        return;
      }
      const target = noteDropTarget(event.target);
      highlightDropFolder(target?.row);
      if (!target) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = event.ctrlKey ? 'copy' : 'move';
    });
    repositoryPanel.addEventListener('dragleave', event => {
      if (!repositoryPanel.contains(event.relatedTarget)) clearDropTarget();
    });
    repositoryPanel.addEventListener('drop', event => {
      if (event.dataTransfer.types.includes('Files')) void dropResourceFiles(event);
      else void dropNote(event);
    });
    document.addEventListener('dragend', () => {
      draggedEntry = null;
      clearDropTarget();
    });
    notesTree.addEventListener('contextmenu', event => {
      const target = event.target.closest('summary, button[data-note-path]');
      if (!target) return;
      event.preventDefault();
      showNoteMenu(target, event.clientX, event.clientY);
    });
    notesTree.addEventListener('keydown', event => {
      const target = event.target.closest('summary, button[data-note-path]');
      if (!target) return;
      const folder = target.matches('summary');
      if (event.key === 'Escape' && noteMenu.hidden && selectedNotePaths.size) {
        event.preventDefault();
        event.stopPropagation();
        clearNoteSelection();
        return;
      }
      const selected = !folder && selectedNotePaths.has(target.dataset.notePath) ? [...selectedNotePaths] : [];
      if (event.key === 'F2' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        if (selected.length < 2 && !event.repeat && !event.isComposing) {
          const path = folder ? target.parentElement.dataset.path : target.dataset.notePath;
          void runNoteMenuAction(folder ? 'rename-folder' : 'rename-note', target, path, folder);
        }
        return;
      }
      const shortcuts = { x: 'cut-note', c: 'copy-tree-note', v: 'paste-note' };
      const action = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
        ? shortcuts[event.key.toLowerCase()] : null;
      if (action && (action !== 'paste-note' || noteClipboard)) {
        event.preventDefault();
        event.stopPropagation();
        if (selected.length > 1 && action !== 'paste-note') runSelectedNoteAction(action, selected);
        else runNoteMenuAction(action, target, folder ? target.parentElement.dataset.path : target.dataset.notePath, folder);
        return;
      }
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault();
      const bounds = target.getBoundingClientRect();
      showNoteMenu(target, bounds.left, bounds.bottom);
    });
    byId('import-pdf').addEventListener('click', () => importAsMarkdown('import-pdf', 'PDF'));
    byId('import-pdf-with-source').addEventListener('click', () => importAsMarkdown('import-pdf-with-source', 'PDF'));
    byId('import-wps-docx').addEventListener('click', () => importAsMarkdown('import-wps-docx', 'WPS 智能文档'));
    byId('notes-search').addEventListener('click', showNoteSearch);
    byId('note-search-close').addEventListener('click', () => searchDialog.close());
    searchQuery.addEventListener('input', event => {
      if (!event.isComposing) scheduleNoteSearch();
    });
    searchQuery.addEventListener('compositionend', scheduleNoteSearch);
    searchDialog.addEventListener('close', () => clearTimeout(searchTimer));
    searchDialog.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      const buttons = [...searchResults.querySelectorAll('button')];
      if (!buttons.length) return;
      const current = buttons.indexOf(document.activeElement);
      if (event.target === searchQuery && event.key === 'Enter') {
        event.preventDefault();
        buttons[0].click();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (event.target !== searchQuery && current < 0) return;
        event.preventDefault();
        if (event.key === 'ArrowUp' && current === 0) searchQuery.focus();
        else buttons[Math.min(buttons.length - 1, Math.max(0, current + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
      }
    });
    byId('merge-notes').addEventListener('click', () => mergeNotes());
    byId('export-markdown').addEventListener('click', exportMarkdown);
    byId('commit').addEventListener('click', showCommit);
    byId('commit-form').addEventListener('submit', submitCommit);
    commitCancel.addEventListener('click', () => commitDialog.close());
    commitDialog.addEventListener('cancel', event => { if (commitCancel.disabled) event.preventDefault(); });
  }
  function handleNoteMenuKeys(event) {
    const menu = event.currentTarget;
    if (menu === noteMoveMenu && (event.key === 'Escape' || event.key === 'ArrowLeft')) {
      event.preventDefault();
      closeNoteMoveMenu(true);
      return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      closeNoteMenu(true);
      if (event.key === 'Escape') event.preventDefault();
      return;
    }
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    const next = {
      ArrowDown: (current + 1) % items.length,
      ArrowUp: (current + items.length - 1) % items.length,
      Home: 0,
      End: items.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    if (menu === noteMenu) closeNoteMoveMenu();
    items[next].focus();
  }
  noteMenu.addEventListener('keydown', handleNoteMenuKeys);
  noteMoveMenu.addEventListener('keydown', handleNoteMenuKeys);
  noteMenu.addEventListener('scroll', () => closeNoteMoveMenu(), { passive: true });
  paper.addEventListener('contextmenu', event => {
    if (desktop) showImageMenu(event);
    if (!event.defaultPrevented && showTableMenu(event.target.closest('td, th'), event.clientX, event.clientY)) {
      event.preventDefault();
    }
  });
  document.addEventListener('pointerdown', event => {
    if (!noteMenu.contains(event.target) && !noteMoveMenu.contains(event.target)) closeNoteMenu();
  });
  window.addEventListener('blur', () => closeNoteMenu());
  window.addEventListener('resize', () => closeNoteMenu());
  window.addEventListener('scroll', event => {
    if (!noteMenu.contains(event.target) && !noteMoveMenu.contains(event.target)) closeNoteMenu();
  }, true);
  newButton.addEventListener('click', newDocument);
  byId('open').addEventListener('click', openDocument);
  saveButton.addEventListener('click', saveDocument);
  byId('rename').addEventListener('click', showRename);
  byId('rename-form').addEventListener('submit', renameDocument);
  byId('rename-cancel').addEventListener('click', () => renameDialog.close());
  renameDialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  byId('write-mode').addEventListener('click', () => setMode('write'));
  byId('visual-mode').addEventListener('click', () => setMode('visual'));
  byId('source-mode').addEventListener('click', () => setMode('source'));
  byId('file').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file || busy) return;
    busy = true;
    try {
      await useFile(file);
    } catch {
      setStatus('打开失败，请选择 UTF-8 编码的 Markdown 文件');
    } finally {
      busy = false;
    }
  });
  for (const button of document.querySelectorAll('[data-format]')) {
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => format(button.dataset.format));
  }
  const undoButton = byId('undo-edit');
  undoButton.addEventListener('mousedown', event => event.preventDefault());
  undoButton.addEventListener('click', () => {
    if (!busy && !fileDialogOpen()) stepEditorHistory(false);
  });
  source.addEventListener('input', event => recordInput(source, event.inputType));
  source.addEventListener('beforeinput', handleHistoryInput);
  paper.addEventListener('focus', () => {
    if (visual) document.execCommand('defaultParagraphSeparator', false, 'p');
    scheduleBlockLayout();
  });
  paper.addEventListener('blur', () => {
    updateTextSelectionBlocks();
    scheduleBlockLayout();
  });
  paper.addEventListener('beforeinput', event => {
    if (!visual) return;
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault();
      stepEditorHistory(event.inputType === 'historyRedo');
      return;
    }
    captureVisualCaret();
    const range = getSelection().rangeCount && getSelection().getRangeAt(0);
    if (event.cancelable && !event.isComposing && event.inputType === 'deleteContentBackward' &&
        range?.collapsed && removeVisualPrefix(range)) {
      event.preventDefault();
      return;
    }
    if (!event.isComposing && range && !range.collapsed && revealFoldedSelection(range)) event.preventDefault();
  });
  paper.addEventListener('input', recordVisualInput);
  viewport.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    if (event.target === sectionEditButton || event.target === sectionMoveHandle) return;
    setSectionHover(foldHeadingTargets.get(event.target) ?? visualBlockAt(event.target));
  });
  viewport.addEventListener('pointermove', event => {
    if (!visual || blockControls.contains(event.target)) return;
    const target = visualBlockAt(event.target);
    if (blockHover === target) return;
    blockHover = target;
    scheduleBlockLayout();
  });
  viewport.addEventListener('pointerleave', () => {
    blockHover = null;
    setSectionHover(null);
    scheduleBlockLayout();
  });
  viewport.addEventListener('scroll', () => {
    scheduleBlockLayout();
    if (sectionHover || sectionEdit || sectionDrag) scheduleSectionShading();
  }, { passive: true });
  new ResizeObserver(scheduleBlockLayout).observe(viewport);
  const sectionLayoutObserver = new ResizeObserver(scheduleSectionShading);
  for (const element of [paper, viewport, sectionEditDialog]) sectionLayoutObserver.observe(element);
  paper.addEventListener('load', () => {
    scheduleBlockLayout();
    scheduleSectionShading();
  }, true);
  blockHandle.addEventListener('mousedown', event => event.preventDefault());
  blockHandle.addEventListener('click', () => showBlockMenu());
  function setBlockLabels(visible) {
    closeBlockMenu();
    showBlockLabels = visible;
    blockLabelToggle.setAttribute('aria-pressed', String(showBlockLabels));
    scheduleBlockLayout();
  }
  blockLabelToggle.addEventListener('click', () => setBlockLabels(!showBlockLabels));
  sectionEditButton.addEventListener('mousedown', event => event.preventDefault());
  sectionEditButton.addEventListener('click', openSectionEditor);
  sectionMoveHandle.addEventListener('pointerdown', startSectionDrag);
  viewport.addEventListener('pointermove', event => {
    if (event.pointerId !== sectionDrag?.pointer) return;
    sectionDrag.x = event.clientX;
    sectionDrag.y = event.clientY;
  });
  viewport.addEventListener('pointerup', event => {
    if (event.pointerId !== sectionDrag?.pointer) return;
    sectionDrag.x = event.clientX;
    sectionDrag.y = event.clientY;
    const view = viewport.getBoundingClientRect();
    locateSectionDrop(view, sectionPointerInside(sectionDrag, view));
    finishSectionDrag(true);
  });
  viewport.addEventListener('lostpointercapture', event => {
    if (event.target === viewport && event.pointerId === sectionDrag?.pointer) finishSectionDrag(false);
  });
  byId('section-promote').addEventListener('click', () => shiftSectionDraftHeadings(-1));
  byId('section-demote').addEventListener('click', () => shiftSectionDraftHeadings(1));
  sectionFormatTools.addEventListener('change', () => {
    sectionClearFormat.disabled = !sectionFormatTools.querySelector('input:checked');
  });
  sectionClearFormat.addEventListener('click', clearSectionDraftFormats);
  function finishSectionEdit(apply) {
    if (!sectionEdit) return;
    const { element, original, preview, scroll, start, pasted, controls } = sectionEdit;
    if (apply && (busy || !visual)) return;
    if (apply && markdown !== original) {
      sectionEditError.textContent = '笔记内容已变化，请关闭后重新打开整段编辑。';
      return;
    }
    const updated = apply ? sectionDraftDocument(sectionEdit) : markdown;
    sectionEditDialog.close();
    sectionEdit = null;
    for (const control of controls) control.inert = false;
    if (updated !== markdown) {
      markdown = updated;
      cursor = start;
      render();
      focusVisual(blockAt(cursor).element ?? paper);
      updateEditedDocument();
      rememberEditorChange();
      setStatus(pasted ? '已应用粘贴内容的修改' : '已应用章节修改');
    } else if (visual && preview !== markdown) {
      render();
      if (markdown === original) viewport.scrollTop = scroll;
    }
    if (visual && markdown === original)
      focusVisual(element?.parentNode === paper ? element : blockAt(start).element ?? paper);
    scheduleSectionShading();
  }
  byId('section-edit-cancel').addEventListener('click', () => finishSectionEdit(false));
  byId('section-edit-form').addEventListener('submit', event => {
    event.preventDefault();
    finishSectionEdit(true);
  });
  blockControls.addEventListener('focusout', scheduleBlockLayout);
  headingTools.addEventListener('focusin', () => {
    updateTextSelectionBlocks();
    scheduleBlockLayout();
  });
  headingTools.addEventListener('focusout', event => {
    if (!headingTools.contains(event.relatedTarget)) headingToolsRange = null;
    updateTextSelectionBlocks();
    scheduleBlockLayout();
  });
  headingTools.addEventListener('mousedown', event => event.preventDefault());
  for (const button of headingButtons) {
    button.addEventListener('click', () => applyHeadingChange(button.dataset.headingChange));
  }
  function restoreHeadingToolsSelection() {
    const range = headingToolsRange;
    if (!range || !paper.contains(range.commonAncestorContainer)) return;
    paper.focus({ preventScroll: true });
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    updateTextSelectionBlocks();
  }
  for (const button of selectionTextButtons) {
    button.addEventListener('click', () => {
      if (!visual || busy) return;
      restoreHeadingToolsSelection();
      const action = button.dataset.selectionAction;
      if (action === 'copy') {
        if (desktop && getSelection().toString()) void runEditMenu('copy');
        else document.execCommand('copy');
      } else {
        format(action);
      }
    });
  }
  headingTools.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    restoreHeadingToolsSelection();
  });
  document.addEventListener('pointerdown', event => {
    if (menuBlock && !blockMenu.contains(event.target) && event.target !== menuAnchor && event.target !== blockHandle) closeBlockMenu();
    if (!paper.contains(event.target)) editorTyping = null;
  });
  blockMenu.addEventListener('focusout', event => {
    if (!blockMenu.contains(event.relatedTarget) && event.relatedTarget !== menuAnchor && event.relatedTarget !== blockHandle) closeBlockMenu();
  });
  blockMenu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeBlockMenu(true);
      return;
    }
    const items = [...blockMenu.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const next = {
      ArrowDown: (index + 1) % items.length,
      ArrowUp: (index + items.length - 1) % items.length,
      Home: 0,
      End: items.length - 1,
    }[event.key];
    if (next === undefined || !items.length) return;
    event.preventDefault();
    items[next].focus();
  });
  paper.addEventListener('drop', event => {
    if (visual) event.preventDefault();
  });
  paper.addEventListener('keydown', event => {
    if (!visual || event.isComposing) return;
    if (event.altKey && event.shiftKey && event.code === 'KeyH' && !headingTools.hidden && getSelection().rangeCount) {
      event.preventDefault();
      headingToolsRange = getSelection().getRangeAt(0).cloneRange();
      selectionTextButtons[0].focus({ preventScroll: true });
      return;
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const caret = getSelection().focusNode;
      const cell = (caret instanceof Element ? caret : caret?.parentElement)?.closest('td, th');
      if (cell) {
        const bounds = cell.getBoundingClientRect();
        if (showTableMenu(cell, bounds.left, bounds.bottom)) event.preventDefault();
      }
      return;
    }
    if (event.altKey && event.shiftKey && event.code === 'KeyM') {
      const node = visualBlockAt(getSelection().focusNode) ?? paper.firstElementChild;
      if (node) {
        event.preventDefault();
        showBlockMenu(node);
      }
      return;
    }
    if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') editorTyping = null;
    if (event.key === 'Escape') {
      event.preventDefault();
      paper.blur();
      return;
    }
    if (event.key !== 'Enter') return;
    const caret = getSelection().focusNode;
    const node = caret?.nodeType === Node.ELEMENT_NODE ? caret : caret?.parentElement;
    event.preventDefault();
    const preserveLine = node?.closest('pre,td,th') || (event.shiftKey && node?.closest('li,blockquote'));
    document.execCommand('insert' + (preserveLine ? 'LineBreak' : 'Paragraph'));
  });
  paper.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    const address = link?.getAttribute('href');
    if (address && visual) {
      if (!event.ctrlKey && !event.metaKey) {
        event.preventDefault();
      } else if (!event.defaultPrevented && event.button === 0 && /^(?:https?:|mailto:|\/\/)/i.test(address)) {
        event.preventDefault();
        if (!busy && !fileDialogOpen()) window.open(link.href, '_blank', 'noopener,noreferrer');
      }
    }
    if (!event.defaultPrevented && address?.startsWith('#') && address.length > 1) {
      event.preventDefault();
      if (!busy && !fileDialogOpen()) jumpToNoteAnchor(address.slice(1));
    }
    if (event.target === paper) finishBlock();
  });
  if (desktop) paper.addEventListener('click', async event => {
    const link = event.target.closest('a[href]');
    const address = link?.getAttribute('href');
    if (event.defaultPrevented || !address || /^(?:[a-z][a-z0-9+.-]*:|[\\/#?])/i.test(address)) return;
    const path = address.split(/[?#]/, 1)[0];
    let decodedPath;
    try { decodedPath = decodeURIComponent(path); } catch { return; }
    if (/\.(?:md|markdown)$/i.test(decodedPath)) {
      event.preventDefault();
      const hash = address.indexOf('#');
      await openLinkedNote(path, hash < 0 ? '' : address.slice(hash + 1));
      return;
    }
    if (!/\.pdf(?:[?#]|$)/i.test(address)) return;
    event.preventDefault();
    if (busy || fileDialogOpen()) return;
    if (!desktopToken) {
      setStatus('请先打开或保存这篇笔记。');
      return;
    }
    const element = link.closest('.block');
    const sectionStart = visualRangeAt(link)?.start ?? blocks.find(block => block.element === element)?.start;
    busy = true;
    try {
      const { openedPdf, pdfExcerpt } = await desktopRequest({ action: 'open-linked-pdf', token: desktopToken, notePath: address });
      if (pdfExcerpt && sectionStart != null) {
        const offset = active && sectionStart >= active.end ? markdown.length - active.initialLength : 0;
        finishBlock();
        const destination = visual ? visualRangeAt(link) : blocks.find(block => block.start === sectionStart + offset);
        if (!destination) throw new Error('无法定位原页链接所在段落。');
        const before = markdown.slice(0, destination.end).replace(/\n+$/, '');
        const after = markdown.slice(destination.end);
        cursor = before.length + 2;
        if (visual) captureVisualCaret();
        markdown = before + '\n\n' + pdfExcerpt + '\n\n' + after.replace(/^\n+/, '');
        render();
        updateCount();
        persist();
        blocks.find(block => block.start === cursor)?.element?.scrollIntoView({ block: 'nearest' });
        rememberEditorChange();
        setStatus('已插入 PDF 摘录和出处');
        return;
      }
      setStatus('已打开 PDF ' + openedPdf);
    } catch (error) {
      setStatus(error.message);
    } finally {
      busy = false;
    }
  });
  document.addEventListener('selectionchange', () => {
    updateTextSelectionBlocks();
    scheduleBlockLayout();
  });
  function isEditorPasteTarget(target) {
    return !target.closest('input, textarea, [contenteditable]') ||
      target === source || target === active?.editor || visual?.editor.contains(target);
  }
  if (desktop) document.addEventListener('paste', event => {
    if (!isEditorPasteTarget(event.target) || fileDialogOpen()) return;
    event.preventDefault();
    void pasteEditor('paste');
  });
  else paper.addEventListener('paste', event => {
    if (!visual) return;
    event.preventDefault();
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
  });
  window.addEventListener('resize', () => {
    refreshSidebarWidth();
    if (active) resize(active.editor);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing && (sectionEdit || sectionDrag)) {
      event.preventDefault();
      if (sectionDrag) finishSectionDrag(false);
      else finishSectionEdit(false);
      return;
    }
    if (main.inert || fileDialogOpen() || event.isComposing || !(event.ctrlKey || event.metaKey)) return;
    const shortcuts = {
      b: () => format('bold'),
      '/': toggleSourceMode,
      e: toggleSourceMode,
      i: () => format('italic'),
      k: () => format('link'),
      n: newDocument,
      o: openDocument,
      s: saveDocument,
    };
    const shifted = {
      BracketLeft: () => format('ordered'),
      BracketRight: () => format('unordered'),
      Backquote: () => format('code'),
      KeyQ: () => format('quote'),
      KeyK: () => format('fence'),
      KeyL: () => toggleSidebar(),
      Digit1: showOutline,
    };
    const key = event.key.toLowerCase();
    if (!busy && !event.altKey && (key === 'z' || key === 'y')) {
      event.preventDefault();
      stepEditorHistory(event.shiftKey || key === 'y');
      return;
    }
    if (desktop && event.shiftKey && !event.altKey && key === 'f') {
      event.preventDefault();
      showNoteSearch();
      return;
    }
    if (desktop && key === 'v' && isEditorPasteTarget(event.target) && !(event.shiftKey && event.altKey)) {
      event.preventDefault();
      void pasteEditor(event.altKey ? 'paste-code' : event.shiftKey ? 'paste-plain' : 'paste');
      return;
    }
    const action = event.altKey ? (!event.shiftKey && key === 'n' ? newDocument : null)
      : event.shiftKey ? shifted[event.code]
        : /^[0-6]$/.test(key) ? () => format('h' + key) : shortcuts[key];
    if (!action) return;
    event.preventDefault();
    action();
  });

  const theme = readStorage(themeKey);
  setTheme(theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
  applyDocumentDisplaySettings();
  toggleSidebar(!sidebarMedia.matches);
  if (desktop && displaySettings.openOutlineByDefault) setEditorOutline(true);
  setBlockLabels(showBlockLabels);
  updateDocumentLabel();
  updateCount();
  syncModeButtons();
  restoreDesktopNote().then(() => {
    const tokens = savedText === markdown ? initialSavedTokens : undefined;
    initialSavedTokens = null;
    render(tokens);
    resetEditorHistory();
    if (desktop) loadNotes('list-notes');
  });
  setStatus(restored ? '已恢复本机草稿' : '本地文档');
})();
