#!/usr/bin/env node
/**
 * ClickUp Daily Tasks Page Generator
 *
 * Fetches all tasks due today from ClickUp, enriches with comments/subtasks,
 * and generates a local HTML file.
 *
 * Usage: node scripts/clickup-daily-page.js
 * Output: /tmp/clickup-today.html (auto-opens in browser)
 */

const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');

const TOKEN = process.env.CLICKUP_TOKEN;
const TEAM_ID = process.env.CLICKUP_TEAM_ID;
const ASSIGNEE_ID = process.env.CLICKUP_ASSIGNEE_ID || '30022936'; // Ben Thole

if (!TOKEN || !TEAM_ID) {
  console.error('Missing CLICKUP_TOKEN or CLICKUP_TEAM_ID env vars');
  process.exit(1);
}

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://api.clickup.com/api/v2${path}`, {
      headers: { Authorization: TOKEN }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function extractLinks(text) {
  if (!text) return [];
  const urlRegex = /https?:\/\/[^\s<>"')\]]+/g;
  const matches = text.match(urlRegex) || [];
  return [...new Set(matches)];
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function priorityLabel(p) {
  const map = { 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' };
  return map[p] || '';
}

function priorityColor(p) {
  const map = { 1: '#f44336', 2: '#ff9800', 3: '#2196f3', 4: '#9e9e9e' };
  return map[p] || '#666';
}

async function getTaskComments(taskId) {
  try {
    const data = await apiGet(`/task/${taskId}/comment`);
    return (data.comments || []).slice(0, 5).map(c => ({
      author: c.user?.username || c.user?.email || 'Unknown',
      text: c.comment_text || '',
      date: c.date ? new Date(parseInt(c.date)).toLocaleDateString() : ''
    }));
  } catch { return []; }
}

async function main() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 86400000 - 1);

  console.log(`Fetching tasks due ${startOfDay.toLocaleDateString()}...`);

  const result = await apiGet(
    `/team/${TEAM_ID}/task?assignees%5B%5D=${ASSIGNEE_ID}&due_date_gt=${startOfDay.getTime()}&due_date_lt=${endOfDay.getTime()}&include_closed=false&subtasks=true`
  );

  const tasks = result.tasks || [];
  console.log(`Found ${tasks.length} tasks`);

  // Enrich with comments (parallel, batched)
  console.log('Fetching comments...');
  const enriched = await Promise.all(tasks.map(async (task) => {
    const comments = await getTaskComments(task.id);
    const descLinks = extractLinks(task.description || '');
    const commentLinks = comments.flatMap(c => extractLinks(c.text));
    const allLinks = [...new Set([...descLinks, ...commentLinks])];

    // Custom fields with values
    const customFields = (task.custom_fields || [])
      .filter(cf => cf.value !== null && cf.value !== undefined && cf.value !== '')
      .map(cf => ({ name: cf.name, value: typeof cf.value === 'object' ? JSON.stringify(cf.value) : String(cf.value) }));

    return {
      id: task.id,
      name: task.name,
      description: task.text_content || task.description || '',
      status: task.status?.status || '',
      statusColor: task.status?.color || '#666',
      priority: task.priority?.priority || null,
      list: task.list?.name || '',
      folder: task.folder?.name || '',
      space: task.space?.name || '',
      url: task.url || '',
      deepLink: `clickup://t/${task.id}`,
      dueDate: task.due_date ? new Date(parseInt(task.due_date)).toLocaleString() : '',
      attachments: (task.attachments || []).map(a => ({ title: a.title || a.url, url: a.url })),
      subtasks: (task.subtasks || []).map(s => ({ name: s.name, status: s.status?.status || '' })),
      comments,
      links: allLinks,
      customFields
    };
  }));

  // Sort: urgent first, then by status
  enriched.sort((a, b) => {
    if (a.priority && b.priority) return a.priority - b.priority;
    if (a.priority) return -1;
    if (b.priority) return 1;
    return 0;
  });

  // Agent team help suggestions based on task content
  function suggestAgentHelp(task) {
    const hints = [];
    const name = (task.name + ' ' + task.description).toLowerCase();
    if (name.includes('copy') || name.includes('write') || name.includes('email') || name.includes('draft'))
      hints.push('MayaAngelou can draft or review copy');
    if (name.includes('research') || name.includes('find') || name.includes('audit') || name.includes('document'))
      hints.push('CristinaYang can research and compile findings');
    if (name.includes('graphic') || name.includes('design') || name.includes('image') || name.includes('video'))
      hints.push('Image generation skills available via /sp-image-generation');
    if (name.includes('survey') || name.includes('form'))
      hints.push('Gilfoyle can build form handling / data collection');
    if (name.includes('automation') || name.includes('email') || name.includes('sms') || name.includes('ghl'))
      hints.push('Gilfoyle can wire GHL automations and webhooks');
    if (name.includes('page') || name.includes('funnel') || name.includes('landing') || name.includes('registration'))
      hints.push('Gilfoyle can build or audit funnel pages');
    if (name.includes('ad') || name.includes('retarget') || name.includes('campaign'))
      hints.push('CristinaYang can analyze ad performance data');
    if (hints.length === 0)
      hints.push('CoachBeard can route this to the right agent — send details via collab');
    return hints;
  }

  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  // Generate HTML
  let taskCards = '';
  for (const task of enriched) {
    const agentHints = suggestAgentHelp(task);
    const prioLabel = priorityLabel(task.priority);
    const prioColor = priorityColor(task.priority);

    let linksHtml = '';
    if (task.links.length > 0) {
      linksHtml = '<div class="links"><strong>Links:</strong><ul>' +
        task.links.map(l => {
          const label = l.includes('docs.google') ? 'Google Doc' :
            l.includes('drive.google') ? 'Google Drive' :
            l.includes('clickup.com') ? 'ClickUp' :
            l.includes('zoom.us') ? 'Zoom' :
            l.replace(/^https?:\/\//, '').split('/')[0].split('?')[0].slice(0, 40);
          return `<li><a href="${escapeHtml(l)}" target="_blank">${escapeHtml(label)}</a></li>`;
        }).join('') + '</ul></div>';
    }

    let attachHtml = '';
    if (task.attachments.length > 0) {
      attachHtml = '<div class="links"><strong>Attachments:</strong><ul>' +
        task.attachments.map(a => `<li><a href="${escapeHtml(a.url)}" target="_blank">${escapeHtml(a.title)}</a></li>`).join('') +
        '</ul></div>';
    }

    let subtaskHtml = '';
    if (task.subtasks.length > 0) {
      subtaskHtml = '<div class="subtasks"><strong>Subtasks:</strong><ul>' +
        task.subtasks.map(s => `<li><span class="subtask-status">${escapeHtml(s.status)}</span> ${escapeHtml(s.name)}</li>`).join('') +
        '</ul></div>';
    }

    let commentsHtml = '';
    if (task.comments.length > 0) {
      commentsHtml = '<div class="comments"><strong>Comments:</strong>' +
        task.comments.map(c =>
          `<div class="comment"><span class="comment-author">${escapeHtml(c.author)}</span> <span class="comment-date">${escapeHtml(c.date)}</span><p>${escapeHtml(c.text).slice(0, 500)}</p></div>`
        ).join('') + '</div>';
    }

    let customHtml = '';
    if (task.customFields.length > 0) {
      customHtml = '<div class="custom-fields"><strong>Custom Fields:</strong><ul>' +
        task.customFields.map(cf => `<li><span class="cf-name">${escapeHtml(cf.name)}:</span> ${escapeHtml(cf.value)}</li>`).join('') +
        '</ul></div>';
    }

    const agentHtml = '<div class="agent-help"><strong>Agent Team Can Help:</strong><ul>' +
      agentHints.map(h => `<li>${escapeHtml(h)}</li>`).join('') + '</ul></div>';

    taskCards += `
    <div class="task-card">
      <div class="task-header">
        <div class="task-meta">
          <span class="status-badge" style="background:${escapeHtml(task.statusColor)}">${escapeHtml(task.status)}</span>
          ${prioLabel ? `<span class="priority-badge" style="background:${prioColor}">${prioLabel}</span>` : ''}
          <span class="breadcrumb">${escapeHtml([task.space, task.folder, task.list].filter(Boolean).join(' / '))}</span>
        </div>
        <div class="task-links">
          <a href="${escapeHtml(task.deepLink)}" class="btn btn-app" title="Open in ClickUp app">App</a>
          <a href="${escapeHtml(task.url)}" target="_blank" class="btn btn-web" title="Open in browser">Web</a>
        </div>
      </div>
      <h2 class="task-title">${escapeHtml(task.name)}</h2>
      ${task.description ? `<p class="task-desc">${escapeHtml(task.description).slice(0, 1000)}</p>` : ''}
      ${linksHtml}${attachHtml}${subtaskHtml}${customHtml}${commentsHtml}${agentHtml}
    </div>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClickUp — Due Today (${dateStr})</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f1a; color: #e5e7eb; padding: 24px; }
  .header { max-width: 900px; margin: 0 auto 24px; }
  .header h1 { font-size: 28px; color: #fff; margin-bottom: 4px; }
  .header .subtitle { color: #9ca3af; font-size: 14px; }
  .header .count { color: #60a5fa; font-weight: 600; }
  .task-card { max-width: 900px; margin: 0 auto 16px; background: #1a1a2e; border: 1px solid #374151; border-radius: 12px; padding: 20px; }
  .task-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px; }
  .task-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .status-badge { font-size: 11px; font-weight: 600; color: #fff; padding: 2px 10px; border-radius: 12px; text-transform: uppercase; }
  .priority-badge { font-size: 11px; font-weight: 600; color: #fff; padding: 2px 10px; border-radius: 12px; }
  .breadcrumb { font-size: 12px; color: #6b7280; }
  .task-links { display: flex; gap: 6px; }
  .btn { font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 6px; text-decoration: none; }
  .btn-app { background: #7c3aed; color: #fff; }
  .btn-app:hover { background: #6d28d9; }
  .btn-web { background: #374151; color: #d1d5db; }
  .btn-web:hover { background: #4b5563; }
  .task-title { font-size: 18px; color: #fff; margin-bottom: 8px; line-height: 1.3; }
  .task-desc { font-size: 13px; color: #9ca3af; margin-bottom: 12px; white-space: pre-wrap; line-height: 1.5; }
  .links, .subtasks, .comments, .custom-fields, .agent-help { margin-top: 12px; font-size: 13px; }
  .links strong, .subtasks strong, .comments strong, .custom-fields strong, .agent-help strong { color: #d1d5db; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .links ul, .subtasks ul, .custom-fields ul, .agent-help ul { list-style: none; margin-top: 4px; }
  .links li, .custom-fields li { padding: 2px 0; }
  .links a { color: #60a5fa; text-decoration: none; }
  .links a:hover { text-decoration: underline; }
  .subtasks li { padding: 3px 0; color: #d1d5db; }
  .subtask-status { font-size: 11px; background: #374151; padding: 1px 8px; border-radius: 8px; margin-right: 6px; }
  .comment { margin-top: 8px; padding: 8px 12px; background: #111827; border-radius: 8px; }
  .comment-author { font-weight: 600; color: #60a5fa; font-size: 12px; }
  .comment-date { color: #6b7280; font-size: 11px; }
  .comment p { color: #9ca3af; margin-top: 4px; font-size: 13px; white-space: pre-wrap; }
  .cf-name { color: #9ca3af; }
  .agent-help { background: #1e1b4b; border: 1px solid #312e81; border-radius: 8px; padding: 12px; margin-top: 12px; }
  .agent-help li { padding: 3px 0; color: #a5b4fc; }
  .agent-help li::before { content: '\\2192 '; color: #6366f1; }
</style>
</head>
<body>
<div class="header">
  <h1>Due Today</h1>
  <p class="subtitle">${dateStr} &mdash; <span class="count">${tasks.length} tasks</span></p>
</div>
${taskCards || '<div style="max-width:900px;margin:0 auto;text-align:center;color:#6b7280;padding:60px 0;">No tasks due today.</div>'}
<div style="max-width:900px;margin:24px auto;text-align:center;color:#4b5563;font-size:12px;">Generated ${now.toLocaleTimeString()}</div>
</body>
</html>`;

  const outPath = '/tmp/clickup-today.html';
  fs.writeFileSync(outPath, html);
  console.log(`Written to ${outPath}`);

  try { execSync(`open "${outPath}"`); } catch {}
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
