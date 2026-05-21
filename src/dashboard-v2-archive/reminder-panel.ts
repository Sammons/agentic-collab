/**
 * <reminder-panel> Web Component.
 * CRUD for agent reminders: create, edit, complete, delete, reorder.
 *
 * Usage:
 *   const panel = document.querySelector('reminder-panel');
 *   panel.load(agentName);  // fetch and render reminders
 */

import { state, authHeaders } from '/dashboard/assets/state.ts';
import { esc } from '/dashboard/assets/utils.ts';
import { icon } from '/dashboard/assets/icons.ts';

function renderReminderCard(r, opts = {}) {
  const { isActive = false, prevPending = null, nextPending = null } = opts;
  const classes = ['reminder-item'];
  if (isActive) classes.push('active');
  if (r.status === 'completed') classes.push('completed');

  const cadenceLabel = r.cadenceMinutes >= 60
    ? `every ${Math.round(r.cadenceMinutes / 60)}h`
    : `every ${r.cadenceMinutes}m`;
  const createdByHtml = r.createdBy
    ? `<span>by ${esc(r.createdBy)}</span>`
    : '';
  const completedHtml = r.completedAt
    ? `<span>completed ${esc(new Date(r.completedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span>`
    : '';

  let actionBtns = '';
  if (r.status === 'pending') {
    actionBtns += `<button class="complete" data-action="complete" data-id="${r.id}" title="Complete">${icon.check(14)}</button>`;
    actionBtns += `<button data-action="edit" data-id="${r.id}" data-prompt="${esc(r.prompt)}" data-cadence="${r.cadenceMinutes}" data-skip-if-active="${r.skipIfActive ? '1' : '0'}" title="Edit">${icon.edit(14)}</button>`;
  }
  if (prevPending && r.status === 'pending') {
    actionBtns += `<button data-action="move-up" data-id="${r.id}" data-swap="${prevPending.id}" title="Move up">${icon.arrowUp(12)}</button>`;
  }
  if (nextPending && r.status === 'pending') {
    actionBtns += `<button data-action="move-down" data-id="${r.id}" data-swap="${nextPending.id}" title="Move down">${icon.arrowDown(12)}</button>`;
  }
  actionBtns += `<button class="danger" data-action="delete" data-id="${r.id}" title="Delete">${icon.x(14)}</button>`;

  return `<div class="${classes.join(' ')}">
    <div class="reminder-content">
      <div class="reminder-prompt">${isActive ? icon.play(12) + ' ' : ''}${esc(r.prompt)}</div>
      <div class="reminder-meta">
        <span>${cadenceLabel}</span>
        ${r.skipIfActive ? '<span style="font-size:11px;color:var(--yellow,#d29922);font-weight:600">skip if active</span>' : ''}
        <span class="reminder-badge ${isActive ? 'active' : r.status}">${isActive ? 'active' : r.status === 'pending' ? 'queued' : r.status}</span>
        ${createdByHtml}
        ${completedHtml}
      </div>
    </div>
    <div class="reminder-actions">${actionBtns}</div>
  </div>`;
}

export class ReminderPanel extends HTMLElement {
  _agent = null;

  /** Fetch and render reminders for the given agent. */
  async load(agentName) {
    this._agent = agentName;
    if (!agentName) return;
    this.innerHTML = '<div class="reminder-empty">Loading...</div>';
    try {
      const res = await fetch(`/api/reminders?agent=${encodeURIComponent(agentName)}`, {
        headers: authHeaders(),
      });
      if (this._agent !== agentName) return;
      if (!res.ok) {
        this.innerHTML = '<div class="reminder-empty">Failed to load reminders</div>';
        return;
      }
      const reminders = await res.json();
      const pendingReminders = reminders
        .filter(r => r.status === 'pending')
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const completedReminders = reminders
        .filter(r => r.status === 'completed')
        .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));

      let html = `<div class="reminder-add-form">
        <textarea id="reminderPrompt" placeholder="Reminder prompt..." rows="2"></textarea>
        <div class="reminder-form-row">
          <input type="number" id="reminderCadence" min="5" placeholder="Minutes" value="30" />
          <span style="color:var(--text-dim);font-size:12px">min cadence</span>
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text-dim);cursor:pointer;margin-left:4px"><input type="checkbox" id="reminderSkipIfActive" /> Skip if active</label>
          <button id="reminderAddBtn">Add</button>
        </div>
      </div>`;

