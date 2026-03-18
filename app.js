// app.js
// Requires opencv.js loaded (async). We guard until cv is ready.

let video = document.getElementById('video');
let origCanvas = document.getElementById('origCanvas');
let resultCanvas = document.getElementById('resultCanvas');
let fileInput = document.getElementById('fileInput');
let startBtn = document.getElementById('startBtn');
let captureBtn = document.getElementById('captureBtn');
let detectBtn = document.getElementById('detectBtn');
let applyBtn = document.getElementById('applyBtn');
let downloadBtn = document.getElementById('downloadBtn');
let handlesDiv = document.getElementById('handles');

let origCtx = origCanvas.getContext('2d');
let videoStream = null;

// state for detected corners (in canvas coordinate space)
let corners = null; // [{x,y},...4] or null
let handleElems = []; // DOM elements for drag handles

// default color-adjust parameters (ONLY these are applied after transform)
const COLOR_PARAMS = {
  contrastAlpha: 1.5, // 대비 (1.0 = no change). ~50% increase
  brightnessBeta: 50, // 밝기 추가 (0 = no change). range typical 0..100
  // We do NOT apply threshold, normalize, blur, or other filters.
};

// --- helper: wait until OpenCV is ready ---
function onOpenCvReady(cb) {
  if (typeof cv !== 'undefined' && cv && cv.imread) {
    cb();
  } else {
    // wait a bit
    let tries = 0;
    let t = setInterval(() => {
      tries++;
      if (typeof cv !== 'undefined' && cv && cv.imread) {
        clearInterval(t);
        cb();
      } else if (tries > 50) {
        clearInterval(t);
        console.error('opencv not ready');
      }
    }, 100);
  }
}

// --- camera functions ---
startBtn.addEventListener('click', async () => {
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = videoStream;
    await video.play();
    resizeOrigCanvasToVideo();
  } catch (e) {
    alert('카메라 접근 실패: ' + e.message);
  }
});

function resizeOrigCanvasToVideo() {
  origCanvas.width = video.videoWidth;
  origCanvas.height = video.videoHeight;
  // keep displayed size responsive via CSS; drawing operations use the canvas pixel size
}

// capture current video frame to origCanvas
captureBtn.addEventListener('click', () => {
  if (!video.videoWidth) return alert('카메라가 준비되지 않았습니다.');
  origCanvas.width = video.videoWidth;
  origCanvas.height = video.videoHeight;
  origCtx.drawImage(video, 0, 0, origCanvas.width, origCanvas.height);
  // clear any previous handles
  clearHandles();
});

// file upload
fileInput.addEventListener('change', (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const img = new Image();
  img.onload = () => {
    origCanvas.width = img.naturalWidth;
    origCanvas.height = img.naturalHeight;
    origCtx.drawImage(img, 0, 0);
    clearHandles();
  };
  img.src = URL.createObjectURL(f);
});

// --- detect button: detect document contour and create draggable handles ---
detectBtn.addEventListener('click', () => {
  onOpenCvReady(() => {
    autoDetectDocument();
  });
});

// Apply transform + color-only adjustments
applyBtn.addEventListener('click', () => {
  onOpenCvReady(() => {
    applyTransformAndColor();
  });
});

// Download result
downloadBtn.addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = 'scan_result.png';
  link.href = resultCanvas.toDataURL();
  link.click();
});

