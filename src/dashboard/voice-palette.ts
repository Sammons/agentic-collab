/**
 * Voice dictation and command palette module.
 * Handles mic capture, PCM streaming to orchestrator, and Cmd+K agent switcher.
 *
 * Exports:
 *   voiceState                — shared voice state object (used by message-io.js)
 *   setup({ selectAgent })   — wire cross-module dep (selectAgent called from palette)
 *   initVoice()              — init voice controls, mic acquisition, PTT/VAD modes
 *   initCommandPalette()     — init Cmd+K agent palette with fuzzy search
 */

import { state, getToken } from '/dashboard/assets/state.ts';
import { esc } from '/dashboard/assets/utils.ts';
import { updateSendability } from '/dashboard/assets/message-io.ts';

// ── Shared voice state (imported by message-io.js) ──

export const voiceState = {
  ws: null,        // WebSocket to orchestrator /ws/voice
  mode: 'off',     // off | vad | ptt
  recording: false,
  stream: null,    // MediaStream (active recording, acquired per press)
  audioCtx: null,  // AudioContext
  processor: null,  // ScriptProcessorNode
  sid: null,       // session ID
  usedSinceSend: false, // true if voice committed text since last send
};

// ── Dependencies injected via setup() ──

let _selectAgent = () => {};

export function setup({ selectAgent }) {
  _selectAgent = selectAgent;
}

// ── Voice ──

export async function initVoice() {
  const controls = document.getElementById('voiceControls');
  const toggle = document.getElementById('voiceToggle');
  const btn = document.getElementById('voiceBtn');

  // Check browser capabilities first — getUserMedia requires HTTPS (or localhost)
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    controls.style.display = 'flex';
    toggle.querySelectorAll('button').forEach(b => { b.disabled = true; b.style.opacity = '0.4'; });
    toggle.title = window.isSecureContext
      ? 'Voice unavailable — browser does not support getUserMedia'
      : 'Voice requires HTTPS — connect via https:// or localhost';
    return;
  }

  // Check if voice is enabled on the server
  try {
    const resp = await fetch('/api/voice/status', {
      headers: { 'Authorization': 'Bearer ' + getToken() },
    });
    const data = await resp.json();
    if (!data.enabled) {
      controls.style.display = 'flex';
      toggle.querySelectorAll('button').forEach(b => { b.disabled = true; b.style.opacity = '0.4'; });
      toggle.title = 'Voice unavailable — ELEVENLABS_API_KEY not configured on server';
      return;
    }
  } catch {
    return; // Server unreachable, hide controls entirely
  }

  controls.style.display = 'flex';

  async function setVoiceMode(mode) {
    voiceState.mode = mode;
    toggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    if (mode === 'off') {
      stopVoice();
      if (voiceState.audioCtx) {
        voiceState.audioCtx.close().catch(() => {});
        voiceState.audioCtx = null;
      }
      btn.classList.add('inactive');
    } else if (mode === 'ptt') {
      stopVoice();
      btn.classList.remove('inactive');
      // Pre-create AudioContext within user gesture (required for iOS Safari).
      // Do NOT acquire mic here — iOS shows hot-mic indicator for any live
      // MediaStream. Mic is acquired fresh on each press (pointerdown/touchstart
      // are user gestures so getUserMedia is allowed).
      try {
        if (!voiceState.audioCtx || voiceState.audioCtx.state === 'closed') {
          voiceState.audioCtx = new AudioContext({ sampleRate: 16000 });
        }
        if (voiceState.audioCtx.state === 'suspended') {
          await voiceState.audioCtx.resume();
        }
        console.log('[voice] PTT ready — AudioContext state:', voiceState.audioCtx.state, 'rate:', voiceState.audioCtx.sampleRate);
      } catch (err) {
        console.error('[voice] AudioContext creation failed:', err);
        document.getElementById('voicePartial').textContent = 'Audio init failed';
        setTimeout(() => { document.getElementById('voicePartial').textContent = ''; }, 3000);
        setVoiceMode('off');
      }
    }
  }

  // Prevent mousedown on voice controls from stealing focus/closing mobile keyboard
  toggle.addEventListener('mousedown', (e) => { e.preventDefault(); });
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); });

  toggle.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b || b.classList.contains('active')) return;
    setVoiceMode(b.dataset.mode);
    document.getElementById('threadInput')?.focus();
  });

  // Push-to-talk: hold button (pointer + touch events for mobile compatibility)
  function pttDown(e) {
    e.preventDefault();
    if (voiceState.mode !== 'ptt') return;
    // Resume AudioContext synchronously within user gesture (required for iOS Safari)
    if (voiceState.audioCtx && voiceState.audioCtx.state === 'suspended') {
      voiceState.audioCtx.resume();
    }
    startVoice();
  }
  function pttUp() {
    if (voiceState.mode !== 'ptt' || !voiceState.recording) return;
    commitAndStopPtt();
  }
  btn.addEventListener('pointerdown', pttDown);
  btn.addEventListener('pointerup', pttUp);
  btn.addEventListener('pointerleave', pttUp);
  btn.addEventListener('touchstart', pttDown, { passive: false });
  btn.addEventListener('touchend', pttUp);
  btn.addEventListener('touchcancel', pttUp);
  // Prevent context menu on long press
  btn.addEventListener('contextmenu', (e) => e.preventDefault());

  // Spacebar PTT when text input is not focused
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || voiceState.mode !== 'ptt') return;
    const tag = document.activeElement?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    if (voiceState.recording) return; // already recording
    e.preventDefault();
    startVoice();
  });
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || voiceState.mode !== 'ptt') return;
    const tag = document.activeElement?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    if (!voiceState.recording) return;
    e.preventDefault();
    commitAndStopPtt();
  });
}

