/**
 * <files-panel> Web Component.
 * Agent profile / index page — summary, published pages, data stores, workspace info.
 */

import { state, authHeaders } from '/dashboard/assets/state.ts';
import { esc, formatFileSize } from '/dashboard/assets/utils.ts';
import { icon } from '/dashboard/assets/icons.ts';

export class FilesPanel extends HTMLElement {
  _agent = null;

  async load(agentName) {
    this._agent = agentName;
    const agent = state.agents.find(a => a.name === agentName);
    if (!agent) {
      this.innerHTML = '<div class="files-empty">Agent not found</div>';
      return;
    }

    const agentPages = (state.pages || []).filter(p => p.agent === agentName);
    const agentStores = (state.stores || []).filter(s => s.agent === agentName);
    const indicators = state.indicators[agentName] || [];
    let html = '<div class="agent-profile">';

    // ── Header ──
    html += '<div class="profile-section">';
    html += `<div class="profile-name">${agent.icon ? esc(agent.icon) + ' ' : ''}${esc(agent.name)}</div>`;
    html += `<div class="profile-meta">`;
    html += `<span class="state-badge state-${agent.state}">${agent.state}</span>`;
    html += ` <span class="profile-dim">${esc(agent.engine || '')}</span>`;
    if (agent.cwd) html += ` <span class="profile-dim">· ${esc(agent.cwd)}</span>`;
    html += '</div>';
    if (indicators.length > 0) {
      html += '<div class="profile-indicators">';
      for (const ind of indicators) {
        html += `<span class="indicator-badge ${ind.style || 'info'}">${esc(ind.badge)}</span>`;
      }
      html += '</div>';
    }
    html += '</div>';

    // ── Published Pages ──
    if (agentPages.length > 0) {
      html += '<div class="profile-section">';
      html += '<div class="profile-section-title">Published Pages</div>';
      for (const page of agentPages) {
        html += `<a class="profile-card profile-link" href="/pages/${esc(page.slug)}" target="_blank">`;
        html += `<span class="profile-card-title">${icon.globe(14)} ${esc(page.slug)}</span>`;
        html += `<span class="profile-card-meta">${page.fileCount} files · ${formatFileSize(page.totalBytes)}</span>`;
        html += '</a>';
      }
      html += '</div>';
    }

    // ── Data Stores ──
    if (agentStores.length > 0) {
      html += '<div class="profile-section">';
      html += '<div class="profile-section-title">Data Stores</div>';
      for (const store of agentStores) {
        html += '<div class="profile-card">';
        html += `<span class="profile-card-title">${icon.file(14)} ${esc(store.name)}</span>`;
        html += `<span class="profile-card-meta">updated ${esc(store.updatedAt ? new Date(store.updatedAt).toLocaleDateString() : '')}</span>`;
        html += '</div>';
      }
      html += '</div>';
    }

    // ── Workspace ──
    if (agent.cwd) {
      html += '<div class="profile-section">';
      html += '<div class="profile-section-title">Workspace</div>';
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/files`, { headers: authHeaders() });
        if (res.ok) {
          const data = await res.json();
          const files = (data.files || []).slice(0, 10);
          if (files.length > 0) {
            html += '<div class="profile-card">';
            html += `<span class="profile-card-meta">${esc(data.cwd)}</span>`;
            for (const f of files) {
              const sizeStr = f.isDir ? '' : ' · ' + formatFileSize(f.size);
              html += `<div class="profile-file">${f.isDir ? '📁' : '📄'} ${esc(f.name)}${sizeStr}</div>`;
            }
            if (data.files.length > 10) html += `<div class="profile-dim">+ ${data.files.length - 10} more</div>`;
            html += '</div>';
          }
        }
      } catch { /* skip workspace listing on error */ }
      html += '</div>';
    }

    // ── Empty state ──
    if (agentPages.length === 0 && agentStores.length === 0) {
      html += '<div class="profile-section"><div class="profile-dim" style="text-align:center;padding:16px">No published pages, stores, or messages yet.</div></div>';
    }

    html += '</div>';
    this.innerHTML = html;
  }
}

customElements.define('files-panel', FilesPanel);
