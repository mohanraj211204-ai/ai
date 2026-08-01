/* =========================================================================
   FocusGuard — AI Study Monitor
   Pure client-side implementation. No backend, no uploads.
   Sections: Config, LocalStorage Manager, Settings Manager, Camera Manager,
   AI Model Manager, Phone Detector, Face/Eye Detector, Detection State
   Manager, Alert Video Manager, Study Timer, Statistics Manager, UI Manager,
   Bootstrapping.
   ========================================================================= */

'use strict';

/* =========================================================================
   CONFIGURATION — edit these to tune behavior
   ========================================================================= */
const CONFIG = {
  // Local, bundled video file — no network fetch, no cloud provider.
  ALERT_VIDEO_URL: "./assets/videos/alert.mp4",

  PHONE_CONFIDENCE: 0.60,        // 0.3 - 0.9
  PHONE_CONFIRMATION_MS: 2500,   // continuous detection required before alert

  EYE_CLOSED_CONFIRMATION_MS: 3000,

  ALERT_COOLDOWN_MS: 5000,

  // Internal throttling (not user-configurable) — keeps the page smooth.
  PHONE_DETECT_INTERVAL_MS: 300,   // ~3.3x / second
  FACE_DETECT_INTERVAL_MS: 180,    // ~5.5x / second
  FACE_ABSENT_GRACE_MS: 1200,      // avoid flicker when face briefly leaves frame

  EAR_CLOSED_THRESHOLD: 0.21,      // eye-aspect-ratio below this = "closed"

  FACE_LANDMARKER_MODEL_URL:
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  FACE_LANDMARKER_WASM_URL:
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
};

const STORAGE_KEYS = {
  SETTINGS: 'focusguard_settings_v1',
  HISTORY: 'focusguard_history_v1',
};

const STATES = {
  IDLE: 'idle',
  FOCUSED: 'focused',
  CHECKING: 'checking',
  PHONE: 'phone',
  SLEEP: 'sleep',
  ABSENT: 'absent',
  ALERT: 'alert',
};

const STATUS_META = {
  [STATES.IDLE]:     { icon: '⚪', label: 'Idle',                              cls: '' },
  [STATES.FOCUSED]:  { icon: '🟢', label: 'Focused',                           cls: 'state-focused' },
  [STATES.CHECKING]: { icon: '🟡', label: 'Checking…',                         cls: 'state-checking' },
  [STATES.PHONE]:    { icon: '🔴', label: 'Phone Detected',                    cls: 'state-phone' },
  [STATES.SLEEP]:    { icon: '😴', label: 'Possible Sleep / Eyes Closed',      cls: 'state-sleep' },
  [STATES.ABSENT]:   { icon: '⚠️', label: 'Face Not Clearly Visible',          cls: 'state-absent' },
  [STATES.ALERT]:    { icon: '🎬', label: 'Alert Playing',                     cls: 'state-alert' },
};

/* =========================================================================
   LOCALSTORAGE MANAGER
   ========================================================================= */
const LocalStorageManager = {
  getSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { console.warn('Settings read failed', e); return null; }
  },
  saveSettings(settings) {
    try { localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings)); }
    catch (e) { console.warn('Settings save failed', e); }
  },
  getHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.HISTORY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { console.warn('History read failed', e); return []; }
  },
  addHistoryEntry(entry) {
    const history = this.getHistory();
    history.unshift(entry);
    try { localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history.slice(0, 100))); }
    catch (e) { console.warn('History save failed', e); }
  },
  clearHistory() {
    try { localStorage.removeItem(STORAGE_KEYS.HISTORY); }
    catch (e) { console.warn('History clear failed', e); }
  },
};

/* =========================================================================
   SETTINGS MANAGER
   ========================================================================= */
