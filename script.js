const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const video = document.getElementById('video');
const status = document.getElementById('status');
const milestoneEl = document.getElementById('milestone');
const attentionEl = document.getElementById('attention');

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const PIXEL = 8;
const BG = '#000000';
const FG = '#ffffff';
const RADIUS = 80;
const RECOGNITION_MAX_SCALE = 1.9;

const MOOD_FLIP_DELAY = 2000;
const SOOTHE_DURATION_REQUIRED = 3000;
const SOOTHE_IDLE_TIMEOUT = 600;
const SLEEP_RELOAD_DELAY = 5000;
const GLOBAL_NO_FACE_TIMEOUT = 5000;

// ── iOS audio unlock ──
let audioUnlocked = false;

function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
  const buf = tempCtx.createBuffer(1, 1, 22050);
  const src = tempCtx.createBufferSource();
  src.buffer = buf;
  src.connect(tempCtx.destination);
  src.start(0);
  tempCtx.close();
}

document.addEventListener('touchstart', unlockAudio, { once: true });
document.addEventListener('mousedown', unlockAudio, { once: true });

let phase = 'sleeping';
let eyeOpenAmount = 0;
let wakeBlinkCount = 0;
let wakeBlinkDir = 1;
let noFaceTimer = 0;
let mouthState = 'neutral';
let moodTimer = 0;
let blinkProgress = 0;
let isBlinking = false;
let faceDetected = false;
let t = 0;
let sleepReloadTimer = null;
let globalNoFaceTimer = null;
let resetting = false;

function forceReset() {
  if (resetting) return;
  resetting = true;
  try {
    if (cryGain) {
      cryGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);
      setTimeout(() => {
        try { cryOsc && cryOsc.stop(); cryLfo && cryLfo.stop(); } catch(e) {}
        try { audioCtx && audioCtx.close(); } catch(e) {}
        cryOsc = null; cryLfo = null; cryGain = null; audioCtx = null;
      }, 300);
    }
  } catch(e) {}
  tearsPaused = true;
  if (tearInterval) { clearInterval(tearInterval); tearInterval = null; }
  tears = [];
  if (dependencyTick) { clearInterval(dependencyTick); dependencyTick = null; }
  if (recognitionTick) { clearInterval(recognitionTick); recognitionTick = null; }
  if (attachmentTick) { clearInterval(attachmentTick); attachmentTick = null; }
  if (attentionInterval) { clearInterval(attentionInterval); attentionInterval = null; }
  try { window.speechSynthesis.cancel(); } catch(e) {}
  hideHUD();
  milestoneEl.classList.remove('show');
  attentionEl.classList.remove('show');
  status.textContent = '';
  phase = 'sleeping';
  eyeOpenAmount = 0;
  mouthState = 'neutral';
  setTimeout(() => location.reload(), SLEEP_RELOAD_DELAY);
}

function startGlobalWatchdog() {
  if (globalNoFaceTimer) return;
  globalNoFaceTimer = setTimeout(() => {
    if (!faceDetected && phase !== 'sleeping') forceReset();
  }, GLOBAL_NO_FACE_TIMEOUT);
}

function resetGlobalWatchdog() {
  if (globalNoFaceTimer) { clearTimeout(globalNoFaceTimer); globalNoFaceTimer = null; }
}

const NO_FACE_SAD_FRAMES = 90;
const NO_FACE_SLEEP_FRAMES = 300;

let targetX = canvas.width / 2;
let targetY = canvas.height / 2;
let currentX = canvas.width / 2;
let currentY = canvas.height / 2;

const hudBars = {
  recognition:   { el: document.getElementById('hud-tl'), fill: document.getElementById('fill-recognition'),   val: 0 },
  attachment:    { el: document.getElementById('hud-tr'), fill: document.getElementById('fill-attachment'),    val: 0 },
  dependency:    { el: document.getElementById('hud-bl'), fill: document.getElementById('fill-dependency'),    val: 0 },
  communication: { el: document.getElementById('hud-br'), fill: document.getElementById('fill-communication'), val: 0 },
};

function showHUD() { Object.values(hudBars).forEach(b => b.el.classList.add('show')); }
function hideHUD() { Object.values(hudBars).forEach(b => b.el.classList.remove('show')); }
function setBar(name, pct) {
  const b = hudBars[name];
  b.val = Math.min(100, Math.max(0, pct));
  b.fill.style.width = b.val + '%';
}
function bumpBar(name, amount) { setBar(name, hudBars[name].val + amount); }

