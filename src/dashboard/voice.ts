/**
 * Voice dictation module — press-to-talk (PTT) mode.
 * Captures mic audio, streams PCM to /ws/voice, and appends committed
 * transcripts to a target textarea.
 *
 * Ported from v2 dashboard voice-palette.ts.
 */

import { state } from './state.ts';

// Voice state shared across the module
export const voiceState = {
  ws: null as WebSocket | null,
  mode: 'off' as 'off' | 'ptt',
  recording: false,
  stream: null as MediaStream | null,
  audioCtx: null as AudioContext | null,
  processor: null as ScriptProcessorNode | null,
  source: null as MediaStreamAudioSourceNode | null,
  sid: null as string | null,
  usedSinceSend: false,
  commitTimeout: null as ReturnType<typeof setTimeout> | null,
};

let targetInput: HTMLTextAreaElement | null = null;
let statusEl: HTMLElement | null = null;

/**
 * Initialize voice controls. Call once when the chat pane mounts.
 * @param input - textarea to append transcripts to
 * @param status - element to show partial transcripts / status
 * @param toggleContainer - container with mode toggle buttons
 * @param pttButton - the push-to-talk button
 */
export async function initVoice(
  input: HTMLTextAreaElement,
  status: HTMLElement,
  toggleContainer: HTMLElement,
  pttButton: HTMLElement,
): Promise<void> {
  targetInput = input;
  statusEl = status;

  // Check browser capabilities
  if (!navigator.mediaDevices?.getUserMedia) {
    toggleContainer.querySelectorAll('button').forEach((b) => {
      (b as HTMLButtonElement).disabled = true;
      b.style.opacity = '0.4';
    });
    toggleContainer.title = window.isSecureContext
      ? 'Voice unavailable — browser does not support getUserMedia'
      : 'Voice requires HTTPS — connect via https:// or localhost';
    return;
  }

  // Check server support
  try {
    const headers: Record<string, string> = {};
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    const resp = await fetch('/api/voice/status', { headers });
    const data = await resp.json() as { enabled?: boolean };
    if (!data.enabled) {
      toggleContainer.querySelectorAll('button').forEach((b) => {
        (b as HTMLButtonElement).disabled = true;
        b.style.opacity = '0.4';
      });
      toggleContainer.title = 'Voice unavailable — ELEVENLABS_API_KEY not configured';
      return;
    }
  } catch {
    // Server unreachable — hide controls
    toggleContainer.style.display = 'none';
    return;
  }

  // Wire mode toggle
  toggleContainer.addEventListener('mousedown', (e) => e.preventDefault());
  pttButton.addEventListener('mousedown', (e) => e.preventDefault());

  toggleContainer.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-mode]') as HTMLButtonElement | null;
    if (!b || b.classList.contains('active')) return;
    const mode = b.dataset['mode'] as 'off' | 'ptt';
    setVoiceMode(mode, toggleContainer, pttButton);
    input.focus();
  });

  // PTT button handlers
  const pttDown = (e: Event) => {
    e.preventDefault();
    if (voiceState.mode !== 'ptt') return;
    if (voiceState.audioCtx?.state === 'suspended') {
      voiceState.audioCtx.resume();
    }
    startVoice();
  };
  const pttUp = () => {
    if (voiceState.mode !== 'ptt' || !voiceState.recording) return;
    commitAndStopPtt();
  };

  pttButton.addEventListener('pointerdown', pttDown);
  pttButton.addEventListener('pointerup', pttUp);
  pttButton.addEventListener('pointerleave', pttUp);
  pttButton.addEventListener('touchstart', pttDown, { passive: false });
  pttButton.addEventListener('touchend', pttUp);
  pttButton.addEventListener('touchcancel', pttUp);
  pttButton.addEventListener('contextmenu', (e) => e.preventDefault());

  // Spacebar PTT when not in an input
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || voiceState.mode !== 'ptt') return;
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    if (voiceState.recording) return;
    e.preventDefault();
    startVoice();
  });
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || voiceState.mode !== 'ptt') return;
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    if (!voiceState.recording) return;
    e.preventDefault();
    commitAndStopPtt();
  });
}

async function setVoiceMode(
  mode: 'off' | 'ptt',
  toggle: HTMLElement,
  btn: HTMLElement,
): Promise<void> {
  voiceState.mode = mode;
  toggle.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', (b as HTMLElement).dataset['mode'] === mode)
  );

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
    try {
      if (!voiceState.audioCtx || voiceState.audioCtx.state === 'closed') {
        voiceState.audioCtx = new AudioContext({ sampleRate: 16000 });
      }
      if (voiceState.audioCtx.state === 'suspended') {
        await voiceState.audioCtx.resume();
      }
    } catch (err) {
      console.error('[voice] AudioContext creation failed:', err);
      showStatus('Audio init failed', 3000);
      setVoiceMode('off', toggle, btn);
    }
  }
}

