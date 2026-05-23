/**
 * Minimal zero-dependency markdown renderer.
 * Ported from v2 dashboard utils.ts.
 *
 * Input must already be HTML-escaped.
 * Supports: headings, bold, italic, code blocks, inline code, lists, links,
 * images, tables, horizontal rules, paragraphs.
 */

export function renderMarkdown(escaped: string): string {
  if (!escaped) return '';

  // Preserve code blocks first (replace with placeholders)
  const codeBlocks: string[] = [];
  let text = escaped.replace(/```(?:\w*)\n([\s\S]*?)```/g, (_m, code: string) => {
    codeBlocks.push(code.replace(/\n$/, ''));
    return '\x00CB' + (codeBlocks.length - 1) + '\x00';
  });

  // Inline code
  text = text.replace(/`([^`\n]+)`/g, '<code class="inl">$1</code>');

  // Headings
  text = text.replace(/^(#{1,6})\s+(.+)$/gm, (_m, hashes: string, content: string) => {
    const level = hashes.length;
    return `<h${level} style="margin:8px 0 4px;font-size:${18 - level * 1.5}px">${content}</h${level}>`;
  });

  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic (negative lookbehind not supported in all browsers, use simpler pattern)
  text = text.replace(/(^|[^\\w])\\*([^*]+)\\*(?![\\w])/g, '$1<em>$2</em>');

  // Images ![alt](src) — must come before links
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,
    '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px;margin:4px 0">');

  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener" style="color:var(--accent)">$1</a>');

  // Lists, tables, paragraphs — block-level processing
  {
    const lines = text.split('\n');
    const out: string[] = [];
    const listStack: Array<{ tag: string; indent: number }> = [];
    let inPara = false;
    let inTable = false;

    function closeListsTo(indent: number): void {
      while (listStack.length > 0 && listStack[listStack.length - 1].indent >= indent) {
        out.push('</' + listStack.pop()!.tag + '>');
      }
    }
    function closeAllLists(): void { closeListsTo(-1); }
    function closePara(): void { if (inPara) { out.push('</p>'); inPara = false; } }
    function closeTable(): void { if (inTable) { out.push('</tbody></table>'); inTable = false; } }

    function parseTableRow(line: string): string[] {
      const cells = line.split('|').map(c => c.trim());
      if (cells[0] === '') cells.shift();
      if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      return cells;
    }

    function isSeparatorRow(line: string): boolean {
      return /^\|?[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)*\|?\s*$/.test(line) && line.includes('-');
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Horizontal rule
      if (/^---+$/.test(line)) {
        closePara(); closeAllLists();
        out.push('<hr style="border:none;border-top:1px solid var(--rule);margin:8px 0">');
        continue;
      }

      // Table start
      if (!inTable && line.includes('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
        closePara(); closeAllLists();
        const headers = parseTableRow(line);
        out.push('<table><thead><tr>' + headers.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>');
        i++; // skip separator row
        inTable = true;
        continue;
      }

      // Table row
      if (inTable) {
        if (line.includes('|')) {
          const cells = parseTableRow(line);
          out.push('<tr>' + cells.map(c => '<td>' + c + '</td>').join('') + '</tr>');
          continue;
        } else {
          closeTable();
        }
      }

      // List items
      const ulMatch = line.match(/^(\s*)([-*])\s+(.+)$/);
      const olMatch = !ulMatch ? line.match(/^(\s*)\d+\.\s+(.+)$/) : null;

      if (ulMatch || olMatch) {
        closePara();
        const indent = (ulMatch ?? olMatch)![1].length;
        const tag = ulMatch ? 'ul' : 'ol';
        const content = ulMatch ? ulMatch[3] : olMatch![2];

        if (listStack.length === 0 || indent > listStack[listStack.length - 1].indent) {
          out.push('<' + tag + '>');
          listStack.push({ tag, indent });
        } else if (indent < listStack[listStack.length - 1].indent) {
          closeListsTo(indent);
          if (listStack.length === 0 || listStack[listStack.length - 1].indent < indent) {
            out.push('<' + tag + '>');
            listStack.push({ tag, indent });
          }
        }
        out.push('<li>' + content + '</li>');
        continue;
      }

      // Continuation lines inside a list
      if (listStack.length > 0 && line.trim() !== '' &&
          !line.startsWith('#') && !line.startsWith('```') &&
          !line.startsWith('<h') && !line.startsWith('<hr')) {
        const lastIdx = out.length - 1;
        if (lastIdx >= 0 && out[lastIdx].startsWith('<li>')) {
          out[lastIdx] = out[lastIdx].replace('</li>', ' ' + line.trim() + '</li>');
        } else {
          out.push(line);
        }
        continue;
      }

      // Blank line inside list — peek ahead to decide if list continues
      if (line.trim() === '' && listStack.length > 0) {
        let peek = i + 1;
        while (peek < lines.length && lines[peek].trim() === '') peek++;
        if (peek < lines.length) {
          const nextLine = lines[peek];
          const nextIsUl = /^(\s*)([-*])\s+/.test(nextLine);
          const nextIsOl = /^(\s*)\d+\.\s+/.test(nextLine);
          if (nextIsUl || nextIsOl) continue; // skip blank, keep list open
        }
      }

      closeAllLists();

      // Regular paragraphs
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

  // Restore code blocks
  text = text.replace(/\x00CB(\d+)\x00/g, (_m, idx: string) => {
    return `<pre style="background:var(--paper-card);padding:8px;border-radius:4px;overflow-x:auto;margin:4px 0;font-size:12px"><code>${codeBlocks[parseInt(idx)]}</code></pre>`;
  });

  return text;
}
