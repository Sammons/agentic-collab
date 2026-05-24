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
  // STT provider negotiated from /api/voice/status. ElevenLabs streams
  // PCM frames over a WebSocket; Whisper records a clip with
  // MediaRecorder and POSTs it as a batch on release.
  provider: null as 'elevenlabs' | 'whisper' | null,
  recorder: null as MediaRecorder | null,
  recordedChunks: [] as Blob[],
};

let targetInput: HTMLTextAreaElement | null = null;
let statusEl: HTMLElement | null = null;

/**
 * Initialize voice controls. Call once when the chat pane mounts.
 * @param input - textarea to append transcripts to
 * @param status - element to show partial transcripts / status
 * @param toggleContainer - container with mode toggle buttons
 * @param pttButton - the push-to-talk button
 * @returns cleanup function to remove event listeners
 */
export async function initVoice(
  input: HTMLTextAreaElement,
  status: HTMLElement,
  toggleContainer: HTMLElement,
  pttButton: HTMLElement,
): Promise<() => void> {
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
    return () => {};
  }

  // Check server support
  try {
    const headers: Record<string, string> = {};
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    const resp = await fetch('/api/voice/status', { headers });
    const data = await resp.json() as {
      enabled?: boolean;
      providers?: { elevenlabs?: boolean; whisper?: boolean };
      defaultProvider?: 'elevenlabs' | 'whisper' | null;
    };
    if (!data.enabled) {
      toggleContainer.querySelectorAll('button').forEach((b) => {
        (b as HTMLButtonElement).disabled = true;
        b.style.opacity = '0.4';
      });
      toggleContainer.title = 'Voice unavailable — set ELEVENLABS_API_KEY or WHISPER_URL';
      return () => {};
    }
    voiceState.provider = data.defaultProvider
      ?? (data.providers?.elevenlabs ? 'elevenlabs'
        : data.providers?.whisper ? 'whisper'
        : null);
  } catch {
    // Server unreachable — hide controls
    toggleContainer.style.display = 'none';
    return () => {};
  }

  // Wire mode toggle
  const toggleMousedown = (e: Event) => e.preventDefault();
  const pttMousedown = (e: Event) => e.preventDefault();
  toggleContainer.addEventListener('mousedown', toggleMousedown);
  pttButton.addEventListener('mousedown', pttMousedown);

  const toggleClick = (e: Event) => {
    const b = (e.target as HTMLElement).closest('button[data-mode]') as HTMLButtonElement | null;
    if (!b || b.classList.contains('active')) return;
    const mode = b.dataset['mode'] as 'off' | 'ptt';
    setVoiceMode(mode, toggleContainer, pttButton);
    input.focus();
  };
  toggleContainer.addEventListener('click', toggleClick);

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
  const pttContextmenu = (e: Event) => e.preventDefault();

  pttButton.addEventListener('pointerdown', pttDown);
  pttButton.addEventListener('pointerup', pttUp);
  pttButton.addEventListener('pointerleave', pttUp);
  pttButton.addEventListener('touchstart', pttDown, { passive: false });
  pttButton.addEventListener('touchend', pttUp);
  pttButton.addEventListener('touchcancel', pttUp);
  pttButton.addEventListener('contextmenu', pttContextmenu);

  // Spacebar PTT when not in an input
  const keydownHandler = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || e.repeat || voiceState.mode !== 'ptt') return;
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    if (voiceState.recording) return;
    e.preventDefault();
    startVoice();
  };
  const keyupHandler = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || voiceState.mode !== 'ptt') return;
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    if (!voiceState.recording) return;
    e.preventDefault();
    commitAndStopPtt();
  };
  document.addEventListener('keydown', keydownHandler);
  document.addEventListener('keyup', keyupHandler);

  // Return cleanup function
  return () => {
    stopVoice();
    toggleContainer.removeEventListener('mousedown', toggleMousedown);
    toggleContainer.removeEventListener('click', toggleClick);
    pttButton.removeEventListener('mousedown', pttMousedown);
    pttButton.removeEventListener('pointerdown', pttDown);
    pttButton.removeEventListener('pointerup', pttUp);
    pttButton.removeEventListener('pointerleave', pttUp);
    pttButton.removeEventListener('touchstart', pttDown);
    pttButton.removeEventListener('touchend', pttUp);
    pttButton.removeEventListener('touchcancel', pttUp);
    pttButton.removeEventListener('contextmenu', pttContextmenu);
    document.removeEventListener('keydown', keydownHandler);
    document.removeEventListener('keyup', keyupHandler);
    if (voiceState.audioCtx) {
      voiceState.audioCtx.close().catch(() => {});
      voiceState.audioCtx = null;
    }
  };
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
    // AudioContext is only needed for the ElevenLabs PCM streaming path.
    // Whisper records via MediaRecorder which manages its own pipeline.
    if (voiceState.provider === 'elevenlabs') {
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
  if (voiceState.provider === 'whisper') {
    // MediaRecorder.stop() fires `dataavailable` then `stop`; the stop
    // handler POSTs the assembled blob. stopVoice() is called by the
    // upload pipeline once the request completes (success or fail).
    if (voiceState.recorder && voiceState.recorder.state === 'recording') {
      voiceState.recorder.stop();
    }
    return;
  }
  if (voiceState.ws?.readyState === WebSocket.OPEN) {
    voiceState.ws.send(JSON.stringify({ type: 'commit' }));
  }
  voiceState.commitTimeout = setTimeout(() => stopVoice(), 1500);
}

