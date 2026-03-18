// app.js — FINAL (A4-only crop, no color changes)
//
// Behavior:
// - Load image (file or camera capture) into #origCanvas
// - Detect quadrilaterals, choose A4-like outermost (largest A4-like) or largest quad
// - Auto-apply perspective warp to a destination A4 ratio size
// - Do NOT change colors/contrast/threshold/normalize/etc.
// - Provide draggable handles to manually correct corners
// - Robust OpenCV readiness and console logs for debugging

document.addEventListener('DOMContentLoaded', () => {
  // DOM elements
  const video = document.getElementById('video');
  const origCanvas = document.getElementById('origCanvas');
  const resultCanvas = document.getElementById('resultCanvas');
  const fileInput = document.getElementById('fileInput');
  const startBtn = document.getElementById('startBtn');
  const captureBtn = document.getElementById('captureBtn');
  const detectBtn = document.getElementById('detectBtn');
  const applyBtn = document.getElementById('applyBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const handlesDiv = document.getElementById('handles');

  const origCtx = origCanvas.getContext('2d');

  let videoStream = null;
  let corners = null;       // [{x,y},...4] in canvas pixel coordinates
  let handleElems = [];     // DOM handles

  const A4_RATIO = 210 / 297; // width/height
  const RATIO_TOL = 0.25;     // tolerance when selecting A4-like quads

  // Wait for OpenCV readiness (tries several strategies)
  function whenOpenCvReady(cb) {
    try {
      if (typeof cv !== 'undefined' && cv && typeof cv.imread === 'function') {
        cb();
        return;
      }
    } catch (e) { /* fall through */ }

    if (typeof cv !== 'undefined' && cv && typeof cv.onRuntimeInitialized === 'function') {
      cv.onRuntimeInitialized = () => {
        console.log('[app.js] OpenCV runtime initialized');
        cb();
      };
      return;
    }

    // Poll fallback
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (typeof cv !== 'undefined' && cv && typeof cv.imread === 'function') {
        clearInterval(t);
        console.log('[app.js] OpenCV detected via polling');
        cb();
      } else if (tries > 80) {
        clearInterval(t);
        console.error('[app.js] OpenCV not available');
      }
    }, 100);
  }

  // --- Camera start ---
  startBtn && startBtn.addEventListener('click', async () => {
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      video.srcObject = videoStream;
      await video.play();
      resizeOrigCanvasToVideo();
    } catch (e) {
      alert('카메라 접근 실패: ' + (e && e.message ? e.message : e));
      console.error('[app.js] camera start error', e);
    }
  });

  function resizeOrigCanvasToVideo() {
    if (!video) return;
    origCanvas.width = video.videoWidth || origCanvas.width;
    origCanvas.height = video.videoHeight || origCanvas.height;
  }

  // --- Capture frame ---
  captureBtn && captureBtn.addEventListener('click', () => {
    if (!video || !video.videoWidth) return alert('카메라가 준비되지 않았습니다.');
    origCanvas.width = video.videoWidth;
    origCanvas.height = video.videoHeight;
    origCtx.drawImage(video, 0, 0, origCanvas.width, origCanvas.height);
    clearHandles();
    console.log('[app.js] captured frame to canvas');
  });

  // --- File upload ---
  fileInput && fileInput.addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      origCanvas.width = img.naturalWidth;
      origCanvas.height = img.naturalHeight;
      origCtx.drawImage(img, 0, 0);
      clearHandles();
      console.log('[app.js] Image loaded to canvas from file');
    };
    img.src = URL.createObjectURL(f);
  });

  // --- Detect button ---
  detectBtn && detectBtn.addEventListener('click', () => {
    if (!origCanvas.width || !origCanvas.height) { alert('먼저 이미지를 업로드하거나 촬영하세요.'); return; }
    console.log('[app.js] detectBtn clicked — waiting for OpenCV');
    whenOpenCvReady(() => {
      console.log('[app.js] Running autoDetectDocumentA4');
      try {
        autoDetectDocumentA4();
      } catch (err) {
        console.error('[app.js] autoDetectDocumentA4 error', err);
        alert('문서 감지 중 오류가 발생했습니다. 콘솔 확인.');
      }
    });
  });

  // --- Apply button (manual) ---
  applyBtn && applyBtn.addEventListener('click', () => {
    if (!origCanvas.width || !origCanvas.height) { alert('먼저 이미지를 업로드하거나 촬영하세요.'); return; }
    whenOpenCvReady(() => {
      try {
        applyTransformA4();
      } catch (err) {
        console.error('[app.js] applyTransformA4 failed', err);
        alert('변환 중 오류. 콘솔 확인.');
      }
    });
  });

  // --- Download result ---
  downloadBtn && downloadBtn.addEventListener('click', () => {
    try {
      const link = document.createElement('a');
      link.download = 'scan_a4.png';
      link.href = resultCanvas.toDataURL();
      link.click();
    } catch (e) { console.error('[app.js] download error', e); }
  });

  // ---------------- Auto-detect A4-like outermost quad ----------------
  function autoDetectDocumentA4() {
    console.log('[app.js] autoDetectDocumentA4 start');

    if (typeof cv === 'undefined') { alert('OpenCV 준비 안됨'); return; }

    let src = null;
    try {
      src = cv.imread(origCanvas);
    } catch (e) {
      console.error('[app.js] cv.imread failed', e);
      alert('캔버스에서 이미지를 읽을 수 없습니다.');
      if (src) src.delete();
      return;
    }

    let gray = new cv.Mat();
    let edges = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5,5), 0);
      cv.Canny(gray, edges, 50, 150);
    } catch (e) {
      console.error('[app.js] preprocessing failed', e);
      src.delete(); if (gray) gray.delete(); if (edges) edges.delete();
      return;
    }

    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    try {
      cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    } catch (e) {
      console.error('[app.js] findContours failed', e);
      src.delete(); gray.delete(); edges.delete(); return;
    }

    // Collect quadrilateral candidates
    let quads = [];
    for (let i = 0; i < contours.size(); i++) {
      let cnt = contours.get(i);
      let area = cv.contourArea(cnt);
      if (area < 1000) { cnt.delete(); continue; }
      let peri = cv.arcLength(cnt, true);
      let approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      if (approx.rows === 4) {
        let pts = [];
        for (let j = 0; j < 4; j++) {
          pts.push({ x: approx.intPtr(j,0)[0], y: approx.intPtr(j,0)[1] });
        }
        pts = orderPoints(pts);
        let w = Math.max(distance(pts[0], pts[1]), distance(pts[2], pts[3]));
        let h = Math.max(distance(pts[0], pts[3]), distance(pts[1], pts[2]));
        if (h === 0) { approx.delete(); cnt.delete(); continue; }
        let ratio = w / h;
        let ratioDiff = Math.min(Math.abs(ratio - A4_RATIO), Math.abs((1/ratio) - A4_RATIO));
        quads.push({ pts, area, ratioDiff, w, h });
      }
      approx.delete();
      cnt.delete();
    }

    // cleanup mats used for analysis
    gray.delete(); edges.delete(); contours.delete(); hierarchy.delete();

    if (quads.length === 0) {
      // fallback: full canvas rectangle
      corners = [
        {x:0, y:0},
        {x:origCanvas.width, y:0},
        {x:origCanvas.width, y:origCanvas.height},
        {x:0, y:origCanvas.height}
      ];
      drawHandles();
      if (src) src.delete();
      console.log('[app.js] no quads found; used full-canvas fallback');
      return;
    }

    // Filter to A4-like candidates first, then choose largest by area
    let candidates = quads.filter(q => q.ratioDiff <= RATIO_TOL);
    let chosen = null;
    if (candidates.length > 0) {
      candidates.sort((a,b) => b.area - a.area);
      chosen = candidates[0];
      console.log('[app.js] chosen candidate (A4-like) area:', chosen.area, 'ratioDiff:', chosen.ratioDiff);
    } else {
      quads.sort((a,b) => b.area - a.area);
      chosen = quads[0];
      console.log('[app.js] no A4-like candidates; chosen largest quad area:', chosen.area, 'ratioDiff:', chosen.ratioDiff);
    }

    corners = chosen.pts.map(p => ({ x: p.x, y: p.y }));
    drawHandles();

    // Auto-apply after detection so user sees result immediately
    try {
      applyTransformA4();
    } catch (err) {
      console.error('[app.js] applyTransformA4 after detect failed', err);
    }

    if (src) src.delete();
    console.log('[app.js] autoDetectDocumentA4 complete');
  }

  // ---------------- Handles / Draggable ----------------
  function clearHandles() {
    corners = null;
    handleElems.forEach(el => el.remove());
    handleElems = [];
  }

  function drawHandles() {
    // remove existing
    handleElems.forEach(el => el.remove());
    handleElems = [];

    if (!corners) return;

    // Determine client-scale between canvas pixels and displayed size
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
      try { el.setPointerCapture && el.setPointerCapture(e.pointerId); } catch(_) {}
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
    const onPointerUp = () => { dragging = false; };
    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  // dblclick fallback = full image
  origCanvas.addEventListener('dblclick', () => {
    corners = [
      {x:0,y:0},
      {x:origCanvas.width,y:0},
      {x:origCanvas.width,y:origCanvas.height},
      {x:0,y:origCanvas.height}
    ];
    drawHandles();
  });

  // ---------------- Apply perspective transform to exact A4 ratio (ONLY geometry) ----------------
  function applyTransformA4() {
    if (!corners) { alert('먼저 문서 영역을 감지하세요.'); return; }
    if (typeof cv === 'undefined') { alert('OpenCV가 준비되지 않았습니다.'); return; }

    let src = null;
    try {
      src = cv.imread(origCanvas);
    } catch (err) {
      console.error('[app.js] cv.imread failed in applyTransformA4', err);
      if (src) src.delete();
      return;
    }

    // clamp corners inside image bounds
    for (let p of corners) {
      p.x = Math.max(0, Math.min(p.x, src.cols));
      p.y = Math.max(0, Math.min(p.y, src.rows));
    }

    // baseline width from detected quad
    const width = Math.max(
      distance(corners[0], corners[1]),
      distance(corners[2], corners[3])
    ) || Math.max(src.cols, 1);

    const height = Math.round(width / A4_RATIO);

    // cap extremely large sizes
    const MAX_DIM = 5000;
    let dstW = Math.round(width);
    let dstH = Math.round(height);
    if (dstH > MAX_DIM) {
      dstH = Math.round(Math.min(MAX_DIM, dstH));
      dstW = Math.round(dstH * A4_RATIO);
    }

    const srcPts = cv.matFromArray(4,1,cv.CV_32FC2, [
      corners[0].x, corners[0].y,
      corners[1].x, corners[1].y,
      corners[2].x, corners[2].y,
      corners[3].x, corners[3].y
    ]);

    const dstPts = cv.matFromArray(4,1,cv.CV_32FC2, [
      0,0,
      dstW,0,
      dstW,dstH,
      0,dstH
    ]);

    const M = cv.getPerspectiveTransform(srcPts, dstPts);
    const warped = new cv.Mat();
    cv.warpPerspective(src, warped, M, new cv.Size(dstW, dstH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

    // IMPORTANT: Do NOT modify color / contrast / thresholds etc.
    // Set resultCanvas pixel size then show
    resultCanvas.width = warped.cols;
    resultCanvas.height = warped.rows;
    cv.imshow(resultCanvas, warped);
    console.log('[app.js] result drawn:', warped.cols, warped.rows);

    // cleanup
    src.delete(); srcPts.delete(); dstPts.delete(); M.delete(); warped.delete();
  }

  // ---------------- Utilities ----------------
  function distance(a,b){ return Math.hypot(a.x - b.x, a.y - b.y); }
  function orderPoints(pts) {
    // return copies to avoid alias issues
    const sums = pts.map(p => p.x + p.y);
    const diffs = pts.map(p => p.x - p.y);
    const tl = pts[sums.indexOf(Math.min(...sums))];
    const br = pts[sums.indexOf(Math.max(...sums))];
    const tr = pts[diffs.indexOf(Math.min(...diffs))];
    const bl = pts[diffs.indexOf(Math.max(...diffs))];
    return [{x:tl.x,y:tl.y},{x:tr.x,y:tr.y},{x:br.x,y:br.y},{x:bl.x,y:bl.y}];
  }

  // reposition handles on window resize
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

  console.log('[app.js] Initialization complete. Ready.');
}); // DOMContentLoaded end
