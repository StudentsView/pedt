// app.js (UPDATED)
// 요구: A4 비율(210mm x 297mm) 기반으로만 자르고,
// 내부 테이블/박스가 아닌 "최외각의 A4 유사 사각형(면적 큰 쪽)" 선택.
// 절대 색감 보정하지 않음 — 오직 perspective warp(자르기)만 수행.

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
let corners = null; // [{x,y},...4]
let handleElems = [];

// target A4 ratio (width / height)
const A4_RATIO = 210 / 297; // ~0.7070707

// Wait for OpenCV to be ready before using
function onOpenCvReady(cb) {
  if (typeof cv !== 'undefined' && cv && cv.imread) {
    cb();
  } else {
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

// --- Camera controls ---
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
  origCanvas.width = video.videoWidth || origCanvas.width;
  origCanvas.height = video.videoHeight || origCanvas.height;
}

captureBtn.addEventListener('click', () => {
  if (!video.videoWidth) return alert('카메라가 준비되지 않았습니다.');
  origCanvas.width = video.videoWidth;
  origCanvas.height = video.videoHeight;
  origCtx.drawImage(video, 0, 0, origCanvas.width, origCanvas.height);
  clearHandles();
});

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

// --- Detect & Apply ---
detectBtn.addEventListener('click', () => {
  onOpenCvReady(() => autoDetectDocumentA4());
});

applyBtn.addEventListener('click', () => {
  onOpenCvReady(() => applyTransformA4());
});

downloadBtn.addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = 'scan_a4.png';
  link.href = resultCanvas.toDataURL();
  link.click();
});

// ---------------- Auto-detect documents and pick A4-like outermost quad ----------------
function autoDetectDocumentA4() {
  try {
    let src = cv.imread(origCanvas);
    let gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5,5), 0);

    let edges = new cv.Mat();
    cv.Canny(gray, edges, 50, 150);

    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    // collect quadrilaterals
    let quads = []; // {pts:[{x,y}...4], area, ratioDiff}
    for (let i = 0; i < contours.size(); i++) {
      let cnt = contours.get(i);
      let area = cv.contourArea(cnt);
      if (area < 1000) { cnt.delete(); continue; } // too small
      let peri = cv.arcLength(cnt, true);
      let approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

      if (approx.rows === 4) {
        // extract points
        let pts = [];
        for (let j = 0; j < 4; j++) {
          let px = approx.intPtr(j,0)[0];
          let py = approx.intPtr(j,0)[1];
          pts.push({x:px, y:py});
        }
        pts = orderPoints(pts); // tl,tr,br,bl
        // compute width/height sizes
        let widthA = distance(pts[2], pts[3]);
        let widthB = distance(pts[1], pts[0]);
        let heightA = distance(pts[1], pts[2]);
        let heightB = distance(pts[0], pts[3]);
        let quadW = Math.max(widthA, widthB);
        let quadH = Math.max(heightA, heightB);
        if (quadH === 0) { approx.delete(); cnt.delete(); continue; }
        let quadRatio = quadW / quadH;
        // ratio diff tolerant to rotation (compare both quadRatio and its inverse)
        let ratioDiff = Math.min(Math.abs(quadRatio - A4_RATIO), Math.abs((1/quadRatio) - A4_RATIO));
        quads.push({pts: pts, area: area, ratioDiff: ratioDiff, w: quadW, h: quadH});
      }
      approx.delete();
      cnt.delete();
    }

    // Cleanup Mats
    src.delete(); gray.delete(); edges.delete();
    contours.delete(); hierarchy.delete();

    if (quads.length === 0) {
      // fallback to full canvas
      corners = [
        {x:0,y:0},
        {x:origCanvas.width, y:0},
        {x:origCanvas.width, y:origCanvas.height},
        {x:0, y:origCanvas.height}
      ];
      drawHandles();
      return;
    }

    // Filter for A4-like quads: tolerance value (tunable)
    const RATIO_TOLERANCE = 0.25; // 허용 편차 (절대값). 0.25는 꽤 관대함.
    let candidates = quads.filter(q => q.ratioDiff <= RATIO_TOLERANCE);

    let chosen = null;
    if (candidates.length > 0) {
      // pick the candidate with the largest area (ensures outermost selected when inner boxes present)
      candidates.sort((a,b) => b.area - a.area);
      chosen = candidates[0];
    } else {
      // no A4-like candidates: pick the largest quad overall
      quads.sort((a,b) => b.area - a.area);
      chosen = quads[0];
    }

    corners = chosen.pts.map(p => ({x: p.x, y: p.y}));
    drawHandles();
  } catch (err) {
    console.error('autoDetectDocumentA4 error:', err);
    alert('문서 감지 중 오류가 발생했습니다: ' + err.message);
  }
}

// ---------------- Draw draggable handles (unchanged) ----------------
function clearHandles() {
  corners = null;
  handleElems.forEach(el => el.remove());
  handleElems = [];
}