// ── Voice internals ──

export function commitAndStopPtt() {
  if (voiceState.ws && voiceState.ws.readyState === WebSocket.OPEN) {
    voiceState.ws.send(JSON.stringify({ type: 'commit' }));
  }
  // Wait briefly for committed transcript then stop
  setTimeout(() => stopVoice(), 1500);
}

export async function startVoice() {
  if (voiceState.recording) return;

  // Acquire mic fresh on each press — iOS Safari requires getUserMedia within
  // a user gesture, and pointerdown/touchstart qualify. This avoids keeping
  // a persistent stream that triggers the hot-mic indicator.
  try {
    voiceState.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    console.error('[voice] Mic access denied:', err);
    document.getElementById('voicePartial').textContent = 'Mic denied';
    setTimeout(() => { document.getElementById('voicePartial').textContent = ''; }, 3000);
    return;
  }

  voiceState.sid = crypto.randomUUID();
  voiceState.recording = true;

  const btn = document.getElementById('voiceBtn');
  btn.classList.add('recording');

  // Reuse pre-created AudioContext (from PTT mode activation) or create new one
  if (!voiceState.audioCtx || voiceState.audioCtx.state === 'closed') {
    voiceState.audioCtx = new AudioContext({ sampleRate: 16000 });
  }
  if (voiceState.audioCtx.state === 'suspended') {
    await voiceState.audioCtx.resume();
  }
  const actualRate = voiceState.audioCtx.sampleRate;
  console.log('[voice] AudioContext state:', voiceState.audioCtx.state, 'rate:', actualRate);

  // Connect WebSocket to orchestrator voice proxy
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({
    sid: voiceState.sid,
    mode: voiceState.mode === 'ptt' ? 'manual' : 'vad',
    silence: '1.5',
    sample_rate: String(actualRate),
    token: getToken(),
  });
  const wsUrl = `${proto}://${location.host}/ws/voice?${params}`;
  const ws = new WebSocket(wsUrl);
  voiceState.ws = ws;

  ws.onopen = () => {
    console.log('[voice] Connected, sid=' + voiceState.sid);
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      const partial = document.getElementById('voicePartial');
      const inputEl = document.getElementById('threadInput');

      if (msg.type === 'partial') {
        partial.textContent = msg.text || '';
      } else if (msg.type === 'committed') {
        partial.textContent = '';
        if (msg.text && msg.text.trim()) {
          // Append to textarea via component and flag for voice-to-text prefix
          const current = inputEl.getDraft ? inputEl.getDraft() : '';
          const sep = current && !current.endsWith('\n') && !current.endsWith(' ') ? ' ' : '';
          inputEl.setDraft(current + sep + msg.text.trim());
          voiceState.usedSinceSend = true;
          updateSendability();
        }
      } else if (msg.type === 'error') {
        console.error('[voice] Error:', msg.error);
        partial.textContent = msg.error;
        setTimeout(() => { partial.textContent = ''; }, 5000);
        stopVoice();
      } else if (msg.type === 'ready') {
        document.getElementById('voicePartial').textContent = 'Listening...';
        setTimeout(() => {
          if (document.getElementById('voicePartial').textContent === 'Listening...')
            document.getElementById('voicePartial').textContent = '';
        }, 2000);
      }
    } catch { /* ignore */ }
  };

  ws.onclose = () => {
    if (voiceState.recording) {
      const partial = document.getElementById('voicePartial');
      partial.textContent = 'Voice disconnected';
      partial.style.color = 'var(--red)';
      setTimeout(() => { partial.textContent = ''; partial.style.color = ''; }, 3000);
      stopVoiceLocal();
    }
  };

  ws.onerror = () => {
    const partial = document.getElementById('voicePartial');
    partial.textContent = 'Voice connection failed';
    partial.style.color = 'var(--red)';
    setTimeout(() => { partial.textContent = ''; partial.style.color = ''; }, 3000);
    stopVoiceLocal();
  };

  // Audio capture pipeline
  const source = voiceState.audioCtx.createMediaStreamSource(voiceState.stream);
  // ScriptProcessor is deprecated but widely supported and simple for PCM capture
  voiceState.processor = voiceState.audioCtx.createScriptProcessor(4096, 1, 1);
  let audioChunkCount = 0;
  voiceState.processor.onaudioprocess = (e) => {
    if (!voiceState.recording || !ws || ws.readyState !== WebSocket.OPEN) return;
    audioChunkCount++;
    if (audioChunkCount % 50 === 1) console.log('[voice] Sending audio chunk', audioChunkCount);
    const float32 = e.inputBuffer.getChannelData(0);
    // Convert Float32 to Int16 PCM
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    // Send as binary
    ws.send(int16.buffer);
  };
  source.connect(voiceState.processor);
  voiceState.processor.connect(voiceState.audioCtx.destination);
}

