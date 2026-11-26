const visualMarkdown = (() => {
  const blocks = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'TABLE', 'HR']);
  const emphasis = { STRONG: '**', B: '**', EM: '*', I: '*', DEL: '~~', S: '~~', STRIKE: '~~' };
  const imageSources = new WeakMap();
  const imageSource = node => imageSources.get(node) ?? node.getAttribute('src') ?? '';
  const text = node => node.textContent.replace(/\u00a0/g, ' ');
  const escape = value => value.replace(/&(?=(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);)/gi, '&amp;')
    .replace(/[\\\x60*_[\]<>~|]/g, '\\$&');
  const destination = value => '<' + value.replace(/[<>\n]/g, char => encodeURIComponent(char)) + '>';

  function titledDestination(node, value) {
    const title = node.getAttribute('title');
    return destination(value) + (title ? ' "' + title.replace(/[\\"]/g, '\\$&') + '"' : '');
  }

  function inline(node) {
    if (node.nodeType === Node.TEXT_NODE) return escape(text(node));
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName;
    if (tag === 'BR') return '  \n';
    if (tag === 'INPUT') return '';
    if (tag === 'IMG') {
      return '![' + escape(node.alt) + '](' + titledDestination(node, imageSource(node)) + ')';
    }
    if (tag === 'CODE') {
      const value = text(node);
      if (!value) return '';
      const fence = '\x60'.repeat(Math.max(0, ...Array.from(value.matchAll(/\x60+/g), match => match[0].length)) + 1);
      const padding = /^(?:\x60| )|(?:\x60| )$/.test(value) && value.trim() ? ' ' : '';
      return fence + padding + value + padding + fence;
    }
    const content = inlines(node);
    if (tag === 'A' && node.hasAttribute('href'))
      return '[' + content + '](' + titledDestination(node, node.getAttribute('href')) + ')';
    if (tag in emphasis) {
      const trimmed = content.trim();
      return trimmed ? content.replace(trimmed, () => emphasis[tag] + trimmed + emphasis[tag]) : content;
    }
    if (['U', 'SUB', 'SUP', 'KBD', 'MARK'].includes(tag)) {
      const name = tag.toLowerCase();
      return '<' + name + '>' + content + '</' + name + '>';
    }
    return content;
  }

  function inlines(element) {
    return Array.from(element.childNodes, inline).join('');
  }

  function paragraph(value) {
    return value.trim()
      .replace(/^([ \t]*)(?:(#{1,6}|[+>-])(?=\s)|(\d{1,9})([.)])(?=\s))/gm,
        (_, space, marker, ordinal, delimiter) => space + (marker ? '\\' + marker : ordinal + '\\' + delimiter))
      .replace(/^([ \t]*)([-=])(?=\2+[ \t]*$)/gm, '$1\\$2');
  }

  function fenceCode(value, language = '') {
    let fenceLength = 3;
    for (const match of value.matchAll(/~+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = '~'.repeat(fenceLength);
    return fence + language + '\n' + value + '\n' + fence;
  }

  const codeContent = pre => pre.querySelector('code') ?? pre;

  function codeText(pre) {
    const code = codeContent(pre);
    let value = code.innerText;
    if (!code.isConnected || code.closest('[data-fold-hidden]')) {
      const copy = code.cloneNode(true);
      for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
      value = copy.textContent;
    }
    return value.replace(/\u00a0/g, ' ').replace(/\n$/, '');
  }

  function codeLanguage(pre) {
    return [...codeContent(pre).classList].find(name => name.startsWith('language-'))?.slice(9) ?? '';
  }

  function block(node) {
    const tag = node.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const heading = inlines(node).trim().replace(/\s*\n\s*/g, ' ').replace(/#+$/, '\\$&');
      const marker = '#'.repeat(Number(tag[1]));
      return heading ? marker + ' ' + heading : marker;
    }
    switch (tag) {
      case 'P': case 'DIV': return serialize(node);
      case 'HR': return '---';
      case 'BLOCKQUOTE': return serialize(node).split('\n').map(line => line ? '> ' + line : '>').join('\n');
      case 'PRE': return fenceCode(codeText(node), codeLanguage(node));
      case 'OL': case 'UL':
        return [...node.children].filter(item => item.tagName === 'LI').map((item, index) => {
          const marker = tag === 'OL' ? (node.start + index) + '. ' : '- ';
          const checkbox = item.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]');
          const task = checkbox ? (checkbox.checked ? '[x] ' : '[ ] ') : '';
          const value = serialize(item).split('\n');
          if (value.length === 1 && !value[0]) return task ? marker + task + '&nbsp;' : marker.trimEnd();
          return marker + task + value[0] + value.slice(1).map(line => '\n' + (line ? ' '.repeat(marker.length) + line : '')).join('');
        }).join('\n');
      case 'TABLE': {
        const rows = [...node.rows];
        if (!rows.length) return '';
        const cellText = cell => inlines(cell).trim().replace(/\s*\n\s*/g, '<br>')
          .replace(/(\\*)\|/g, (match, escapes) => escapes.length % 2 ? match : escapes + '\\|');
        const row = cells => '| ' + [...cells].map(cellText).join(' | ') + ' |';
        const divider = [...rows[0].cells].map(cell => ({ left: ':---', center: ':---:', right: '---:' })[cell.align] ?? '---');
        return [row(rows[0].cells), '| ' + divider.join(' | ') + ' |', ...rows.slice(1).map(item => row(item.cells))].join('\n');
      }
      default: return '';
    }
  }

  function sections(element) {
    const output = [];
    let line = '';
    for (const child of element.childNodes) {
      if (blocks.has(child.tagName)) {
        if (line) output.push({ value: paragraph(line) });
        output.push({ node: child, value: block(child) });
        line = '';
      } else {
        line += inline(child);
      }
    }
    if (line) output.push({ value: paragraph(line) });
    return output;
  }

  function serialize(element) {
    return sections(element).map(({ value }) => value).filter(Boolean).join('\n\n');
  }

  function paragraphLines(token) {
    if (token.type !== 'paragraph' || !token.tokens.some(part => part.type === 'br')) {
      return [{ offset: 0, token }];
    }
    if (token.tokens.map(part => part.raw).join('') !== token.text) return [{ offset: 0, token }];

    const lines = [];
    let offset = 0;
    let end = 0;
    let tokens = [];
    const append = () => {
      if (!tokens.length) return;
      const raw = token.text.slice(offset, end);
      lines.push({ offset, token: { type: 'paragraph', raw, text: raw, tokens } });
    };
    for (const part of token.tokens) {
      if (part.type === 'br') append();
      end += part.raw.length;
      if (part.type === 'br') {
        offset = end;
        tokens = [];
      } else {
        tokens.push(part);
      }
    }
    append();
    return lines;
  }

  return { serialize, sections, paragraphLines, fenceCode, codeContent, codeText, codeLanguage,
    imageSource, rememberImage: (node, src) => imageSources.set(node, src) };
})();
