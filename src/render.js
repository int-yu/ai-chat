function appendText(document, parent, text) {
  if (text) parent.append(document.createTextNode(text));
}

function safeLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function createReasoningPanel(document, reasoning, { open = false } = {}) {
  const panel = document.createElement('details');
  panel.className = 'reasoning-panel';
  panel.open = open;

  const summary = document.createElement('summary');
  summary.textContent = '提供商推理摘要';
  const content = document.createElement('div');
  content.className = 'reasoning-content';
  content.textContent = String(reasoning ?? '');
  panel.append(summary, content);
  return panel;
}

function appendInline(document, parent, text) {
  const tokenPattern = /`([^`\n]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let cursor = 0;
  let match;

  while ((match = tokenPattern.exec(text)) !== null) {
    appendText(document, parent, text.slice(cursor, match.index));

    if (match[1] !== undefined) {
      const code = document.createElement('code');
      code.textContent = match[1];
      parent.append(code);
    } else if (match[2] !== undefined) {
      const href = safeLink(match[3]);
      if (href) {
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = match[2];
        parent.append(link);
      } else {
        appendText(document, parent, match[0]);
      }
    } else if (match[4] !== undefined) {
      const strong = document.createElement('strong');
      strong.textContent = match[4];
      parent.append(strong);
    } else {
      const emphasis = document.createElement('em');
      emphasis.textContent = match[5];
      parent.append(emphasis);
    }

    cursor = tokenPattern.lastIndex;
  }

  appendText(document, parent, text.slice(cursor));
}

export function renderMarkdown(container, markdown) {
  const document = container.ownerDocument;
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const fragment = document.createDocumentFragment();
  let paragraph = [];
  let list = null;
  let codeBlock = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const element = document.createElement('p');
    appendInline(document, element, paragraph.join('\n'));
    fragment.append(element);
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    const element = document.createElement(list.ordered ? 'ol' : 'ul');
    for (const item of list.items) {
      const listItem = document.createElement('li');
      appendInline(document, listItem, item);
      element.append(listItem);
    }
    fragment.append(element);
    list = null;
  };

  const flushCode = () => {
    if (!codeBlock) return;
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (codeBlock.language) {
      code.dataset.language = codeBlock.language;
      code.className = `language-${codeBlock.language}`;
    }
    code.textContent = codeBlock.lines.join('\n');
    pre.append(code);
    fragment.append(pre);
    codeBlock = null;
  };

  for (const line of lines) {
    const fence = line.match(/^```\s*([\w#+.-]*)\s*$/);
    if (fence) {
      if (codeBlock) {
        flushCode();
      } else {
        flushParagraph();
        flushList();
        codeBlock = { language: fence[1], lines: [] };
      }
      continue;
    }

    if (codeBlock) {
      codeBlock.lines.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const element = document.createElement(`h${heading[1].length}`);
      appendInline(document, element, heading[2]);
      fragment.append(element);
      continue;
    }

    const listItem = line.match(/^\s*(?:(\d+)\.|[-*])\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      const ordered = listItem[1] !== undefined;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push(listItem[2]);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushCode();
  flushParagraph();
  flushList();
  container.replaceChildren(fragment);
  return container;
}