function drawHandles() {
  clearHandles();
  if (!corners) return;

  const rect = origCanvas.getBoundingClientRect();
  const scaleX = rect.width / origCanvas.width;
  const scaleY = rect.height / origCanvas.height;

  corners.forEach((pt, idx) => {
    const el = document.createElement('div');
    el.className = 'handle';
    el.dataset.idx = idx;
    el.style.left = (pt.x * scaleX) + 'px';
    el.style.top = (pt.y * scaleY) + 'px';
    handlesDiv.appendChild(el);
    handleElems.push(el);
    makeDraggable(el, scaleX, scaleY);
  });
}

function makeDraggable(el, scaleX, scaleY) {
  el.style.touchAction = 'none';
  let dragging = false;

  const onPointerDown = (e) => {
    e.preventDefault();
    dragging = true;
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!dragging) return;
    const rect = origCanvas.getBoundingClientRect();
    let nx = Math.min(Math.max(e.clientX, rect.left), rect.right);
    let ny = Math.min(Math.max(e.clientY, rect.top), rect.bottom);
    el.style.left = (nx - rect.left) + 'px';
    el.style.top = (ny - rect.top) + 'px';
    const idx = parseInt(el.dataset.idx);
    corners[idx].x = (nx - rect.left) / scaleX;
    corners[idx].y = (ny - rect.top) / scaleY;
  };
  const onPointerUp = (e) => { dragging = false; };

  el.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
}

// ---------------- Apply perspective transform to EXACT A4 ratio (no color change) ----------------
function applyTransformA4() {
  if (!corners) return alert('먼저 문서 영역을 감지하거나 수동으로 꼭짓점을 지정하세요.');

  let src = cv.imread(origCanvas);

  // clamp corners inside image bounds
  for (let p of corners) {
    p.x = Math.max(0, Math.min(p.x, src.cols));
    p.y = Math.max(0, Math.min(p.y, src.rows));
  }

  // compute quad sizes
  const widthA = distance(corners[2], corners[3]);
  const widthB = distance(corners[1], corners[0]);
  const heightA = distance(corners[1], corners[2]);
  const heightB = distance(corners[0], corners[3]);
  const quadW = Math.max(widthA, widthB);
  const quadH = Math.max(heightA, heightB);

  // Determine destination size preserving A4 ratio.
  // Use quadW as baseline, compute dstH = quadW / A4_RATIO.
  // If dstH is excessively large (> 4000px), fallback to using quadH baseline.
  let dstW = Math.round(Math.max(1, quadW));
  let dstH = Math.round(dstW / A4_RATIO);

  const MAX_DIM = 5000;
  if (dstH > MAX_DIM) {
    // fallback: use height baseline instead
    dstH = Math.round(Math.max(1, quadH));
    dstW = Math.round(dstH * A4_RATIO);
  }

  // Compose src/dst matrices for perspective transform
  let srcPts = cv.matFromArray(4,1,cv.CV_32FC2, [
    corners[0].x, corners[0].y,
    corners[1].x, corners[1].y,
    corners[2].x, corners[2].y,
    corners[3].x, corners[3].y
  ]);
  let dstPts = cv.matFromArray(4,1,cv.CV_32FC2, [
    0, 0,
    dstW, 0,
    dstW, dstH,
    0, dstH
  ]);

  let M = cv.getPerspectiveTransform(srcPts, dstPts);
  let warped = new cv.Mat();
  cv.warpPerspective(src, warped, M, new cv.Size(dstW, dstH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

  // IMPORTANT: No color / contrast / threshold / normalize operations.
  // User requested only geometric transform (crop + warp) — so present warped as-is.
  cv.imshow(resultCanvas, warped);

  // cleanup
  src.delete();
  srcPts.delete();
  dstPts.delete();
  M.delete();
  warped.delete();
}

// ---------------- Utilities ----------------
function distance(a,b){ return Math.hypot(a.x - b.x, a.y - b.y); }

// order points into [tl, tr, br, bl]
function orderPoints(pts) {
  // returns new array copies
  let sums = pts.map(p => p.x + p.y);
  let diffs = pts.map(p => p.x - p.y);
  let tl = pts[sums.indexOf(Math.min(...sums))];
  let br = pts[sums.indexOf(Math.max(...sums))];
  let tr = pts[diffs.indexOf(Math.min(...diffs))];
  let bl = pts[diffs.indexOf(Math.max(...diffs))];
  return [{x:tl.x,y:tl.y},{x:tr.x,y:tr.y},{x:br.x,y:br.y},{x:bl.x,y:bl.y}];
}

// sync handles on resize
window.addEventListener('resize', () => {
  if (!corners || handleElems.length === 0) return;
  const rect = origCanvas.getBoundingClientRect();
  const scaleX = rect.width / origCanvas.width;
  const scaleY = rect.height / origCanvas.height;
  handleElems.forEach((el, idx) => {
    el.style.left = (corners[idx].x * scaleX) + 'px';
    el.style.top  = (corners[idx].y * scaleY) + 'px';
  });
});

// dblclick fallback to full-image rectangle
origCanvas.addEventListener('dblclick', (ev) => {
  corners = [
    {x:0,y:0},
    {x:origCanvas.width, y:0},
    {x:origCanvas.width, y:origCanvas.height},
    {x:0, y:origCanvas.height}
  ];
  drawHandles();
});

// Set a reasonable initial size for result display (CSS will adapt)
resultCanvas.width = 800;
resultCanvas.height = 1124; // A4-ish for display

// End of updated app.js