export async function startVoice(): Promise<void> {
  if (voiceState.recording) return;
  if (voiceState.provider === 'whisper') {
    return startVoiceWhisper();
  }
  return startVoiceElevenlabs();
}

async function startVoiceElevenlabs(): Promise<void> {
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
        if (msg.text?.trim()) {
          appendTranscript(msg.text.trim());
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

async function startVoiceWhisper(): Promise<void> {
  if (typeof MediaRecorder === 'undefined') {
    showStatus('MediaRecorder unsupported', 3000);
    return;
  }
  try {
    voiceState.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    console.error('[voice] Mic access denied:', err);
    showStatus('Mic denied', 3000);
    return;
  }

  voiceState.recording = true;
  voiceState.recordedChunks = [];
  const pttBtn = document.querySelector('[data-voice-btn]');
  pttBtn?.classList.add('recording');
  showStatus('Recording...', 0);

  // Prefer audio/webm;codecs=opus (Chrome/Firefox default, well-accepted
  // by Whisper). Safari currently emits audio/mp4 — also accepted.
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';

  let recorder: MediaRecorder;
  try {
    recorder = mimeType
      ? new MediaRecorder(voiceState.stream, { mimeType })
      : new MediaRecorder(voiceState.stream);
  } catch (err) {
    console.error('[voice] MediaRecorder init failed:', err);
    showStatus('Recorder init failed', 3000);
    stopVoiceLocal();
    return;
  }
  voiceState.recorder = recorder;

  recorder.ondataavailable = (e: BlobEvent) => {
    if (e.data && e.data.size > 0) voiceState.recordedChunks.push(e.data);
  };
  recorder.onerror = (e) => {
    console.error('[voice] MediaRecorder error:', e);
    showStatus('Recorder error', 3000);
    stopVoiceLocal();
  };
  recorder.onstop = () => {
    const chunks = voiceState.recordedChunks;
    voiceState.recordedChunks = [];
    const type = recorder.mimeType || mimeType || 'audio/webm';
    const blob = new Blob(chunks, { type });
    voiceState.recorder = null;
    // Stop the mic immediately — upload runs without it.
    if (voiceState.stream) {
      voiceState.stream.getTracks().forEach((t) => t.stop());
      voiceState.stream = null;
    }
    if (blob.size === 0) {
      stopVoiceLocal();
      return;
    }
    void uploadWhisperClip(blob);
  };

  recorder.start();
}

async function uploadWhisperClip(blob: Blob): Promise<void> {
  showStatus('Transcribing...', 0);
  try {
    const headers: Record<string, string> = { 'Content-Type': blob.type || 'audio/webm' };
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    const resp = await fetch('/api/voice/transcribe', {
      method: 'POST',
      headers,
      body: blob,
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
    }
    const data = await resp.json() as { text?: string };
    const text = data.text?.trim() ?? '';
    if (text) {
      appendTranscript(text);
    }
    showStatus('', 0);
  } catch (err) {
    console.error('[voice] Whisper transcribe failed:', err);
    showStatus((err as Error).message || 'Transcribe failed', 4000);
  } finally {
    stopVoiceLocal();
  }
}

function appendTranscript(text: string): void {
  if (!targetInput) return;
  const current = targetInput.value;
  const sep = current && !current.endsWith('\n') && !current.endsWith(' ') ? ' ' : '';
  targetInput.value = current + sep + text;
  targetInput.dispatchEvent(new Event('input'));
  voiceState.usedSinceSend = true;
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

  if (voiceState.recorder) {
    if (voiceState.recorder.state !== 'inactive') {
      try { voiceState.recorder.stop(); } catch { /* ignore */ }
    }
    voiceState.recorder = null;
  }
  voiceState.recordedChunks = [];

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