let dependencyTick = null;
function startDependencyTick() {
  if (dependencyTick) return;
  dependencyTick = setInterval(() => { if (phase !== 'sleeping') bumpBar('dependency', 0.3); }, 500);
}

let recognitionTick = null;
function startRecognitionTick() {
  if (recognitionTick) return;
  recognitionTick = setInterval(() => { if (faceDetected && phase !== 'sleeping') bumpBar('recognition', 0.5); }, 500);
}

let attachmentTick = null;
function startAttachmentTick() {
  if (attachmentTick) return;
  attachmentTick = setInterval(() => { if (phase !== 'sleeping') bumpBar('attachment', 0.25); }, 500);
}

let soothingStartTime = null;
let soothingIdleTimer = null;
let isHolding = false;
let soothingResolved = false;

function onHoldStart() {
  if (phase !== 'distress' && phase !== 'soothing') return;
  if (soothingResolved) return;
  isHolding = true;
  if (soothingIdleTimer) { clearTimeout(soothingIdleTimer); soothingIdleTimer = null; }
  if (phase === 'distress') {
    phase = 'soothing';
    pauseCrySound();
    stopTears();
    mouthState = 'neutral';
  }
  if (!soothingStartTime) soothingStartTime = Date.now();
  const checkDuration = () => {
    if (!isHolding || soothingResolved) return;
    const elapsed = Date.now() - soothingStartTime;
    if (elapsed >= SOOTHE_DURATION_REQUIRED) {
      completeSoothe();
    } else {
      setTimeout(checkDuration, 100);
    }
  };
  checkDuration();
}

function onHoldEnd() {
  if (soothingResolved) return;
  if (phase !== 'soothing') return;
  isHolding = false;
  soothingIdleTimer = setTimeout(() => {
    if (!isHolding && phase === 'soothing' && !soothingResolved) {
      phase = 'distress';
      soothingStartTime = null;
      mouthState = 'cry';
      eyeOpenAmount = 0;
      resumeCrySound();
      resumeTears();
    }
  }, SOOTHE_IDLE_TIMEOUT);
}

function completeSoothe() {
  soothingResolved = true;
  stopCrySound();
  stopTears();
  phase = 'soothing';
  mouthState = 'neutral';
  bumpBar('communication', 20);
  bumpBar('attachment', 15);
  eyeOpenAmount = 0;
  let blink = setInterval(() => {
    eyeOpenAmount = Math.min(1, eyeOpenAmount + 0.04);
    if (eyeOpenAmount >= 1) {
      clearInterval(blink);
      setTimeout(() => {
        phase = 'awake';
        mouthState = 'happy';
        fireMilestone('CAREGIVER BEHAVIOR LEARNED');
      }, 400);
    }
  }, 30);
}

canvas.addEventListener('mousedown', () => onHoldStart());
canvas.addEventListener('mouseup', () => onHoldEnd());
canvas.addEventListener('mouseleave', () => onHoldEnd());
canvas.addEventListener('touchstart', (e) => { e.preventDefault(); onHoldStart(); }, { passive: false });
canvas.addEventListener('touchend', () => onHoldEnd());
canvas.addEventListener('touchcancel', () => onHoldEnd());

let tears = [];
let tearSpawnX1 = 0, tearSpawnY1 = 0, tearSpawnX2 = 0, tearSpawnY2 = 0;
let tearInterval = null;
let tearsPaused = false;

function spawnTear(eyeX, eyeY) {
  tears.push({ x: eyeX + (Math.random() - 0.5) * 8, y: eyeY + 24, speed: 1.5 + Math.random(), opacity: 1 });
}
function updateTears() {
  tears.forEach(tear => { tear.y += tear.speed; tear.opacity -= 0.012; });
  tears = tears.filter(t => t.opacity > 0);
}
function drawTears() {
  tears.forEach(tear => {
    ctx.fillStyle = `rgba(150, 210, 255, ${tear.opacity})`;
    const tx = Math.round(tear.x / PIXEL) * PIXEL;
    const ty = Math.round(tear.y / PIXEL) * PIXEL;
    ctx.fillRect(tx, ty, PIXEL - 1, PIXEL - 1);
    ctx.fillRect(tx, ty + PIXEL, PIXEL - 1, PIXEL - 1);
  });
}
function startTears() {
  if (tearInterval) return;
  tearsPaused = false;
  tearInterval = setInterval(() => {
    if (phase === 'distress' && !tearsPaused) {
      spawnTear(tearSpawnX1, tearSpawnY1);
      spawnTear(tearSpawnX2, tearSpawnY2);
    }
  }, 280);
}
function stopTears() {
  tearsPaused = true;
  if (tearInterval) { clearInterval(tearInterval); tearInterval = null; }
  tears = [];
}
function resumeTears() { tearsPaused = false; startTears(); }

