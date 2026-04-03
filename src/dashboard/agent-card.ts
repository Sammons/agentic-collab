/**
 * <agent-card> Web Component.
 * Renders a single agent card with state badge, meta, indicators, actions.
 * Exposes update(agent, context) for in-place patching without DOM teardown.
 *
 * Usage:
 *   const card = document.createElement('agent-card');
 *   card.render(agent, { unread, indicators, selected, proxies });
 *   list.appendChild(card);
 *   // Later, for in-place update:
 *   card.update(agent, { unread, indicators, selected, proxies });
 */

import { icon } from '/dashboard/assets/icons.ts';

// ── Utilities ──

function esc(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function proxyWarning(proxyId, proxies) {
  const proxy = (proxies || []).find(p => p.proxyId === proxyId);
  if (!proxy || proxy.versionMatch !== false) return '';
  const ver = proxy.version ? ` (${esc(proxy.version)})` : '';
  return ` <span class="version-mismatch" title="Proxy version${ver} does not match orchestrator. Restart the proxy.">${icon.alertTriangle(12)} stale proxy</span>`;
}

function buildActionsHtml(agent) {
  const activeIdle = agent.state === 'active' || agent.state === 'idle';
  const suspendedFailed = agent.state === 'suspended' || agent.state === 'failed';
  const transitioning = agent.state === 'spawning' || agent.state === 'suspending' || agent.state === 'resuming';
  const isVoid = agent.state === 'void';
  let html = '';
  if (activeIdle) {
    html = `${agent.engine !== 'codex' ? '<button data-action="compact">Compact</button>' : ''}<button data-action="reload">Reload</button><button data-action="exit">Exit</button><button class="danger" data-action="kill">Kill</button>${agent.tmuxSession ? `<button class="secondary" data-copy-tmux="tmux attach -t ${esc(agent.tmuxSession)}">Copy tmux</button>` : ''}`;
  } else if (suspendedFailed) {
    html = '<button data-action="resume">Resume</button><button class="danger" data-action="destroy">Destroy</button>';
  } else if (transitioning) {
    html = '<button class="danger" data-action="kill">Kill</button>';
  } else if (isVoid) {
    html = '<button data-action="spawn">Spawn</button><button class="danger" data-action="destroy">Destroy</button>';
  }
  if (activeIdle && agent.customButtons) {
    try {
      const btns = JSON.parse(agent.customButtons);
      html += Object.keys(btns).map(b =>
        `<button class="secondary" data-action="custom/${esc(b)}">${esc(b)}</button>`
      ).join('');
    } catch {}
  }
  return html;
}

function buildIndicatorsHtml(indicators) {
  if (!indicators || !indicators.length) return '';
  const inner = indicators.map(ind => {
    let html = '<span class="indicator-badge ' + esc(ind.style) + '">' + esc(ind.badge) + '</span>';
    if (ind.actions) {
      html += Object.keys(ind.actions).map(a =>
        '<button class="indicator-action" data-action="indicator/' + esc(ind.id) + '/' + esc(a) + '">' + esc(a) + '</button>'
      ).join('');
    }
    return html;
  }).join('');
  return '<div class="indicator-badges">' + inner + '</div>';
}

function buildMetaHtml(agent, proxies) {
  const modelStr = [agent.engine, agent.model, agent.thinking].filter(Boolean).join(' ');
  const ctxStr = agent.lastContextPct != null ? `${agent.lastContextPct}%` : '--';
  const permBadge = agent.permissions === 'skip' ? '<span class="perm-badge skip" title="Auto-approves all tool use — no confirmation prompts">unsafe</span>' : '';
  const accountSpan = agent.account ? `<span title="account: ${esc(agent.account)}">acct: ${esc(agent.account)}</span>` : '';
  return `<span>${esc(modelStr)}</span><span>ctx: ${ctxStr}</span>${permBadge}${accountSpan}${agent.proxyId ? `<span title="proxy: ${esc(agent.proxyId)}">${esc(agent.proxyId)}${proxyWarning(agent.proxyId, proxies)}</span>` : ''}`;
}

// ── Component ──

export class AgentCard extends HTMLElement {
  /** Full render — sets innerHTML from scratch. Used on initial creation. */
  render(agent, ctx) {
    this.className = `agent-card${ctx.selected ? ' selected' : ''}`;
    this.dataset.agent = agent.name;
    this.setAttribute('tabindex', '0');
    this.setAttribute('draggable', 'true');

    const unreadCount = ctx.unread || 0;
    const unreadBadge = unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : '';
    const failureInfo = agent.state === 'failed' && agent.failureReason
      ? `<div class="agent-failure" title="${esc(agent.failureReason)}">${esc(agent.failureReason)}</div>` : '';

    const starred = JSON.parse(localStorage.getItem('starredAgents') || '{}');
    const isStarred = !!starred[agent.name];

    this.innerHTML = `
      <div class="agent-header">
        <button class="agent-star${isStarred ? ' starred' : ''}" data-star-agent="${esc(agent.name)}" title="Star agent">
          ${isStarred ? icon.starFilled(14) : icon.star(14)}
        </button>
        ${agent.icon ? `<span class="agent-icon">${esc(agent.icon)}</span>` : ''}
        <span class="agent-name">${esc(agent.name)}${unreadBadge}</span>
        <span class="state-badge state-${agent.state}">${agent.state}</span>
      </div>
      <div class="agent-meta">${buildMetaHtml(agent, ctx.proxies)}</div>
      ${failureInfo}
      ${buildIndicatorsHtml(ctx.indicators)}
      <div class="drag-handle" title="Drag to reorder or move to group">${icon.gripVertical(14)}</div>
      <div class="agent-actions">${buildActionsHtml(agent)}</div>
    `;
  }

  /** In-place patch — updates sub-elements without DOM teardown. */
  update(agent, ctx) {
    // Star
    const starBtn = this.querySelector('.agent-star');
    if (starBtn) {
      const starred = JSON.parse(localStorage.getItem('starredAgents') || '{}');
      const isStarred = !!starred[agent.name];
      starBtn.className = `agent-star${isStarred ? ' starred' : ''}`;
      starBtn.innerHTML = isStarred ? icon.starFilled(14) : icon.star(14);
    }
    // Icon
    let iconEl = this.querySelector('.agent-icon');
    if (agent.icon) {
      if (!iconEl) {
        iconEl = document.createElement('span');
        iconEl.className = 'agent-icon';
        const nameEl2 = this.querySelector('.agent-name');
        if (nameEl2) nameEl2.before(iconEl);
      }
      iconEl.textContent = agent.icon;
    } else if (iconEl) {
      iconEl.remove();
    }
    // State badge
    const badge = this.querySelector('.state-badge');
    if (badge) {
      badge.className = `state-badge state-${agent.state}`;
      badge.textContent = agent.state;
    }
    // Name + unread
    const nameEl = this.querySelector('.agent-name');
    if (nameEl) {
      const unreadCount = ctx.unread || 0;
      const unreadBadge = unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : '';
      nameEl.innerHTML = `${esc(agent.name)}${unreadBadge}`;
    }
    // Meta
    const meta = this.querySelector('.agent-meta');
    if (meta) meta.innerHTML = buildMetaHtml(agent, ctx.proxies);
    // Failure
    let failEl = this.querySelector('.agent-failure');
    if (agent.state === 'failed' && agent.failureReason) {
      if (!failEl) {
        failEl = document.createElement('div');
        failEl.className = 'agent-failure';
        const m = this.querySelector('.agent-meta');
        if (m) m.after(failEl);
      }
      failEl.title = agent.failureReason;
      failEl.textContent = agent.failureReason;
    } else if (failEl) {
      failEl.remove();
    }
    // Indicators
    let indEl = this.querySelector('.indicator-badges');
    const inds = ctx.indicators || [];
    if (inds.length) {
      const indHtml = buildIndicatorsHtml(inds).replace(/^<div class="indicator-badges">|<\/div>$/g, '');
      if (!indEl) {
        indEl = document.createElement('div');
        indEl.className = 'indicator-badges';
        const handle = this.querySelector('.drag-handle');
        if (handle) handle.before(indEl);
      }
      indEl.innerHTML = indHtml;
    } else if (indEl) {
      indEl.remove();
    }
    // Actions
    const actions = this.querySelector('.agent-actions');
    if (actions) actions.innerHTML = buildActionsHtml(agent);
    // Selected
    this.classList.toggle('selected', !!ctx.selected);
  }
}

customElements.define('agent-card', AgentCard);
