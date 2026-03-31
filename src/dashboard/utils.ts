/**
 * Shared dashboard utilities.
 * Pure functions and UI helpers used by multiple components.
 *
 * Exports:
 *   esc(s)                     — HTML-escape a string
 *   renderMarkdown(escaped)    — minimal zero-dep markdown→HTML
 *   timeAgo(isoStr)            — "2m ago" style timestamp
 *   formatFileSize(bytes)      — "1.2MB" style size
 *   showToast(message, type)   — transient notification
 *   promptInput(label, def)    — themed prompt() replacement
 *   confirmAction(message)     — themed confirm() replacement
 */

// ── Escaping ──

export function esc(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ── Formatting ──

export function timeAgo(isoStr) {
  if (!isoStr) return '';
  const diff = Math.max(0, Date.now() - new Date(isoStr).getTime());
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'GB';
}

// ── Toast ──

export function showToast(message, type = 'error') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ── Dialogs ──

export function promptInput(label, defaultValue) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box">
        <p>${esc(label)}</p>
        <input type="text" value="${esc(defaultValue || '')}" style="width:100%;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;box-sizing:border-box;margin-bottom:16px" autocomplete="off" />
        <div class="actions">
          <button class="cancel-btn">Cancel</button>
          <button class="danger-btn" style="background:var(--accent);border-color:var(--accent)">OK</button>
        </div>
      </div>
    `;
    const input = overlay.querySelector('input');
    const submit = () => { const v = input.value.trim(); overlay.remove(); resolve(v || null); };
    overlay.querySelector('.cancel-btn').onclick = () => { overlay.remove(); resolve(null); };
    overlay.querySelector('.danger-btn').onclick = submit;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') { overlay.remove(); resolve(null); }
    });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { overlay.remove(); resolve(null); }
    });
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

export function confirmAction(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box">
        <p>${esc(message)}</p>
        <div class="actions">
          <button class="cancel-btn">Cancel</button>
          <button class="danger-btn">Confirm</button>
        </div>
      </div>
    `;
    overlay.querySelector('.cancel-btn').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('.danger-btn').onclick = () => { overlay.remove(); resolve(true); };
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { overlay.remove(); resolve(false); }
    });
    document.body.appendChild(overlay);
    overlay.querySelector('.danger-btn').focus();
  });
}

// ── Markdown ──

/**
 * Minimal zero-dependency markdown renderer.
 * Input must already be HTML-escaped via esc().
 * Supports: headings, bold, italic, code blocks, inline code, lists, links, tables, paragraphs.
 */
export function renderMarkdown(escaped) {
  if (!escaped) return '';
  // Preserve code blocks first
  const codeBlocks = [];
  let text = escaped.replace(/```(?:\w*)\n([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(code.replace(/\n$/, ''));
    return '\x00CB' + (codeBlocks.length - 1) + '\x00';
  });
  // Inline code
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Headings
  text = text.replace(/^(#{1,6})\s+(.+)$/gm, (_m, hashes, content) => {
    const level = hashes.length;
    return `<h${level} style="margin:8px 0 4px;font-size:${18 - level * 1.5}px">${content}</h${level}>`;
  });
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  text = text.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '<em>$1</em>');
  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--accent)">$1</a>');
  // Lists, tables, paragraphs
  {
    const lines = text.split('\n');
    const out = [];
    const listStack = [];
    let inPara = false;
    let inTable = false;

    function closeListsTo(indent) {
      while (listStack.length > 0 && listStack[listStack.length - 1].indent >= indent) {
        out.push('</' + listStack.pop().tag + '>');
      }
    }
    function closeAllLists() { closeListsTo(-1); }
    function closePara() { if (inPara) { out.push('</p>'); inPara = false; } }
    function closeTable() { if (inTable) { out.push('</tbody></table>'); inTable = false; } }

    function parseTableRow(line) {
      const cells = line.split('|').map(c => c.trim());
      if (cells[0] === '') cells.shift();
      if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      return cells;
    }

    function isSeparatorRow(line) {
      return /^\|?[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)*\|?\s*$/.test(line) && line.includes('-');
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hrMatch = line.match(/^---+$/);
      if (hrMatch) {
        closePara(); closeAllLists();
        out.push('<hr style="border:none;border-top:1px solid var(--border);margin:8px 0">');
        continue;
      }

      if (!inTable && line.includes('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
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
      const olMatch = !ulMatch && line.match(/^(\s*)\d+\.\s+(.+)$/);

      if (ulMatch || olMatch) {
        closePara();
        const indent = (ulMatch || olMatch)[1].length;
        const tag = ulMatch ? 'ul' : 'ol';
        const content = ulMatch ? ulMatch[3] : olMatch[2];

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
  // Restore code blocks
  text = text.replace(/\x00CB(\d+)\x00/g, (_m, idx) => {
    return `<pre style="background:var(--bg);padding:8px;border-radius:4px;overflow-x:auto;margin:4px 0;font-size:12px"><code>${codeBlocks[parseInt(idx)]}</code></pre>`;
  });
  return text;
}