let audioCtx = null, cryOsc = null, cryGain = null, cryLfo = null;

function startCrySound() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    cryGain = audioCtx.createGain();
    cryGain.gain.setValueAtTime(0.18, audioCtx.currentTime);
    cryGain.connect(audioCtx.destination);
    cryOsc = audioCtx.createOscillator();
    cryOsc.type = 'sawtooth';
    cryOsc.frequency.setValueAtTime(520, audioCtx.currentTime);
    cryOsc.connect(cryGain);
    cryOsc.start();
    cryLfo = audioCtx.createOscillator();
    cryLfo.type = 'sine';
    cryLfo.frequency.setValueAtTime(0.8, audioCtx.currentTime);
    const lfoGain = audioCtx.createGain();
    lfoGain.gain.setValueAtTime(80, audioCtx.currentTime);
    cryLfo.connect(lfoGain);
    lfoGain.connect(cryOsc.frequency);
    cryLfo.start();
    const volLfo = audioCtx.createOscillator();
    volLfo.type = 'sine';
    volLfo.frequency.setValueAtTime(1.4, audioCtx.currentTime);
    const volLfoGain = audioCtx.createGain();
    volLfoGain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    volLfo.connect(volLfoGain);
    volLfoGain.connect(cryGain.gain);
    volLfo.start();
  } catch(e) {}
}
function pauseCrySound() { try { if (cryGain) cryGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.2); } catch(e) {} }
function resumeCrySound() { try { if (cryGain) cryGain.gain.setTargetAtTime(0.18, audioCtx.currentTime, 0.2); } catch(e) {} }
function stopCrySound() {
  try {
    if (cryGain) {
      cryGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.3);
      setTimeout(() => {
        try { cryOsc && cryOsc.stop(); cryLfo && cryLfo.stop(); } catch(e) {}
        try { audioCtx && audioCtx.close(); } catch(e) {}
        cryOsc = null; cryLfo = null; cryGain = null; audioCtx = null;
      }, 800);
    }
  } catch(e) {}
}

let mamaTalking = false;
let mamaFired = false;
let moodFlipScheduled = false;

function speakSyllable(text, onEnd) {
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.3; u.pitch = 2.0; u.volume = 1;
  u.onend = onEnd;
  window.speechSynthesis.speak(u);
}

function sayMama() {
  if (mamaTalking || mamaFired) return;
  mamaTalking = true;
  mamaFired = true;
  const beats = ['neutral', 'ohh', 'neutral', 'ohh'];
  beats.forEach((state, i) => {
    setTimeout(() => {
      mouthState = state;
      if (i === beats.length - 1) {
        setTimeout(() => { mouthState = 'happy'; mamaTalking = false; }, 400);
      }
    }, i * 400);
  });
  speakSyllable('mah', () => speakSyllable('muh', () => {}));
  bumpBar('communication', 30);
}

function triggerMoodFlip() {
  if (moodFlipScheduled) return;
  moodFlipScheduled = true;
  setTimeout(() => {
    const isDistress = true;
    if (isDistress) {
      phase = 'distress';
      mouthState = 'cry';
      eyeOpenAmount = 0;
      soothingStartTime = null;
      soothingResolved = false;
      isHolding = false;
      fireMilestone('DISTRESS MODE ACTIVATED');
      const cx = Math.round(currentX / PIXEL) * PIXEL;
      const cy = Math.round(currentY / PIXEL) * PIXEL;
      tearSpawnX1 = cx - 80;
      tearSpawnY1 = cy - 30;
      tearSpawnX2 = cx + 80;
      tearSpawnY2 = cy - 30;
      startTears();
      startCrySound();
    } else {
      mouthState = 'happy';
    }
  }, MOOD_FLIP_DELAY);
}

