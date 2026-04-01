/**
 * Zero-dependency markdown-to-HTML renderer.
 * Handles the subset of markdown used in docs: headings, paragraphs,
 * code blocks, inline code, tables, lists, links, bold, italic.
 */

// ── Escape HTML ──

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Inline formatting ──

function inlineFormat(line: string): string {
  // Code spans first (protect from other formatting)
  let result = '';
  let i = 0;
  while (i < line.length) {
    const tick = line.indexOf('`', i);
    if (tick === -1) { result += formatNonCode(line.slice(i)); break; }
    result += formatNonCode(line.slice(i, tick));
    const end = line.indexOf('`', tick + 1);
    if (end === -1) { result += formatNonCode(line.slice(tick)); break; }
    result += `<code>${esc(line.slice(tick + 1, end))}</code>`;
    i = end + 1;
  }
  return result;
}

function formatNonCode(s: string): string {
  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Auto-escape remaining HTML
  // (already escaped in the esc() calls for code blocks)
  return s;
}

// ── Block parsing ──

export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  let inList = false;
  let listType = '';

  function closeList() {
    if (inList) {
      out.push(listType === 'ol' ? '</ol>' : '</ul>');
      inList = false;
    }
  }

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    if (line.startsWith('```')) {
      closeList();
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        codeLines.push(esc(lines[i]!));
        i++;
      }
      i++; // skip closing ```
      out.push(`<pre${lang ? ` class="lang-${esc(lang)}"` : ''}><code>${codeLines.join('\n')}</code></pre>`);
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!;
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      out.push(`<h${level} id="${id}">${inlineFormat(esc(text))}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      closeList();
      out.push('<hr>');
      i++;
      continue;
    }

    // Table
    if (line.includes('|') && line.trim().startsWith('|')) {
      closeList();
      const tableLines: string[] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim().startsWith('|')) {
        tableLines.push(lines[i]!);
        i++;
      }
      out.push(renderTable(tableLines));
      continue;
    }

    // Unordered list
    if (/^[-*]\s/.test(line.trim())) {
      if (!inList || listType !== 'ul') {
        closeList();
        out.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      out.push(`<li>${inlineFormat(esc(line.trim().slice(2)))}</li>`);
      i++;
      continue;
    }

    // Ordered list
    const olMatch = line.trim().match(/^(\d+)\.\s(.+)/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        closeList();
        out.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      out.push(`<li>${inlineFormat(esc(olMatch[2]!))}</li>`);
      i++;
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      closeList();
      i++;
      continue;
    }

    // Paragraph
    closeList();
    const paraLines: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !lines[i]!.startsWith('#') && !lines[i]!.startsWith('```') && !lines[i]!.startsWith('|') && !/^[-*]\s/.test(lines[i]!.trim()) && !/^\d+\.\s/.test(lines[i]!.trim())) {
      paraLines.push(lines[i]!);
      i++;
    }
    if (paraLines.length > 0) {
      out.push(`<p>${inlineFormat(esc(paraLines.join(' ')))}</p>`);
    }
  }

  closeList();
  return out.join('\n');
}

function renderTable(lines: string[]): string {
  if (lines.length < 2) return '';

  const parseRow = (line: string): string[] =>
    line.split('|').slice(1, -1).map(cell => cell.trim());

  const headers = parseRow(lines[0]!);
  // Skip separator row (line 1)
  const rows = lines.slice(2).map(parseRow);

  let html = '<table><thead><tr>';
  for (const h of headers) {
    html += `<th>${inlineFormat(esc(h))}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>';
    for (const cell of row) {
      html += `<td>${inlineFormat(esc(cell))}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

// ── Page list ──

export const DOC_PAGES = [
  { slug: 'quickstart', title: 'Quickstart' },
  { slug: 'persona-reference', title: 'Persona Reference' },
  { slug: 'cli-reference', title: 'CLI Reference' },
  { slug: 'hooks-and-indicators', title: 'Hooks & Indicators' },
];

// ── HTML shell ──

export function wrapInHtml(title: string, bodyHtml: string, currentSlug: string): string {
  const nav = DOC_PAGES.map(p =>
    `<a href="/docs/${p.slug}" class="${p.slug === currentSlug ? 'active' : ''}">${esc(p.title)}</a>`
  ).join('\n        ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} - Agentic Collab Docs</title>
  <style>
    :root {
      --bg: #1a1a2e; --bg2: #16213e; --text: #e0e0e0; --text-dim: #8888aa;
      --accent: #6c63ff; --border: #2a2a4a; --code-bg: #0f0f23;
      --link: #7b8cff; --sidebar-w: 220px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
    .layout { display: flex; min-height: 100vh; }
    nav { width: var(--sidebar-w); background: var(--bg2); border-right: 1px solid var(--border); padding: 20px 16px; flex-shrink: 0; position: sticky; top: 0; height: 100vh; }
    nav .brand { font-size: 14px; font-weight: 700; color: var(--accent); margin-bottom: 20px; text-decoration: none; display: block; }
    nav a { display: block; padding: 6px 10px; margin: 2px 0; border-radius: 6px; color: var(--text-dim); text-decoration: none; font-size: 14px; }
    nav a:hover { color: var(--text); background: rgba(255,255,255,0.05); }
    nav a.active { color: var(--accent); background: rgba(108,99,255,0.1); }
    main { flex: 1; max-width: 800px; padding: 40px 48px; }
    h1 { font-size: 28px; margin-bottom: 16px; color: #fff; }
    h2 { font-size: 22px; margin: 32px 0 12px; color: #fff; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
    h3 { font-size: 17px; margin: 24px 0 8px; color: #ddd; }
    p { margin: 10px 0; }
    a { color: var(--link); }
    code { background: var(--code-bg); padding: 2px 6px; border-radius: 4px; font-size: 13px; font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace; }
    pre { background: var(--code-bg); padding: 16px; border-radius: 8px; overflow-x: auto; margin: 12px 0; border: 1px solid var(--border); }
    pre code { background: none; padding: 0; font-size: 13px; line-height: 1.5; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; }
    th { text-align: left; padding: 8px 12px; border-bottom: 2px solid var(--border); color: var(--text-dim); font-weight: 600; }
    td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
    tr:hover td { background: rgba(255,255,255,0.02); }
    ul, ol { margin: 8px 0; padding-left: 24px; }
    li { margin: 4px 0; }
    strong { color: #fff; }
    hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; }
    @media (max-width: 768px) {
      .layout { flex-direction: column; }
      nav { width: 100%; height: auto; position: static; display: flex; flex-wrap: wrap; gap: 4px; padding: 12px; }
      nav .brand { width: 100%; margin-bottom: 8px; }
      main { padding: 20px 16px; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <nav>
      <a href="/docs" class="brand">Agentic Collab Docs</a>
      ${nav}
    </nav>
    <main>
      ${bodyHtml}
    </main>
  </div>
</body>
</html>`;
}