      if (pendingReminders.length === 0 && completedReminders.length === 0) {
        html += '<div class="reminder-empty">No reminders for this agent</div>';
      } else {
        if (pendingReminders.length > 0) {
          for (let i = 0; i < pendingReminders.length; i++) {
            html += renderReminderCard(pendingReminders[i], {
              isActive: i === 0,
              prevPending: pendingReminders[i - 1] || null,
              nextPending: pendingReminders[i + 1] || null,
            });
          }
        }
        if (completedReminders.length > 0) {
          html += '<div class="reminder-section-label">Recently completed</div>';
          for (const r of completedReminders) {
            html += renderReminderCard(r);
          }
        }
      }

      this.innerHTML = html;
      this._bindAddHandler(agentName);
      this._bindActionHandlers(agentName);
    } catch (err) {
      console.error('Reminder load failed:', err);
      this.innerHTML = '<div class="reminder-empty">Failed to load reminders</div>';
    }
  }

  _bindAddHandler(agentName) {
    const addBtn = this.querySelector('#reminderAddBtn');
    if (!addBtn) return;
    addBtn.onclick = async () => {
      const prompt = this.querySelector('#reminderPrompt').value.trim();
      const cadence = parseInt(this.querySelector('#reminderCadence').value, 10);
      const skipIfActive = this.querySelector('#reminderSkipIfActive').checked;
      if (!prompt) return;
      try {
        await fetch('/api/reminders', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            agentName,
            prompt,
            cadenceMinutes: cadence || 30,
            skipIfActive,
          }),
        });
        this.load(agentName);
      } catch (err) {
        console.error('Add reminder failed:', err);
      }
    };
  }

  _bindActionHandlers(agentName) {
    this.querySelectorAll('.reminder-actions button[data-action]').forEach(btn => {
      btn.onclick = async () => {
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        try {
          if (action === 'complete') {
            await fetch(`/api/reminders/${id}/complete`, {
              method: 'POST', headers: authHeaders(),
            });
          } else if (action === 'delete') {
            await fetch(`/api/reminders/${id}`, {
              method: 'DELETE', headers: authHeaders(),
            });
          } else if (action === 'edit') {
            this._openEditModal(id, btn, agentName);
            return;
          } else if (action === 'move-up' || action === 'move-down') {
            const swapId = btn.dataset.swap;
            await fetch('/api/reminders/swap', {
              method: 'POST',
              headers: authHeaders(),
              body: JSON.stringify({ a: parseInt(id, 10), b: parseInt(swapId, 10) }),
            });
          }
          this.load(agentName);
        } catch (err) {
          console.error('Reminder action failed:', err);
        }
      };
    });
  }

  _openEditModal(id, btn, agentName) {
    const oldPrompt = btn.dataset.prompt;
    const oldCadence = parseInt(btn.dataset.cadence, 10);
    const oldSkip = btn.dataset.skipIfActive === '1';

    const overlay = document.createElement('div');
    overlay.className = 'reminder-edit-overlay';
    overlay.innerHTML = `
      <div class="reminder-edit-modal">
        <textarea id="editReminderPrompt">${esc(oldPrompt)}</textarea>
        <div class="edit-row">
          <input type="number" id="editReminderCadence" value="${oldCadence}" min="5" />
          <span style="font-size:13px;color:var(--text-dim)">min cadence</span>
        </div>
        <div class="edit-row">
          <label><input type="checkbox" id="editSkipIfActive" ${oldSkip ? 'checked' : ''} /> Skip if agent is active</label>
        </div>
        <div class="actions">
          <button class="cancel" id="editReminderCancel">Cancel</button>
          <button class="save" id="editReminderSave">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#editReminderCancel').onclick = () => overlay.remove();
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#editReminderSave').onclick = async () => {
      const newPrompt = overlay.querySelector('#editReminderPrompt').value.trim();
      const newCadence = parseInt(overlay.querySelector('#editReminderCadence').value, 10);
      const newSkip = overlay.querySelector('#editSkipIfActive').checked;
      if (!newPrompt) return;
      await fetch(`/api/reminders/${id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: newPrompt,
          cadenceMinutes: isNaN(newCadence) ? undefined : newCadence,
          skipIfActive: newSkip,
        }),
      });
      overlay.remove();
      this.load(agentName);
    };

    setTimeout(() => overlay.querySelector('#editReminderPrompt').focus(), 50);
  }
}

customElements.define('reminder-panel', ReminderPanel);