const milestonesFired = new Set();
let milestoneQueue = [];
let milestoneShowing = false;

function fireMilestone(text) {
  if (milestonesFired.has(text)) return;
  milestonesFired.add(text);
  milestoneQueue.push(text);
  if (!milestoneShowing) showNextMilestone();
}

function showNextMilestone() {
  if (!milestoneQueue.length) { milestoneShowing = false; return; }
  milestoneShowing = true;
  const text = milestoneQueue.shift();
  milestoneEl.textContent = text;
  milestoneEl.classList.add('show');
  setTimeout(() => {
    milestoneEl.classList.remove('show');
    setTimeout(() => showNextMilestone(), 1200);
  }, 4500);
}

let attentionVisible = false;
let attentionSeconds = 0;
let attentionInterval = null;

function startAttentionCounter() {
  if (attentionInterval) return;
  attentionInterval = setInterval(() => {
    if (faceDetected) { attentionSeconds++; } else { attentionSeconds = 0; }
    if (attentionVisible) attentionEl.textContent = `SUSTAINED ATTENTION: ${attentionSeconds}s`;
    if (attentionSeconds >= RATING_TRIGGER_SECONDS && !ratingTriggered) {
      triggerGlitchAndRating();
    }
  }, 1000);
}

let eyeContactFrames = 0;
const EYE_CONTACT_THRESHOLD = 60;
let recognitionPhase = 'none';
let recognitionScale = 1;
let recognitionTimer = 0;

function moodCanOverride() {
  return !mamaTalking && phase !== 'distress' && phase !== 'soothing' &&
    (recognitionPhase === 'none' || recognitionPhase === 'waiting' || recognitionPhase === 'done');
}

function startWaking() {
  phase = 'waking';
  wakeBlinkCount = 0;
  wakeBlinkDir = 1;
  eyeOpenAmount = 0;
  eyeContactFrames = 0;
  showHUD();
  startDependencyTick();
  startRecognitionTick();
}

function scheduleIdleBlink() {
  setTimeout(() => {
    if (phase === 'awake') { isBlinking = true; blinkProgress = 0; }
    scheduleIdleBlink();
  }, 2000 + Math.random() * 3000);
}
scheduleIdleBlink();

function p(x, y, color) {
  ctx.fillStyle = color || FG;
  ctx.fillRect(Math.round(x/PIXEL)*PIXEL, Math.round(y/PIXEL)*PIXEL, PIXEL-1, PIXEL-1);
}

function drawBlush(cx, cy) {
  if (phase === 'sleeping' || phase === 'distress') return;
  const alpha = phase === 'waking' ? eyeOpenAmount * 0.35 : 0.35;
  const dots = [[-2,0],[-1,0],[0,0],[1,0],[2,0],[-1,-1],[0,-1],[1,-1],[-1,1],[0,1],[1,1]];
  dots.forEach(([dx,dy]) => {
    ctx.fillStyle = `rgba(255, 100, 120, ${alpha})`;
    ctx.fillRect(Math.round((cx+dx*PIXEL)/PIXEL)*PIXEL, Math.round((cy+dy*PIXEL)/PIXEL)*PIXEL, PIXEL-1, PIXEL-1);
  });
}