// ---------------- Core: autoDetectDocument ----------------
function autoDetectDocument() {
  try {
    let src = cv.imread(origCanvas);
    let orig = src.clone();

    // Convert to gray and blur
    let gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5,5), 0);

    // Canny edges (conservative thresholds)
    let edges = new cv.Mat();
    cv.Canny(gray, edges, 50, 150);

    // Find contours (external to avoid many inner contours)
    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    // Find best quadrilateral by area
    let bestCnt = null;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      let cnt = contours.get(i);
      let area = cv.contourArea(cnt);
      if (area < 1000) { cnt.delete(); continue; } // too small
      let peri = cv.arcLength(cnt, true);
      let approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      if (approx.rows === 4 && area > bestArea) {
        if (bestCnt) bestCnt.delete();
        bestCnt = approx; // take ownership
        bestArea = area;
      } else {
        approx.delete();
      }
      cnt.delete();
    }

    if (!bestCnt) {
      // fallback: use full canvas rectangle
      corners = [
        {x:0,y:0},
        {x:orig.cols,y:0},
        {x:orig.cols,y:orig.rows},
        {x:0,y:orig.rows}
      ];
      drawHandles();
      src.delete(); orig.delete(); gray.delete(); edges.delete();
      contours.delete(); hierarchy.delete();
      if (bestCnt) bestCnt.delete();
      return;
    }

    // extract points from bestCnt (bestCnt is a Mat of 4x1x2)
    let pts = [];
    for (let i = 0; i < 4; i++) {
      let px = bestCnt.intPtr(i,0)[0];
      let py = bestCnt.intPtr(i,0)[1];
      pts.push({x:px, y:py});
    }

    // order points
    corners = orderPoints(pts);

    drawHandles();

    // cleanup
    src.delete(); orig.delete(); gray.delete(); edges.delete();
    contours.delete(); hierarchy.delete();
    bestCnt.delete();
  } catch (err) {
    console.error(err);
    alert('감지 중 오류 발생: ' + err.message);
  }
}

// ---------------- draw draggable handles ----------------
function clearHandles() {
  corners = null;
  handleElems.forEach(el => el.remove());
  handleElems = [];
}

function drawHandles() {
  // remove existing
  clearHandles();

  if (!corners) return;

  // Ensure overlay size matches canvas displayed size
  // We'll position handles based on canvas pixel coords but CSS absolute positioning uses client coords.
  const rect = origCanvas.getBoundingClientRect();
  const scaleX = rect.width / origCanvas.width;
  const scaleY = rect.height / origCanvas.height;

  corners.forEach((pt, idx) => {
    const el = document.createElement('div');
    el.className = 'handle';
    el.dataset.idx = idx;
    // position in client pixels:
    el.style.left = (pt.x * scaleX) + 'px';
    el.style.top = (pt.y * scaleY) + 'px';
    handlesDiv.appendChild(el);
    handleElems.push(el);

    // enable drag
    makeDraggable(el, scaleX, scaleY);
  });
}

// draggable primitive (pointer events)
function makeDraggable(el, scaleX, scaleY) {
  el.style.touchAction = 'none';
  let dragging = false;
  let startX=0, startY=0;

  const onPointerDown = (e) => {
    e.preventDefault();
    dragging = true;
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!dragging) return;
    const rect = origCanvas.getBoundingClientRect();
    // compute new client coords but clamp inside canvas rect
    let nx = Math.min(Math.max(e.clientX, rect.left), rect.right);
    let ny = Math.min(Math.max(e.clientY, rect.top), rect.bottom);
    el.style.left = (nx - rect.left) + 'px';
    el.style.top = (ny - rect.top) + 'px';
    // update corners state using inverse scale
    const idx = parseInt(el.dataset.idx);
    corners[idx].x = (nx - rect.left) / scaleX;
    corners[idx].y = (ny - rect.top) / scaleY;
  };
  const onPointerUp = (e) => {
    dragging = false;
  };

  el.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
}

