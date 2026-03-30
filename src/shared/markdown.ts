/**
 * Lightweight markdown renderer for the dashboard.
 * Handles: headings, bold, italic, inline code, code blocks, links,
 * ordered/unordered lists (with nesting), tables, horizontal rules, paragraphs.
 *
 * Input must be pre-escaped HTML (& < > " already escaped).
 * Output is safe HTML ready for innerHTML insertion.
 */

export function renderMarkdown(escaped: string): string {
  if (!escaped) return '';
  // Preserve code blocks first — extract and replace with placeholders
  const codeBlocks: string[] = [];
  let text = escaped.replace(/```(?:\w*)\n([\s\S]*?)```/g, (_m: string, code: string) => {
    codeBlocks.push(code.replace(/\n$/, ''));
    return '\x00CB' + (codeBlocks.length - 1) + '\x00';
  });
  // Inline code — extract as placeholders to protect from further transforms
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_m: string, code: string) => {
    inlineCodes.push(code);
    return '\x00IC' + (inlineCodes.length - 1) + '\x00';
  });
  // Headings (must be at start of line)
  text = text.replace(/^(#{1,6})\s+(.+)$/gm, (_m: string, hashes: string, content: string) => {
    const level = hashes.length;
    return `<h${level} style="margin:8px 0 4px;font-size:${18 - level * 1.5}px">${content}</h${level}>`;
  });
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic (single asterisk, not inside words)
  text = text.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '<em>$1</em>');
  // Links (markdown-style)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--accent)">$1</a>');
  // Auto-link bare URLs (not already inside an <a> tag, strip trailing punctuation)
  text = text.replace(/(?<!href="|">)(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '<a href="$1" target="_blank" style="color:var(--accent)">$1</a>');
  // Lists, tables, and paragraphs: line-based parser for proper nesting
  {
    const lines = text.split('\n');
    const out: string[] = [];
    const listStack: Array<{ tag: string; indent: number }> = [];
    let inPara = false;
    let inTable = false;

    function closeListsTo(indent: number) {
      while (listStack.length > 0 && listStack[listStack.length - 1]!.indent >= indent) {
        out.push('</' + listStack.pop()!.tag + '>');
      }
    }
    function closeAllLists() { closeListsTo(-1); }
    function closePara() { if (inPara) { out.push('</p>'); inPara = false; } }
    function closeTable() { if (inTable) { out.push('</tbody></table>'); inTable = false; } }

    function parseTableRow(line: string) {
      const cells = line.split('|').map(c => c.trim());
      if (cells[0] === '') cells.shift();
      if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      return cells;
    }

    function isSeparatorRow(line: string) {
      return /^\|?[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)*\|?\s*$/.test(line) && line.includes('-');
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const hrMatch = line.match(/^---+$/);
      if (hrMatch) {
        closePara(); closeAllLists(); closeTable();
        out.push('<hr style="border:none;border-top:1px solid var(--border);margin:8px 0">');
        continue;
      }

      // Table detection
      if (!inTable && line.includes('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1]!)) {
        closePara(); closeAllLists();
        const headers = parseTableRow(line);
        out.push('<table><thead><tr>' + headers.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>');
        i++;
        inTable = true;
        continue;
      }
      if (inTable) {
        if (line.includes('|')) {
          const cells = parseTableRow(line);
          out.push('<tr>' + cells.map(c => '<td>' + c + '</td>').join('') + '</tr>');
          continue;
        } else {
          closeTable();
        }
      }

      const ulMatch = line.match(/^(\s*)([-*])\s+(.+)$/);
      const olMatch = !ulMatch ? line.match(/^(\s*)\d+\.\s+(.+)$/) : null;

      if (ulMatch || olMatch) {
        closePara(); closeTable();
        const indent = (ulMatch || olMatch)![1]!.length;
        const tag = ulMatch ? 'ul' : 'ol';
        const content = ulMatch ? ulMatch[3] : olMatch![2];

        if (listStack.length === 0 || indent > listStack[listStack.length - 1]!.indent) {
          out.push('<' + tag + '>');
          listStack.push({ tag, indent });
        } else if (indent < listStack[listStack.length - 1]!.indent) {
          closeListsTo(indent);
          if (listStack.length === 0 || listStack[listStack.length - 1]!.indent < indent) {
            out.push('<' + tag + '>');
            listStack.push({ tag, indent });
          }
        }
        out.push('<li>' + content + '</li>');
        continue;
      }

      // Non-list line
      closeAllLists();

      if (line.trim() === '') {
        closePara();
      } else if (line.startsWith('<h') || line.startsWith('<hr')) {
        closePara();
        out.push(line);
      } else {
        if (!inPara) { out.push('<p style="margin:4px 0">'); inPara = true; }
        else { out.push('<br>'); }
        out.push(line);
      }
    }
    closePara();
    closeAllLists();
    closeTable();
    text = out.join('\n');
  }
  // Restore inline code
  text = text.replace(/\x00IC(\d+)\x00/g, (_m: string, idx: string) => {
    return `<code>${inlineCodes[parseInt(idx)]}</code>`;
  });
  // Restore fenced code blocks
  text = text.replace(/\x00CB(\d+)\x00/g, (_m: string, idx: string) => {
    return `<pre style="background:var(--bg);padding:8px;border-radius:4px;overflow-x:auto;margin:4px 0;font-size:12px"><code>${codeBlocks[parseInt(idx)]}</code></pre>`;
  });
  return text;
}