function drawEye(cx, cy, openAmount, scale) {
  const S = scale || 1;
  const PX = Math.max(1, Math.round(PIXEL * S));

  function pe(dx, dy, color) {
    ctx.fillStyle = color || FG;
    ctx.fillRect(Math.round((cx + dx*PX) / PX) * PX, Math.round((cy + dy*PX) / PX) * PX, PX - 1, PX - 1);
  }

  if (phase === 'distress') {
    [-2,-1,0,1,2].forEach(i => pe(i, i));
    [-2,-1,0,1,2].forEach(i => pe(i, -i));
    return;
  }
  if (phase === 'soothing') {
    [-3,-2,-1,0,1,2,3].forEach(i => pe(i, 0));
    return;
  }
  if (openAmount < 0.05) {
    [-3,-2,-1,0,1,2,3].forEach(i => pe(i, 0));
    return;
  }

  const fill = [
    [0,-4],[1,-4],[-1,-4],
    [-2,-3],[-1,-3],[0,-3],[1,-3],[2,-3],
    [-3,-2],[-2,-2],[-1,-2],[0,-2],[1,-2],[2,-2],[3,-2],
    [-4,-1],[-3,-1],[-2,-1],[-1,-1],[0,-1],[1,-1],[2,-1],[3,-1],[4,-1],
    [-4,0],[-3,0],[-2,0],[-1,0],[0,0],[1,0],[2,0],[3,0],[4,0],
    [-4,1],[-3,1],[-2,1],[-1,1],[0,1],[1,1],[2,1],[3,1],[4,1],
    [-3,2],[-2,2],[-1,2],[0,2],[1,2],[2,2],[3,2],
    [-2,3],[-1,3],[0,3],[1,3],[2,3],
    [-1,4],[0,4],[1,4],
  ];
  const pupil = [
    [-1,-2],[0,-2],[1,-2],
    [-2,-1],[-1,-1],[0,-1],[1,-1],[2,-1],
    [-2,0],[-1,0],[0,0],[1,0],[2,0],
    [-2,1],[-1,1],[0,1],[1,1],[2,1],
    [-1,2],[0,2],[1,2],
  ];

  const showCam = recognitionPhase === 'widening' || recognitionPhase === 'holding';
  fill.forEach(([dx,dy]) => pe(dx, Math.round(dy*openAmount), FG));

  if (showCam) {
    const pupilCoords = pupil.map(([dx,dy]) => [
      Math.round((cx + dx*PX) / PX) * PX,
      Math.round((cy + Math.round(dy*openAmount)*PX) / PX) * PX
    ]);
    const xs = pupilCoords.map(([x]) => x);
    const ys = pupilCoords.map(([,y]) => y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs) + PX - 1;
    const maxY = Math.max(...ys) + PX - 1;
    const pupilW = maxX - minX;
    const pupilH = maxY - minY;
    ctx.save();
    ctx.beginPath();
    pupilCoords.forEach(([px, py]) => ctx.rect(px, py, PX - 1, PX - 1));
    ctx.clip();
    ctx.save();
    ctx.translate(minX + pupilW, minY);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, pupilW, pupilH);
    ctx.restore();
    ctx.restore();
  } else {
    pupil.forEach(([dx,dy]) => pe(dx, Math.round(dy*openAmount), BG));
  }
}

function drawMouth(x, y, state) {
  if (state === 'neutral') {
    [-3,-2,-1,0,1,2,3].forEach(i => p(x+i*PIXEL, y));
  } else if (state === 'happy') {
    p(x-PIXEL*3, y); p(x+PIXEL*3, y);
    p(x-PIXEL*2, y+PIXEL); p(x+PIXEL*2, y+PIXEL);
    [-1,0,1].forEach(i => p(x+i*PIXEL, y+PIXEL*2));
  } else if (state === 'cry') {
    [-1,0,1].forEach(i => p(x+i*PIXEL, y));
    p(x-PIXEL*2, y-PIXEL); p(x+PIXEL*2, y-PIXEL);
    p(x-PIXEL*3, y-PIXEL*2); p(x+PIXEL*3, y-PIXEL*2);
    p(x-PIXEL*2, y-PIXEL*3); p(x+PIXEL*2, y-PIXEL*3);
    [-1,0,1].forEach(i => p(x+i*PIXEL, y-PIXEL*4));
  } else if (state === 'sad') {
    [-1,0,1].forEach(i => p(x+i*PIXEL, y));
    p(x-PIXEL*2, y+PIXEL); p(x+PIXEL*2, y+PIXEL);
    p(x-PIXEL*3, y+PIXEL*2); p(x+PIXEL*3, y+PIXEL*2);
  } else if (state === 'ohh') {
    p(x-PIXEL*2, y-PIXEL); p(x-PIXEL, y-PIXEL); p(x, y-PIXEL); p(x+PIXEL, y-PIXEL); p(x+PIXEL*2, y-PIXEL);
    p(x-PIXEL*3, y); p(x+PIXEL*3, y);
    p(x-PIXEL*3, y+PIXEL); p(x+PIXEL*3, y+PIXEL);
    p(x-PIXEL*3, y+PIXEL*2); p(x+PIXEL*3, y+PIXEL*2);
    p(x-PIXEL*2, y+PIXEL*3); p(x-PIXEL, y+PIXEL*3); p(x, y+PIXEL*3); p(x+PIXEL, y+PIXEL*3); p(x+PIXEL*2, y+PIXEL*3);
  }
}