function showStatus(text: string, duration = 0): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.style.display = text ? 'block' : 'none';
  if (duration > 0) {
    setTimeout(() => {
      if (statusEl?.textContent === text) {
        statusEl.textContent = '';
        statusEl.style.display = 'none';
      }
    }, duration);
  }
}

export function commitAndStopPtt(): void {
  if (voiceState.ws?.readyState === WebSocket.OPEN) {
    voiceState.ws.send(JSON.stringify({ type: 'commit' }));
  }
  voiceState.commitTimeout = setTimeout(() => stopVoice(), 1500);
}

export async function startVoice(): Promise<void> {
  if (voiceState.recording) return;

  try {
    voiceState.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    console.error('[voice] Mic access denied:', err);
    showStatus('Mic denied', 3000);
    return;
  }

  voiceState.sid = crypto.randomUUID();
  voiceState.recording = true;

  const pttBtn = document.querySelector('[data-voice-btn]');
  pttBtn?.classList.add('recording');

  if (!voiceState.audioCtx || voiceState.audioCtx.state === 'closed') {
    voiceState.audioCtx = new AudioContext({ sampleRate: 16000 });
  }
  if (voiceState.audioCtx.state === 'suspended') {
    await voiceState.audioCtx.resume();
  }
  const actualRate = voiceState.audioCtx.sampleRate;

  // Connect WebSocket
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({
    sid: voiceState.sid,
    mode: 'manual',
    silence: '1.5',
    sample_rate: String(actualRate),
  });
  if (state.token) params.set('token', state.token);
  const ws = new WebSocket(`${proto}://${location.host}/ws/voice?${params}`);
  voiceState.ws = ws;

  ws.onopen = () => console.log('[voice] Connected, sid=' + voiceState.sid);

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data) as { type: string; text?: string; error?: string };
      if (msg.type === 'partial') {
        showStatus(msg.text ?? '');
      } else if (msg.type === 'committed') {
        showStatus('', 0);
        if (msg.text?.trim() && targetInput) {
          const current = targetInput.value;
          const sep = current && !current.endsWith('\n') && !current.endsWith(' ') ? ' ' : '';
          targetInput.value = current + sep + msg.text.trim();
          targetInput.dispatchEvent(new Event('input'));
          voiceState.usedSinceSend = true;
        }
      } else if (msg.type === 'error') {
        console.error('[voice] Error:', msg.error);
        showStatus(msg.error ?? 'Error', 5000);
        stopVoice();
      } else if (msg.type === 'ready') {
        showStatus('Listening...', 2000);
      }
    } catch { /* ignore */ }
  };

  ws.onclose = () => {
    if (voiceState.recording) {
      showStatus('Voice disconnected', 3000);
      stopVoiceLocal();
    }
  };

  ws.onerror = () => {
    showStatus('Voice connection failed', 3000);
    stopVoiceLocal();
  };

  // Audio capture
  voiceState.source = voiceState.audioCtx.createMediaStreamSource(voiceState.stream);
  voiceState.processor = voiceState.audioCtx.createScriptProcessor(4096, 1, 1);

  voiceState.processor.onaudioprocess = (e) => {
    if (!voiceState.recording || !ws || ws.readyState !== WebSocket.OPEN) return;
    const float32 = e.inputBuffer.getChannelData(0);
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    ws.send(int16.buffer);
  };

  voiceState.source.connect(voiceState.processor);
  voiceState.processor.connect(voiceState.audioCtx.destination);
}

export function stopVoice(): void {
  if (voiceState.ws?.readyState === WebSocket.OPEN) {
    voiceState.ws.close();
  }
  stopVoiceLocal();
}

function stopVoiceLocal(): void {
  if (voiceState.commitTimeout) {
    clearTimeout(voiceState.commitTimeout);
    voiceState.commitTimeout = null;
  }

  voiceState.recording = false;
  voiceState.sid = null;

  const pttBtn = document.querySelector('[data-voice-btn]');
  pttBtn?.classList.remove('recording');
  showStatus('', 0);

  if (voiceState.source) {
    voiceState.source.disconnect();
    voiceState.source = null;
  }
  if (voiceState.processor) {
    voiceState.processor.disconnect();
    voiceState.processor = null;
  }
  if (voiceState.audioCtx && voiceState.mode !== 'ptt') {
    voiceState.audioCtx.close().catch(() => {});
    voiceState.audioCtx = null;
  }
  if (voiceState.stream) {
    voiceState.stream.getTracks().forEach((t) => t.stop());
    voiceState.stream = null;
  }
  voiceState.ws = null;
}

/** Reset the "used since send" flag after sending a message. */
export function clearUsedFlag(): void {
  voiceState.usedSinceSend = false;
}
