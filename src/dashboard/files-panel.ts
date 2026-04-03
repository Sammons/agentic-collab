/**
 * <files-panel> Web Component.
 * Displays files in an agent's working directory.
 */

import { state, authHeaders } from '/dashboard/assets/state.ts';
import { esc, formatFileSize, showToast } from '/dashboard/assets/utils.ts';
import { icon } from '/dashboard/assets/icons.ts';

export class FilesPanel extends HTMLElement {
  _agent = null;
  _loading = false;

  async load(agentName) {
    this._agent = agentName;
    this._loading = true;
    this.innerHTML = '<div class="files-empty">Loading files\u2026</div>';

    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/files`, {
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        this.innerHTML = `<div class="files-empty">${esc(body?.error || 'Failed to load files')}</div>`;
        return;
      }
      const data = await res.json();
      this._renderFiles(data.files || [], data.cwd || '');
    } catch {
      this.innerHTML = '<div class="files-empty">Failed to load files</div>';
    } finally {
      this._loading = false;
    }
  }

  _renderFiles(files, cwd) {
    if (files.length === 0) {
      this.innerHTML = `<div class="files-empty">No files in ${esc(cwd)}</div>`;
      return;
    }

    // Sort: dirs first, then alphabetical
    files.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    let html = `<div class="files-header"><span class="files-count">${files.length} items</span></div>`;
    html += '<div class="files-list">';
    for (const f of files) {
      const sizeStr = f.isDir ? '' : formatFileSize(f.size);
      html += `<div class="files-item${f.isDir ? ' is-dir' : ''}">`;
      html += `<span class="files-name">${f.isDir ? '/' : ''}${esc(f.name)}</span>`;
      if (sizeStr) html += `<span class="files-size">${sizeStr}</span>`;
      html += '</div>';
    }
    html += '</div>';

    // Bookmarked pages for this agent
    const agentPages = (state.pages || []).filter(p => p.agent === this._agent);
    if (agentPages.length > 0) {
      html += '<div class="files-section-label">Published Pages</div>';
      html += '<div class="files-list">';
      for (const page of agentPages) {
        html += `<div class="files-item files-page">`;
        html += `<a class="files-name files-link" href="/pages/${esc(page.slug)}" target="_blank">${esc(page.slug)}</a>`;
        html += `<span class="files-size">${formatFileSize(page.totalBytes)}</span>`;
        html += '</div>';
      }
      html += '</div>';
    }

    this.innerHTML = html;
  }
}

customElements.define('files-panel', FilesPanel);