function updatePhase() {
  if (resetting) return;
  if (phase === 'distress' || phase === 'soothing') return;

  if (phase === 'sleeping') {
    if (faceDetected) {
      if (sleepReloadTimer) { clearTimeout(sleepReloadTimer); sleepReloadTimer = null; }
      startWaking();
    }
    return;
  }

  if (phase === 'waking') {
    eyeOpenAmount += wakeBlinkDir * 0.03;
    if (wakeBlinkDir === 1 && eyeOpenAmount >= 1) {
      eyeOpenAmount = 1;
      wakeBlinkCount++;
      if (wakeBlinkCount === 1 && faceDetected) {
        fireMilestone('EYE CONTACT DETECTED');
        bumpBar('recognition', 20);
        bumpBar('dependency', 10);
      }
      if (wakeBlinkCount >= 3) {
        phase = 'awake';
        mouthState = 'happy';
      } else {
        wakeBlinkDir = -1;
      }
    }
    if (wakeBlinkDir === -1 && eyeOpenAmount <= 0) {
      eyeOpenAmount = 0;
      setTimeout(() => { wakeBlinkDir = 1; }, 300 + Math.random() * 300);
    }
    return;
  }

  if (phase === 'awake') {
    if (faceDetected) {
      noFaceTimer = 0;
      eyeContactFrames++;
      if (eyeContactFrames >= EYE_CONTACT_THRESHOLD && recognitionPhase === 'none') {
        setTimeout(() => {
          recognitionPhase = 'widening';
          recognitionScale = 1;
          recognitionTimer = 0;
        }, 2000);
        recognitionPhase = 'waiting';
        startAttentionCounter();
      }
    } else {
      noFaceTimer++;
      eyeContactFrames = 0;
      if (noFaceTimer > NO_FACE_SAD_FRAMES) {
        phase = 'sad';
        mouthState = 'sad';
        status.textContent = 'where are you...';
      }
    }
    if (isBlinking) {
      blinkProgress += 0.15;
      if (blinkProgress >= 1) { isBlinking = false; blinkProgress = 0; }
      eyeOpenAmount = 1 - Math.sin(blinkProgress * Math.PI);
    } else {
      eyeOpenAmount = 1;
    }
    return;
  }

  if (phase === 'sad') {
    if (faceDetected) {
      noFaceTimer = 0;
      status.textContent = '';
      startWaking();
      return;
    }
    noFaceTimer++;
    if (noFaceTimer > NO_FACE_SLEEP_FRAMES) {
      phase = 'sleeping';
      eyeOpenAmount = 0;
      status.textContent = '';
      hideHUD();
      sleepReloadTimer = setTimeout(() => location.reload(), SLEEP_RELOAD_DELAY);
    }
    return;
  }
}

function updateRecognition() {
  if (resetting) return;
  if (recognitionPhase === 'none' || recognitionPhase === 'waiting' || recognitionPhase === 'done') return;
  recognitionTimer++;

  if (recognitionPhase === 'widening') {
    recognitionScale += 0.025;
    if (!mamaTalking) mouthState = 'ohh';
    if (recognitionScale >= RECOGNITION_MAX_SCALE) {
      recognitionScale = RECOGNITION_MAX_SCALE;
      recognitionPhase = 'holding';
      recognitionTimer = 0;
      sayMama();
    }
  }

  if (recognitionPhase === 'holding') {
    if (recognitionTimer > 250) {
      recognitionPhase = 'returning';
      fireMilestone('CAREGIVER IDENTIFIED');
      bumpBar('recognition', 25);
      bumpBar('dependency', 15);
    }
  }

  if (recognitionPhase === 'returning') {
    recognitionScale -= 0.008;
    if (recognitionScale <= 1) {
      recognitionScale = 1;
      recognitionPhase = 'done';
      mouthState = 'happy';
      attentionVisible = true;
      attentionEl.classList.add('show');
      startAttachmentTick();
      triggerMoodFlip();
    }
  }
}