function stopVoice() {
  if (voiceState.ws && voiceState.ws.readyState === WebSocket.OPEN) {
    voiceState.ws.close();
  }
  stopVoiceLocal();
}

function stopVoiceLocal() {
  voiceState.recording = false;
  voiceState.sid = null;

  document.getElementById('voiceBtn').classList.remove('recording');
  document.getElementById('voicePartial').textContent = '';

  if (voiceState.processor) {
    voiceState.processor.disconnect();
    voiceState.processor = null;
  }
  // Keep AudioContext alive in PTT mode — reuse across presses (iOS Safari
  // requires it to be created within a user gesture, so re-creating per press fails)
  if (voiceState.audioCtx && voiceState.mode !== 'ptt') {
    voiceState.audioCtx.close().catch(() => {});
    voiceState.audioCtx = null;
  }
  if (voiceState.stream) {
    voiceState.stream.getTracks().forEach(t => t.stop());
    voiceState.stream = null;
  }
  voiceState.ws = null;
}

// ── Command Palette (cmd+k / ctrl+k) ──

let paletteEl = null;
let selectedIdx = 0;
let filteredAgents = [];

function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { match: true, score: 0, ranges: [] };
  let qi = 0, score = 0, ranges = [], start = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (start === -1) start = ti;
      // Bonus for word start or consecutive
      if (ti === 0 || t[ti - 1] === '-' || t[ti - 1] === '_' || t[ti - 1] === ' ') score += 2;
      else if (start === ti - 1 || (ranges.length > 0 && ranges[ranges.length - 1][1] === ti)) score += 1;
      qi++;
    } else if (start !== -1) {
      ranges.push([start, ti]);
      start = -1;
    }
  }
  if (qi < q.length) return { match: false, score: 0, ranges: [] };
  if (start !== -1) ranges.push([start, q.length + start - (qi - (q.length - (q.length - qi)))]);
  // Rebuild ranges properly
  ranges = [];
  qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (ranges.length > 0 && ranges[ranges.length - 1][1] === ti) {
        ranges[ranges.length - 1][1] = ti + 1;
      } else {
        ranges.push([ti, ti + 1]);
      }
      qi++;
    }
  }
  return { match: true, score, ranges };
}