// ---------------- applyTransformAndColor ----------------
function applyTransformAndColor() {
  if (!corners) {
    alert('먼저 문서 영역을 감지하세요 (Detect) 또는 이미지를 캡처/업로드하세요.');
    return;
  }

  // Prepare src mat
  let src = cv.imread(origCanvas);

  // Ensure points are within image
  for (let p of corners) {
    p.x = Math.max(0, Math.min(p.x, src.cols));
    p.y = Math.max(0, Math.min(p.y, src.rows));
  }

  // Convert corners into ordered srcPoints [tl, tr, br, bl]
  let srcPts = cv.matFromArray(4,1,cv.CV_32FC2, [
    corners[0].x, corners[0].y,
    corners[1].x, corners[1].y,
    corners[2].x, corners[2].y,
    corners[3].x, corners[3].y
  ]);

  // compute destination size
  const w1 = distance(corners[2], corners[3]);
  const w2 = distance(corners[1], corners[0]);
  const h1 = distance(corners[1], corners[2]);
  const h2 = distance(corners[0], corners[3]);
  const dstW = Math.round(Math.max(w1, w2));
  const dstH = Math.round(Math.max(h1, h2));

  let dstPts = cv.matFromArray(4,1,cv.CV_32FC2, [
    0, 0,
    dstW, 0,
    dstW, dstH,
    0, dstH
  ]);

  let M = cv.getPerspectiveTransform(srcPts, dstPts);

  let warped = new cv.Mat();
  // warpPerspective — this is the ONLY geometric change we perform
  cv.warpPerspective(src, warped, M, new cv.Size(dstW, dstH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

  // --- COLOR ONLY adjustments (strictly limited) ---
  // 1) convert to grayscale (user requested 흑백)
  let gray = new cv.Mat();
  cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY);

  // 2) apply linear contrast & brightness: final = gray * alpha + beta
  let final = new cv.Mat();
  // Using parameters from spec (contrastAlpha, brightnessBeta). These are moderate to preserve detail.
  gray.convertTo(final, -1, COLOR_PARAMS.contrastAlpha, COLOR_PARAMS.brightnessBeta);

  // IMPORTANT: we do NOT call normalize(), equalizeHist(), threshold(), medianBlur(), or similar.
  // That ensures we only changed pixel intensity linearly (contrast/brightness) and converted to grayscale.
  // (This matches "절대로 사진 건드리지 말고 색감만 바꿔" 요구.)

  // Show final in resultCanvas
  cv.imshow(resultCanvas, final);

  // cleanup
  src.delete();
  srcPts.delete(); dstPts.delete(); M.delete();
  warped.delete();
  gray.delete();
  final.delete();

  // keep handles visible if user wants to re-adjust; do NOT auto-delete them
}

// ---------------- utils ----------------
function distance(a,b){ return Math.hypot(a.x - b.x, a.y - b.y); }

// orderPoints: returns [tl, tr, br, bl]
function orderPoints(pts) {
  // pts: array of 4 {x,y}
  // sum and diff method is robust
  let sums = pts.map(p => p.x + p.y);
  let diffs = pts.map(p => p.x - p.y);
  let tl = pts[sums.indexOf(Math.min(...sums))];
  let br = pts[sums.indexOf(Math.max(...sums))];
  let tr = pts[diffs.indexOf(Math.min(...diffs))];
  let bl = pts[diffs.indexOf(Math.max(...diffs))];

  // make shallow copies to avoid aliasing issues
  return [{x:tl.x,y:tl.y},{x:tr.x,y:tr.y},{x:br.x,y:br.y},{x:bl.x,y:bl.y}];
}

// ensure canvas overlay sizing stays synced when window resizes
window.addEventListener('resize', () => {
  // if handles exist, reposition them to match new client coords
  if (!corners || handleElems.length === 0) return;
  const rect = origCanvas.getBoundingClientRect();
  const scaleX = rect.width / origCanvas.width;
  const scaleY = rect.height / origCanvas.height;
  handleElems.forEach((el, idx) => {
    el.style.left = (corners[idx].x * scaleX) + 'px';
    el.style.top  = (corners[idx].y * scaleY) + 'px';
  });
});

// If user clicks directly on canvas, allow manually creating corners (advanced fallback)
origCanvas.addEventListener('dblclick', (ev) => {
  // create simple full-image corners as fallback
  corners = [
    {x:0,y:0},
    {x:origCanvas.width, y:0},
    {x:origCanvas.width, y:origCanvas.height},
    {x:0, y:origCanvas.height}
  ];
  drawHandles();
});

// Make sure resultCanvas has reasonable display size
resultCanvas.width = 800;
resultCanvas.height = 1000;

// End of app.js