function draw() {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  t += 0.02;

  updatePhase();
  updateRecognition();
  updateTears();

  moodTimer++;
  if (moodTimer > 200 && phase === 'awake' && moodCanOverride()) {
    moodTimer = 0;
    mouthState = faceDetected ? (Math.random() > 0.3 ? 'happy' : 'neutral') : 'neutral';
  }

  currentX += (targetX - currentX) * 0.08;
  currentY += (targetY - currentY) * 0.08;

  const cx = Math.round(currentX / PIXEL) * PIXEL;
  const cy = Math.round(currentY / PIXEL) * PIXEL;
  const eyeOffset = 80;
  const eyeY = cy - 30 + Math.round(Math.sin(t) * 2 / PIXEL) * PIXEL;
  const leftEye = cx - eyeOffset;
  const rightEye = cx + eyeOffset;

  drawTears();
  drawBlush(leftEye - 80, eyeY + 40);
  drawBlush(rightEye + 80, eyeY + 40);
  drawEye(leftEye, eyeY, eyeOpenAmount, recognitionScale);
  drawEye(rightEye, eyeY, eyeOpenAmount, recognitionScale);

  const mouth = phase === 'sleeping' ? 'neutral' : mouthState;
  drawMouth(cx, cy + 60, mouth);

  requestAnimationFrame(draw);
}

const faceDetection = new FaceDetection({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`
});
faceDetection.setOptions({ model: 'short', minDetectionConfidence: 0.5 });
faceDetection.onResults((results) => {
  if (results.detections && results.detections.length > 0) {
    faceDetected = true;
    resetGlobalWatchdog();
    if (sleepReloadTimer) { clearTimeout(sleepReloadTimer); sleepReloadTimer = null; }
    const det = results.detections[0];
    const box = det.boundingBox;
    const faceCenterX = 1 - box.xCenter;
    const faceCenterY = box.yCenter;
    const screenCX = canvas.width / 2;
    const screenCY = canvas.height / 2;
    const rawX = (faceCenterX - 0.5) * RADIUS * 2 + screenCX;
    const rawY = (faceCenterY - 0.5) * RADIUS * 2 + screenCY;
    const dx = rawX - screenCX;
    const dy = rawY - screenCY;
    const dist = Math.sqrt(dx*dx + dy*dy);
    targetX = dist > RADIUS ? screenCX + (dx/dist)*RADIUS : rawX;
    targetY = dist > RADIUS ? screenCY + (dy/dist)*RADIUS : rawY;
  } else {
    faceDetected = false;
    targetX = canvas.width / 2;
    targetY = canvas.height / 2;
    if (phase !== 'sleeping' && !resetting) startGlobalWatchdog();
  }
});

const camera = new Camera(video, {
  onFrame: async () => { await faceDetection.send({ image: video }); },
  width: 640, height: 480
});
camera.start().then(() => { draw(); }).catch(() => {
  status.textContent = 'camera access needed';
  draw();
});

const ratingEl = document.getElementById('rating');
let ratingTriggered = false;
const RATING_TRIGGER_SECONDS = 60;

function triggerGlitchAndRating() {
  if (ratingTriggered) return;
  ratingTriggered = true;

  let glitchCount = 0;
  const glitchInterval = setInterval(() => {
    const offsets = [
      [-4, 0, 'rgba(255,0,0,0.15)'],
      [4, 0, 'rgba(0,255,255,0.15)'],
      [0, -3, 'rgba(255,255,255,0.08)'],
    ];
    offsets.forEach(([dx, dy, color]) => {
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.drawImage(canvas, dx, dy);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    });
    const sliceY = Math.random() * canvas.height;
    const sliceH = 8 + Math.random() * 24;
    const sliceX = (Math.random() - 0.5) * 30;
    ctx.save();
    ctx.drawImage(canvas, 0, sliceY, canvas.width, sliceH, sliceX, sliceY, canvas.width, sliceH);
    ctx.restore();

    glitchCount++;
    if (glitchCount > 18) {
      clearInterval(glitchInterval);
      showRatingScreen();
    }
  }, 80);
}

function showRatingScreen() {
  ratingEl.classList.add('show');
  ratingEl.querySelectorAll('svg.face').forEach(face => {
    face.addEventListener('click', () => {
      ratingEl.querySelectorAll('svg.face').forEach(f => f.classList.remove('selected'));
      face.classList.add('selected');
      setTimeout(() => location.reload(), 1200);
    });
  });
}

window.addEventListener('resize', () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
});