function highlightMatch(text, ranges) {
  if (!ranges.length) return esc(text);
  let result = '', last = 0;
  for (const [s, e] of ranges) {
    result += esc(text.slice(last, s)) + '<mark>' + esc(text.slice(s, e)) + '</mark>';
    last = e;
  }
  result += esc(text.slice(last));
  return result;
}

function stateColor(s) {
  const map = { active: 'var(--green)', idle: 'var(--yellow)', spawning: 'var(--accent)',
    suspended: 'var(--text-dim)', failed: 'var(--red)', void: 'var(--text-dim)' };
  return map[s] || 'var(--text-dim)';
}

function openPalette() {
  if (paletteEl) return;
  const overlay = document.createElement('div');
  overlay.className = 'cmd-palette-overlay';
  overlay.innerHTML = `
    <div class="cmd-palette">
      <input type="text" placeholder="Search agents..." autocomplete="off" spellcheck="false" />
      <div class="cmd-palette-results"></div>
      <div class="cmd-palette-hint">
        <span><kbd>↑↓</kbd> navigate</span>
        <span><kbd>Enter</kbd> select</span>
        <span><kbd>Esc</kbd> close</span>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  paletteEl = overlay;
  selectedIdx = 0;

  const input = overlay.querySelector('input');
  const results = overlay.querySelector('.cmd-palette-results');

  function render(query) {
    filteredAgents = [];
    for (const agent of state.agents) {
      const m = fuzzyMatch(query, agent.name);
      if (m.match) filteredAgents.push({ agent, ...m });
    }
    filteredAgents.sort((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name));
    if (selectedIdx >= filteredAgents.length) selectedIdx = Math.max(0, filteredAgents.length - 1);

    if (filteredAgents.length === 0) {
      results.innerHTML = '<div class="cmd-palette-empty">No agents found</div>';
      return;
    }
    results.innerHTML = filteredAgents.map((f, i) => {
      const a = f.agent;
      const unread = state.unread[a.name] || 0;
      return `<div class="cmd-palette-item${i === selectedIdx ? ' selected' : ''}" data-idx="${i}">
        <span class="cp-name">${highlightMatch(a.name, f.ranges)}</span>
        <span class="cp-engine">${a.engine || ''}</span>
        <span class="cp-state" style="color:${stateColor(a.state)}">${a.state}</span>
        ${unread ? `<span class="cp-unread">${unread}</span>` : ''}
      </div>`;
    }).join('');
  }

  render('');
  input.focus();

  input.addEventListener('input', () => {
    selectedIdx = 0;
    render(input.value.trim());
  });

  function selectCurrent() {
    if (filteredAgents[selectedIdx]) {
      _selectAgent(filteredAgents[selectedIdx].agent.name);
      closePalette();
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, filteredAgents.length - 1);
      render(input.value.trim());
      const sel = results.querySelector('.selected');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      render(input.value.trim());
      const sel = results.querySelector('.selected');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectCurrent();
    } else if (e.key === 'Escape') {
      closePalette();
    }
  });

  results.addEventListener('click', (e) => {
    const item = e.target.closest('.cmd-palette-item');
    if (item) {
      selectedIdx = parseInt(item.dataset.idx);
      selectCurrent();
    }
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePalette();
  });
}

function closePalette() {
  if (paletteEl) {
    paletteEl.remove();
    paletteEl = null;
  }
}

export function initCommandPalette() {
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      if (paletteEl) closePalette();
      else openPalette();
    }
  });
}