const SettingsManager = {
  current: null,

  defaults() {
    return {
      phoneEnabled: true,
      phoneConfidence: CONFIG.PHONE_CONFIDENCE,
      phoneConfirmMs: CONFIG.PHONE_CONFIRMATION_MS,
      sleepEnabled: true,
      sleepConfirmMs: CONFIG.EYE_CLOSED_CONFIRMATION_MS,
      cooldownMs: CONFIG.ALERT_COOLDOWN_MS,
      cameraDeviceId: '',
    };
  },

  load() {
    const saved = LocalStorageManager.getSettings();
    this.current = Object.assign(this.defaults(), saved || {});
    return this.current;
  },

  save(patch) {
    this.current = Object.assign({}, this.current, patch);
    LocalStorageManager.saveSettings(this.current);
    return this.current;
  },

  applyToForm() {
    const s = this.current;
    $('#setPhoneEnabled').checked = s.phoneEnabled;
    $('#setPhoneConf').value = s.phoneConfidence;
    $('#outPhoneConf').textContent = Number(s.phoneConfidence).toFixed(2);
    $('#setPhoneDur').value = s.phoneConfirmMs / 1000;
    $('#outPhoneDur').textContent = (s.phoneConfirmMs / 1000).toFixed(1) + 's';
    $('#setSleepEnabled').checked = s.sleepEnabled;
    $('#setSleepDur').value = s.sleepConfirmMs / 1000;
    $('#outSleepDur').textContent = (s.sleepConfirmMs / 1000).toFixed(1) + 's';
    $('#setCooldown').value = s.cooldownMs / 1000;
    $('#outCooldown').textContent = (s.cooldownMs / 1000).toFixed(0) + 's';
  },

  readFromForm() {
    return {
      phoneEnabled: $('#setPhoneEnabled').checked,
      phoneConfidence: parseFloat($('#setPhoneConf').value),
      phoneConfirmMs: Math.round(parseFloat($('#setPhoneDur').value) * 1000),
      sleepEnabled: $('#setSleepEnabled').checked,
      sleepConfirmMs: Math.round(parseFloat($('#setSleepDur').value) * 1000),
      cooldownMs: Math.round(parseFloat($('#setCooldown').value) * 1000),
      cameraDeviceId: $('#setCameraSelect').value,
    };
  },
};

/* =========================================================================
   CAMERA MANAGER
   ========================================================================= */
const CameraManager = {
  stream: null,
  videoEl: null,

  async start(deviceId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser does not support camera access (getUserMedia).');
    }
    this.stop(); // ensure clean slate

    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 720 } },
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (deviceId) {
        // Fall back to default camera if the saved device id is stale/unavailable
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user' } });
      } else {
        throw err;
      }
    }

    this.stream = stream;
    this.videoEl = $('#cameraVideo');
    this.videoEl.srcObject = stream;
    await this.videoEl.play().catch(() => {});
    return stream;
  },

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.videoEl) this.videoEl.srcObject = null;
  },

  isDisconnected() {
    if (!this.stream) return true;
    return this.stream.getVideoTracks().every(t => t.readyState === 'ended');
  },

  async listCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'videoinput');
    } catch (e) { return []; }
  },

  async populateCameraSelect(selectedId) {
    const select = $('#setCameraSelect');
    const cams = await this.listCameras();
    select.innerHTML = '<option value="">Default camera</option>';
    cams.forEach((cam, i) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Camera ${i + 1}`;
      if (cam.deviceId === selectedId) opt.selected = true;
      select.appendChild(opt);
    });
  },
};

/* =========================================================================
   AI MODEL MANAGER
   ========================================================================= */
const AIModelManager = {
  cocoModel: null,
  faceLandmarker: null,
  cocoReady: false,
  faceReady: false,

  markStep(step, status) {
    const li = document.querySelector(`.loading-steps li[data-step="${step}"]`);
    if (!li) return;
    li.classList.remove('done', 'active');
    if (status === 'active') li.classList.add('active');
    if (status === 'done') li.classList.add('done');
  },

  setStatus(text) {
    const el = $('#loadingStatus');
    if (el) el.textContent = text;
  },

  async loadAll() {
    this.setStatus('Loading TensorFlow.js…');
    this.markStep('tf', 'active');
    await this.guarded(() => waitFor(() => window.tf, 15000), 18000)
      .catch(() => { throw new Error('TensorFlow.js failed to load. Check your connection and refresh.'); });
    this.markStep('tf', 'done');

    this.setStatus('Loading phone-detection model (COCO-SSD)…');
    this.markStep('coco', 'active');
    try {
      await this.guarded(() => waitFor(() => window.cocoSsd, 15000), 20000);
      this.cocoModel = await this.guarded(() => cocoSsd.load({ base: 'lite_mobilenet_v2' }), 25000);
      this.cocoReady = true;
      this.markStep('coco', 'done');
    } catch (e) {
      console.warn('COCO-SSD failed to load', e);
      this.cocoReady = false;
      this.markStep('coco', 'active');
      UIManager.toast(e && e.message === 'skipped'
        ? 'Phone detection skipped — you can still study, just without phone alerts.'
        : 'Phone detection model failed to load — phone detection disabled.');
    }

    this.setStatus('Loading eye-closure model (MediaPipe)…');
    this.markStep('face', 'active');
    try {
      await this.guarded(async () => {
        const visionModule = await window.__mpVisionModulePromise;
        const { FaceLandmarker, FilesetResolver } = visionModule;
        const filesetResolver = await FilesetResolver.forVisionTasks(CONFIG.FACE_LANDMARKER_WASM_URL);
        this.faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
          baseOptions: { modelAssetPath: CONFIG.FACE_LANDMARKER_MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: false,
        });
      }, 25000);
      this.faceReady = true;
      this.markStep('face', 'done');
    } catch (e) {
      console.warn('Face Landmarker failed to load', e);
      this.faceReady = false;
      this.markStep('face', 'active');
      UIManager.toast(e && e.message === 'skipped'
        ? 'Eye-closure detection skipped — you can still study, just without sleep alerts.'
        : 'Eye-closure model failed to load — sleep detection disabled.');
    }

    $('#btnSkipStep').classList.add('hidden');

    if (!this.cocoReady && !this.faceReady) {
      throw new Error('Both AI models failed to load. Check your internet connection (or firewall/ad-blocker) and refresh the page.');
    }
    this.setStatus('Ready.');
  },

  // Races a loading step against a timeout AND a manual "skip" button.
  // Shows the skip button after 6s so a stalled CDN request never blocks the app forever.
  guarded(work, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const skipBtn = $('#btnSkipStep');

      const showSkipTimer = setTimeout(() => skipBtn.classList.remove('hidden'), 6000);
      const hardTimeout = setTimeout(() => finish(reject, new Error('timeout')), timeoutMs);

      function finish(fn, val) {
        if (settled) return;
        settled = true;
        clearTimeout(showSkipTimer);
        clearTimeout(hardTimeout);
        skipBtn.classList.add('hidden');
        skipBtn.onclick = null;
        fn(val);
      }

      skipBtn.onclick = () => finish(reject, new Error('skipped'));

      Promise.resolve().then(work).then(
        res => finish(resolve, res),
        err => finish(reject, err)
      );
    });
  },
};

function waitFor(check, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    (function poll() {
      if (check()) return resolve(true);
      if (performance.now() - start > timeoutMs) return reject(new Error('timeout'));
      setTimeout(poll, 100);
    })();
  });
}

/* =========================================================================
   PHONE DETECTOR
   ========================================================================= */
const PhoneDetector = {
  lastRun: 0,
  lastBoxes: [],
  rawDetected: false,

  async tick(video, now) {
    if (!AIModelManager.cocoReady) return;
    if (now - this.lastRun < CONFIG.PHONE_DETECT_INTERVAL_MS) return;
    this.lastRun = now;

    try {
      const predictions = await AIModelManager.cocoModel.detect(video);
      const threshold = SettingsManager.current.phoneConfidence;
      const phones = predictions.filter(p => p.class === 'cell phone' && p.score >= threshold);
      this.lastBoxes = phones;
      this.rawDetected = phones.length > 0;
    } catch (e) {
      console.warn('Phone detection error', e);
    }
  },
};

/* =========================================================================
   FACE / EYE DETECTOR
   ========================================================================= */
const FaceEyeDetector = {
  lastRun: 0,
  faceDetected: false,
  eyesClosed: false,
  lastEar: null,

  // MediaPipe FaceMesh topology indices for eye-aspect-ratio calculation
  LEFT_EYE:  [362, 385, 387, 263, 373, 380],
  RIGHT_EYE: [33, 160, 158, 133, 153, 144],

  tick(video, now) {
    if (!AIModelManager.faceReady) return;
    if (now - this.lastRun < CONFIG.FACE_DETECT_INTERVAL_MS) return;
    this.lastRun = now;

    try {
      const result = AIModelManager.faceLandmarker.detectForVideo(video, now);
      const landmarks = result && result.faceLandmarks && result.faceLandmarks[0];
      if (!landmarks) {
        this.faceDetected = false;
        this.eyesClosed = false;
        return;
      }
      this.faceDetected = true;
      const w = video.videoWidth || 1, h = video.videoHeight || 1;
      const pts = landmarks.map(p => ({ x: p.x * w, y: p.y * h }));

      const earLeft = eyeAspectRatio(pts, this.LEFT_EYE);
      const earRight = eyeAspectRatio(pts, this.RIGHT_EYE);
      const ear = (earLeft + earRight) / 2;
      this.lastEar = ear;
      this.eyesClosed = ear < CONFIG.EAR_CLOSED_THRESHOLD;
    } catch (e) {
      console.warn('Face detection error', e);
    }
  },
};

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function eyeAspectRatio(pts, idx) {
  const [p1, p2, p3, p4, p5, p6] = idx.map(i => pts[i]);
  const vertical = dist(p2, p6) + dist(p3, p5);
  const horizontal = dist(p1, p4) * 2;
  if (horizontal === 0) return 1;
  return vertical / horizontal;
}

/* =========================================================================
   DETECTION STATE MANAGER
   ========================================================================= */
const DetectionStateManager = {
  running: false,
  rafId: null,

  phoneTimerStart: null,
  eyesClosedStart: null,
  faceAbsentSince: null,

  currentState: STATES.IDLE,

  start() {
    this.running = true;
    this.phoneTimerStart = null;
    this.eyesClosedStart = null;
    this.faceAbsentSince = null;
    this.currentState = STATES.CHECKING;
    UIManager.setState(STATES.CHECKING);
    this.loop();
  },

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.currentState = STATES.IDLE;
    UIManager.setState(STATES.IDLE);
    UIManager.clearOverlay();
  },

  pause() {
    // Called while alert video is playing — halts inference but keeps session state.
    this.paused = true;
  },
  resume() {
    this.paused = false;
  },

  loop() {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(() => this.loop());
    if (this.paused) return;

    const video = CameraManager.videoEl;
    if (!video || video.readyState < 2) return;
    const now = performance.now();

    PhoneDetector.tick(video, now);
    FaceEyeDetector.tick(video, now);
    UIManager.drawOverlay(PhoneDetector.lastBoxes, video);

    this.evaluate(now);
  },

  evaluate(now) {
    if (AlertVideoManager.isPlaying) {
      UIManager.setState(STATES.ALERT);
      return;
    }

    const settings = SettingsManager.current;

    // ---- Phone confirmation timer ----
    if (settings.phoneEnabled && PhoneDetector.rawDetected) {
      if (this.phoneTimerStart == null) this.phoneTimerStart = now;
      const elapsed = now - this.phoneTimerStart;
      if (elapsed >= settings.phoneConfirmMs) {
        this.phoneTimerStart = null;
        AlertVideoManager.trigger('phone');
        return;
      }
    } else {
      this.phoneTimerStart = null;
    }

    // ---- Face presence + eye-closure confirmation timer ----
    if (FaceEyeDetector.faceDetected) {
      this.faceAbsentSince = null;

      if (settings.sleepEnabled && FaceEyeDetector.eyesClosed) {
        if (this.eyesClosedStart == null) this.eyesClosedStart = now;
        const elapsed = now - this.eyesClosedStart;
        if (elapsed >= settings.sleepConfirmMs) {
          this.eyesClosedStart = null;
          AlertVideoManager.trigger('sleep');
          return;
        }
      } else {
        this.eyesClosedStart = null;
      }
    } else {
      if (this.faceAbsentSince == null) this.faceAbsentSince = now;
      // Face missing does not accumulate toward a sleep alert.
      this.eyesClosedStart = null;
    }

    // ---- Resolve display state (priority order) ----
    let state;
    if (settings.phoneEnabled && PhoneDetector.rawDetected) {
      state = STATES.PHONE;
    } else if (settings.sleepEnabled && FaceEyeDetector.eyesClosed && FaceEyeDetector.faceDetected) {
      state = STATES.SLEEP;
    } else if (this.faceAbsentSince != null && (now - this.faceAbsentSince) >= CONFIG.FACE_ABSENT_GRACE_MS) {
      state = STATES.ABSENT;
    } else if (!AIModelManager.faceReady && !AIModelManager.cocoReady) {
      state = STATES.CHECKING;
    } else {
      state = STATES.FOCUSED;
    }

    this.currentState = state;
    UIManager.setState(state);
  },
};

/* =========================================================================
   ALERT VIDEO MANAGER
   ========================================================================= */
const AlertVideoManager = {
  isPlaying: false,
  lastAlertAt: 0,
  audioUnlocked: false,

  // The <video> element already has a <source src="./assets/videos/alert.mp4">
  // with preload="auto", so the file starts caching as soon as the page loads —
  // no network fetch happens at alert time.
  preload() {
    const v = $('#alertVideo');
    v.load();
  },

  unlockAudio() {
    const v = $('#alertVideo');
    v.muted = true;
    const p = v.play();
    if (p && p.catch) {
      p.then(() => { v.pause(); v.currentTime = 0; this.audioUnlocked = true; })
       .catch(() => { this.audioUnlocked = false; });
    }
  },

  trigger(kind, isTest) {
    const now = performance.now();
    if (this.isPlaying) return; // never overlap alerts
    if (!isTest && now - this.lastAlertAt < SettingsManager.current.cooldownMs) return;

    this.isPlaying = true;
    this.lastAlertAt = now;
    DetectionStateManager.pause();
    UIManager.setState(STATES.ALERT);

    if (!isTest) {
      if (kind === 'phone') StatisticsManager.recordPhoneAlert();
      if (kind === 'sleep') StatisticsManager.recordSleepAlert();
    }

    this.play(kind);
  },

  play(kind) {
    const overlay = $('#alertOverlay');
    const video = $('#alertVideo');
    const errorEl = $('#alertVideoError');
    const caption = $('#alertCaption');
    errorEl.classList.add('hidden');
    video.classList.remove('hidden');

    caption.textContent = kind === 'phone'
      ? 'Phone detected — time to refocus'
      : kind === 'sleep'
        ? 'You may be dozing off — take a breath'
        : 'Test alert';

    // Open the overlay immediately — the local file is already preloaded,
    // so there's no loading delay to wait out.
    overlay.classList.remove('hidden');

    video.muted = false;
    video.currentTime = 0;
    video.controls = false;

    const finish = () => this.close();
    video.onended = finish;
    video.onerror = () => {
      errorEl.textContent = 'The local alert video (assets/videos/alert.mp4) could not be played. Make sure the file exists in your project.';
      errorEl.classList.remove('hidden');
      video.classList.add('hidden');
      this.scheduleAutoClose(4000);
    };

    const playPromise = video.play();
    if (playPromise && playPromise.catch) {
      playPromise.catch(() => {
        // Autoplay with sound blocked — retry muted so something is visible.
        video.muted = true;
        video.play().catch(() => {});
        UIManager.toast('Browser blocked autoplay audio — tap the alert to unmute.');
        video.onclick = () => { video.muted = false; };
      });
    }

    // Fullscreen attempt (requires the earlier Start Study gesture to have primed permissions
    // on most browsers; gracefully falls back to the full-window overlay otherwise).
    if (overlay.requestFullscreen) {
      overlay.requestFullscreen().catch(() => { /* fall back to overlay, no error surfaced */ });
    }

    // Safety timeout in case 'ended' never fires (e.g. a corrupt/looping file).
    this.autoCloseTimer = setTimeout(() => this.close(), 90000);
  },

  scheduleAutoClose(ms) {
    this.autoCloseTimer = setTimeout(() => this.close(), ms);
  },

  close() {
    if (this.autoCloseTimer) clearTimeout(this.autoCloseTimer);
    const overlay = $('#alertOverlay');
    const video = $('#alertVideo');
    video.pause();
    video.currentTime = 0;
    overlay.classList.add('hidden');

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }

    this.isPlaying = false;
    DetectionStateManager.resume();
    // Reset confirmation timers so the same condition needs to re-confirm after cooldown.
    DetectionStateManager.phoneTimerStart = null;
    DetectionStateManager.eyesClosedStart = null;
  },
};

/* =========================================================================
   STUDY TIMER
   ========================================================================= */
const StudyTimer = {
  intervalId: null,
  studySeconds: 0,
  focusedSeconds: 0,
  startedAt: null,

  start() {
    this.studySeconds = 0;
    this.focusedSeconds = 0;
    this.startedAt = new Date();
    this.intervalId = setInterval(() => this.tick(), 1000);
  },

  tick() {
    this.studySeconds++;
    if (DetectionStateManager.currentState === STATES.FOCUSED) {
      this.focusedSeconds++;
    }
    UIManager.updateStudyTime(this.studySeconds);
    UIManager.updateFocusTime(this.focusedSeconds);
    UIManager.updateFocusScore(StatisticsManager.focusScore());
  },

  stop() {
    clearInterval(this.intervalId);
    this.intervalId = null;
  },

  formatted(seconds) {
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  },
};

/* =========================================================================
   STATISTICS MANAGER
   ========================================================================= */
const StatisticsManager = {
  phoneAlerts: 0,
  sleepAlerts: 0,

  reset() {
    this.phoneAlerts = 0;
    this.sleepAlerts = 0;
  },

  recordPhoneAlert() {
    this.phoneAlerts++;
    UIManager.updateAlertCounts(this.phoneAlerts, this.sleepAlerts);
  },

  recordSleepAlert() {
    this.sleepAlerts++;
    UIManager.updateAlertCounts(this.phoneAlerts, this.sleepAlerts);
  },

  totalAlerts() {
    return this.phoneAlerts + this.sleepAlerts;
  },

  // Approximate estimate only — not a scientific or medical measurement.
  focusScore() {
    const study = StudyTimer.studySeconds;
    if (study < 5) return null;
    const focusedRatio = StudyTimer.focusedSeconds / study;
    const penalty = this.totalAlerts() * 3;
    const score = Math.round(Math.max(0, Math.min(100, focusedRatio * 100 - penalty)));
    return score;
  },
};

/* =========================================================================
   UI MANAGER
   ========================================================================= */
function $(sel) { return document.querySelector(sel); }

const UIManager = {
  setState(state) {
    const meta = STATUS_META[state];
    $('#statusIcon').textContent = meta.icon;
    $('#statusLabel').textContent = meta.label;

    const frame = $('.camera-frame');
    frame.className = 'camera-frame' + (meta.cls ? ' ' + meta.cls : '');

    const liveTag = $('#liveTag');
    const liveText = $('#liveText');
    if (state === STATES.IDLE) {
      liveTag.classList.remove('on');
      liveText.textContent = 'OFF';
    } else {
      liveTag.classList.add('on');
      liveText.textContent = 'LIVE';
    }
  },

  drawOverlay(boxes, video) {
    const canvas = $('#overlayCanvas');
    const displayW = canvas.clientWidth, displayH = canvas.clientHeight;
    if (canvas.width !== displayW) canvas.width = displayW;
    if (canvas.height !== displayH) canvas.height = displayH;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!boxes || !boxes.length || !video.videoWidth) return;

    const scaleX = canvas.width / video.videoWidth;
    const scaleY = canvas.height / video.videoHeight;

    ctx.lineWidth = 2;
    ctx.strokeStyle = '#FF6B5B';
    ctx.fillStyle = '#FF6B5B';
    ctx.font = '12px Inter, sans-serif';

    boxes.forEach(b => {
      const [x, y, w, h] = b.bbox;
      // Camera preview is mirrored (scaleX(-1)), so mirror the box horizontally too.
      const mirroredX = video.videoWidth - x - w;
      const rx = mirroredX * scaleX, ry = y * scaleY, rw = w * scaleX, rh = h * scaleY;
      ctx.strokeRect(rx, ry, rw, rh);
      const label = `Phone ${Math.round(b.score * 100)}%`;
      const textW = ctx.measureText(label).width + 8;
      ctx.fillRect(rx, Math.max(0, ry - 18), textW, 18);
      ctx.fillStyle = '#0A0E13';
      ctx.fillText(label, rx + 4, Math.max(12, ry - 5));
      ctx.fillStyle = '#FF6B5B';
    });
  },

  clearOverlay() {
    const canvas = $('#overlayCanvas');
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  },

  updateStudyTime(sec) { $('#statStudyTime').textContent = StudyTimer.formatted(sec); },
  updateFocusTime(sec) { $('#statFocusTime').textContent = StudyTimer.formatted(sec); },
  updateFocusScore(score) { $('#statFocusScore').textContent = score == null ? '—' : score + '%'; },
  updateAlertCounts(phone, sleep) {
    $('#statPhoneAlerts').textContent = phone;
    $('#statSleepAlerts').textContent = sleep;
    $('#statTotalAlerts').textContent = phone + sleep;
  },

  toast(message, ms = 3200) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  },

  showCameraError(msg) {
    const el = $('#cameraError');
    if (!msg) { el.classList.add('hidden'); return; }
    el.textContent = msg;
    el.classList.remove('hidden');
  },

  renderHistory() {
    const list = $('#historyList');
    const history = LocalStorageManager.getHistory();
    if (!history.length) {
      list.innerHTML = '<p class="empty-state">No sessions recorded yet. Start a study session to see it here.</p>';
      return;
    }
    list.innerHTML = history.map(h => `
      <div class="history-item">
        <div class="history-item-top">
          <span>${h.date}</span>
          <span>${h.focusScore == null ? '—' : h.focusScore + '%'} focus</span>
        </div>
        <div class="history-item-meta">
          <span>${h.startTime} – ${h.endTime}</span>
          <span>Duration ${h.duration}</span>
          <span>📱 ${h.phoneAlerts}</span>
          <span>😴 ${h.sleepAlerts}</span>
        </div>
      </div>
    `).join('');
  },
};

/* =========================================================================
   SESSION CONTROLLER — wires everything together for Start / Stop
   ========================================================================= */
const SessionController = {
  active: false,

  async startStudy() {
    if (this.active) return;
    UIManager.showCameraError(null);

    // Prime audio + video element on this user gesture.
    AlertVideoManager.unlockAudio();

    try {
      await CameraManager.start(SettingsManager.current.cameraDeviceId || undefined);
    } catch (err) {
      UIManager.showCameraError(cameraErrorMessage(err));
      return;
    }

    $('#cameraPlaceholder').classList.add('hidden');
    $('#cameraActiveTag').classList.add('on');
    $('#btnStart').classList.add('hidden');
    $('#btnStop').classList.remove('hidden');

    StatisticsManager.reset();
    StudyTimer.start();
    DetectionStateManager.start();
    this.active = true;

    this.disconnectWatcher = setInterval(() => {
      if (this.active && CameraManager.isDisconnected()) {
        UIManager.toast('Camera disconnected — stopping session.');
        this.stopStudy();
      }
    }, 2000);
  },

  stopStudy() {
    if (!this.active) return;
    this.active = false;

    clearInterval(this.disconnectWatcher);
    DetectionStateManager.stop();
    StudyTimer.stop();
    CameraManager.stop();
    AlertVideoManager.close();

    $('#cameraPlaceholder').classList.remove('hidden');
    $('#cameraActiveTag').classList.remove('on');
    $('#btnStart').classList.remove('hidden');
    $('#btnStop').classList.add('hidden');

    LocalStorageManager.addHistoryEntry({
      date: StudyTimer.startedAt ? StudyTimer.startedAt.toLocaleDateString() : '',
      startTime: StudyTimer.startedAt ? StudyTimer.startedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
      endTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      duration: StudyTimer.formatted(StudyTimer.studySeconds),
      phoneAlerts: StatisticsManager.phoneAlerts,
      sleepAlerts: StatisticsManager.sleepAlerts,
      focusScore: StatisticsManager.focusScore(),
    });
    UIManager.renderHistory();
  },
};

function cameraErrorMessage(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Camera permission was denied. Allow camera access and try again.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No camera was found on this device.';
  if (name === 'NotReadableError') return 'The camera is already in use by another application.';
  return (err && err.message) || 'Could not access the camera.';
}

/* =========================================================================
   BOOTSTRAP
   ========================================================================= */
async function bootstrap() {
  SettingsManager.load();

  try {
    await AIModelManager.loadAll();
  } catch (err) {
    $('#loadingError').textContent = err.message;
    $('#loadingError').classList.remove('hidden');
    UIManager.setState(STATES.IDLE);
    return; // Leave loading screen up with the error; nothing further can run safely.
  }

  $('#loadingScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');

  AlertVideoManager.preload();
  SettingsManager.applyToForm();
  await CameraManager.populateCameraSelect(SettingsManager.current.cameraDeviceId);
  UIManager.renderHistory();
  UIManager.setState(STATES.IDLE);

  wireUpControls();
}

function wireUpControls() {
  $('#btnStart').addEventListener('click', () => SessionController.startStudy());
  $('#btnStop').addEventListener('click', () => SessionController.stopStudy());

  // Settings drawer
  $('#btnSettings').addEventListener('click', async () => {
    await CameraManager.populateCameraSelect(SettingsManager.current.cameraDeviceId);
    $('#settingsOverlay').classList.remove('hidden');
  });
  $('#btnCloseSettings').addEventListener('click', () => $('#settingsOverlay').classList.add('hidden'));
  $('#settingsOverlay').addEventListener('click', (e) => { if (e.target.id === 'settingsOverlay') $('#settingsOverlay').classList.add('hidden'); });

  $('#setPhoneConf').addEventListener('input', e => $('#outPhoneConf').textContent = parseFloat(e.target.value).toFixed(2));
  $('#setPhoneDur').addEventListener('input', e => $('#outPhoneDur').textContent = parseFloat(e.target.value).toFixed(1) + 's');
  $('#setSleepDur').addEventListener('input', e => $('#outSleepDur').textContent = parseFloat(e.target.value).toFixed(1) + 's');
  $('#setCooldown').addEventListener('input', e => $('#outCooldown').textContent = parseFloat(e.target.value).toFixed(0) + 's');

  $('#btnSaveSettings').addEventListener('click', () => {
    SettingsManager.save(SettingsManager.readFromForm());
    UIManager.toast('Settings saved.');
    $('#settingsOverlay').classList.add('hidden');
  });

  $('#btnTestVideo').addEventListener('click', () => AlertVideoManager.trigger('test', true));
  $('#btnTestPhone').addEventListener('click', () => AlertVideoManager.trigger('phone', true));
  $('#btnTestSleep').addEventListener('click', () => AlertVideoManager.trigger('sleep', true));

  // History drawer
  $('#btnHistory').addEventListener('click', () => { UIManager.renderHistory(); $('#historyOverlay').classList.remove('hidden'); });
  $('#btnCloseHistory').addEventListener('click', () => $('#historyOverlay').classList.add('hidden'));
  $('#historyOverlay').addEventListener('click', (e) => { if (e.target.id === 'historyOverlay') $('#historyOverlay').classList.add('hidden'); });
  $('#btnClearHistory').addEventListener('click', () => {
    if (confirm('Clear all saved session history? This cannot be undone.')) {
      LocalStorageManager.clearHistory();
      UIManager.renderHistory();
      UIManager.toast('History cleared.');
    }
  });

  window.addEventListener('beforeunload', () => {
    if (SessionController.active) CameraManager.stop();
  });
}

// Run immediately: by the time this script (placed at the bottom of <body>)
// executes, everything above it in the DOM already exists. We deliberately do
// NOT wait for the 'DOMContentLoaded' event here — that event is delayed until
// the deferred <script> tags for TensorFlow.js / COCO-SSD finish downloading,
// so on a slow or restricted network it could be delayed indefinitely and the
// app would never start. AIModelManager.loadAll() already waits for those
// libraries itself, with its own timeout + skip button.
bootstrap();