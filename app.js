// app.js (FIXED)
// Replace your existing app.js with this file.
// Key: ensure DOMReady and OpenCV readiness before binding handlers,
// provide console logs and input checks so "문서 자동 감지" 버튼이 확실히 동작함.

// ---- Utility: wait for DOMContentLoaded ----
function whenDOMReady(cb) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', cb);
  } else {
    cb();
  }
}

// ---- Utility: wait for OpenCV readiness ----
function whenOpenCvReady(cb) {
  // If cv already present and usable
  try {
    if (typeof cv !== 'undefined' && cv && typeof cv.imread === 'function') {
      cb();
      return;
    }
  } catch (e) {
    // fall through to fallback
  }

  // If cv exists but not initialized, use onRuntimeInitialized
  if (typeof cv !== 'undefined' && cv) {
    if (typeof cv['onRuntimeInitialized'] === 'undefined') {
      // Some builds may not have this, fallback to interval
      console.log('[app.js] OpenCV object present but no onRuntimeInitialized; polling...');
    } else {
      cv['onRuntimeInitialized'] = () => {
        console.log('[app.js] OpenCV onRuntimeInitialized fired');
        cb();
      };
      return;
    }
  }

  // final fallback: poll occasionally for cv.imread
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (typeof cv !== 'undefined' && cv && typeof cv.imread === 'function') {
      clearInterval(t);
      console.log('[app.js] OpenCV detected via polling');
      cb();
    } else if (tries > 80) {
      clearInterval(t);
      console.error('[app.js] OpenCV not available after waiting');
    }
  }, 100);
}

// ---- Main initialization once DOM is ready ----
whenDOMReady(() => {
  // grab elements (safe)
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

  if (!origCanvas || !resultCanvas) {
    console.error('[app.js] Required canvas elements not found in DOM.');
    return;
  }

  const origCtx = origCanvas.getContext('2d');
  let videoStream = null;
  let corners = null;
  let handleElems = [];

  const A4_RATIO = 210 / 297;
  const RATIO_TOLERANCE = 0.25;

  // --- camera start ---
  startBtn && startBtn.addEventListener('click', async () => {
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      if (video) {
        video.srcObject = videoStream;
        await video.play();
        resizeOrigCanvasToVideo();
      }
    } catch (e) {
      alert('카메라 접근 실패: ' + (e && e.message ? e.message : e));
      console.error('[app.js] Camera start error', e);
    }
  });

  function resizeOrigCanvasToVideo() {
    if (!video) return;
    origCanvas.width = video.videoWidth || origCanvas.width;
    origCanvas.height = video.videoHeight || origCanvas.height;
  }

  captureBtn && captureBtn.addEventListener('click', () => {
    try {
      if (!video || !video.videoWidth) return alert('카메라가 준비되지 않았습니다.');
      origCanvas.width = video.videoWidth;
      origCanvas.height = video.videoHeight;
      origCtx.drawImage(video, 0, 0, origCanvas.width, origCanvas.height);
      clearHandles();
      console.log('[app.js] Captured frame to canvas');
    } catch (e) {
      console.error('[app.js] capture error', e);
    }
  });

  // file upload
  fileInput && fileInput.addEventListener('change', (ev) => {
    try {
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
    } catch (e) {
      console.error('[app.js] file input error', e);
    }
  });

  // Detect handler: wait for OpenCV then run
  detectBtn && detectBtn.addEventListener('click', () => {
    try {
      // quick check: ensure canvas has content (width/height)
      if (!origCanvas.width || !origCanvas.height) {
        alert('먼저 사진을 업로드하거나 카메라로 촬영하세요.');
        return;
      }
      console.log('[app.js] detectBtn clicked — waiting for OpenCV');
      whenOpenCvReady(() => {
        console.log('[app.js] Running autoDetectDocumentA4');
        try {
          autoDetectDocumentA4();
        } catch (err) {
          console.error('[app.js] autoDetectDocumentA4 failed', err);
          alert('문서 감지 중 오류가 발생했습니다. 콘솔 확인.');
        }
      });
    } catch (e) {
      console.error('[app.js] detectBtn handler error', e);
    }
  });

  // Apply transform (also waits for OpenCV)
  applyBtn && applyBtn.addEventListener('click', () => {
    if (!origCanvas.width || !origCanvas.height) {
      alert('먼저 사진을 업로드하거나 카메라로 촬영하세요.');
      return;
    }
    whenOpenCvReady(() => {
      try {
        applyTransformA4();
      } catch (err) {
        console.error('[app.js] applyTransformA4 failed', err);
        alert('변환 중 오류가 발생했습니다. 콘솔을 확인하세요.');
      }
    });
  });

  downloadBtn && downloadBtn.addEventListener('click', () => {
    try {
      const link = document.createElement('a');
      link.download = 'scan_a4.png';
      link.href = resultCanvas.toDataURL();
      link.click();
    } catch (e) {
      console.error('[app.js] download error', e);
    }
  });

  // ---------------- Auto-detect (A4 preference) ----------------
  function autoDetectDocumentA4() {
    console.log('[app.js] autoDetectDocumentA4 start');
    if (typeof cv === 'undefined') { console.error('[app.js] cv undefined at detect time'); alert('OpenCV가 준비되지 않았습니다. 잠시 후 다시 시도하세요.'); return; }
    let src = null;
    try {
      src = cv.imread(origCanvas);
    } catch (e) {
      console.error('[app.js] cv.imread failed', e);
      alert('캔버스에서 이미지를 읽을 수 없습니다. 이미지가 올바르게 로드되었는지 확인하세요.');
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
    }

    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    try {
      cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    } catch (e) {
      console.error('[app.js] findContours failed', e);
    }

    // collect quads
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
          let px = approx.intPtr(j,0)[0];
          let py = approx.intPtr(j,0)[1];
          pts.push({x:px, y:py});
        }
        pts = orderPoints(pts);
        let widthA = distance(pts[2], pts[3]);
        let widthB = distance(pts[1], pts[0]);
        let heightA = distance(pts[1], pts[2]);
        let heightB = distance(pts[0], pts[3]);
        let quadW = Math.max(widthA, widthB);
        let quadH = Math.max(heightA, heightB);
        if (quadH === 0) { approx.delete(); cnt.delete(); continue; }
        let quadRatio = quadW / quadH;
        let ratioDiff = Math.min(Math.abs(quadRatio - A4_RATIO), Math.abs((1/quadRatio) - A4_RATIO));
        quads.push({pts: pts, area: area, ratioDiff: ratioDiff, w: quadW, h: quadH});
      }
      approx.delete();
      cnt.delete();
    }

    // cleanup mats used for analysis
    gray.delete(); edges.delete(); contours.delete(); hierarchy.delete();

    if (quads.length === 0) {
      // fallback: full canvas rect
      corners = [
        {x:0,y:0},
        {x:origCanvas.width,y:0},
        {x:origCanvas.width,y:origCanvas.height},
        {x:0,y:origCanvas.height}
      ];
      drawHandles();
      src.delete();
      console.log('[app.js] no quads found; using full-canvas fallback');
      return;
    }

    // filter A4-like
    let candidates = quads.filter(q => q.ratioDiff <= RATIO_TOLERANCE);

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

    corners = chosen.pts.map(p => ({x: p.x, y: p.y}));
    drawHandles();
    if (src) src.delete();
    console.log('[app.js] autoDetectDocumentA4 complete');
  }

  // ---------------- draw handles and draggable behavior ----------------
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
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
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

  // ---------------- apply transform to A4 ratio (ONLY geometry) ----------------
  function applyTransformA4() {
    if (!corners) return alert('먼저 문서 영역을 감지하거나 수동으로 꼭짓점을 지정하세요.');
    if (typeof cv === 'undefined') return alert('OpenCV가 준비되지 않았습니다.');

    let src = null;
    try {
      src = cv.imread(origCanvas);
    } catch (e) {
      console.error('[app.js] cv.imread failed in apply', e);
      alert('원본 이미지를 읽을 수 없습니다.');
      if (src) src.delete();
      return;
    }

    // clamp
    for (let p of corners) {
      p.x = Math.max(0, Math.min(p.x, src.cols));
      p.y = Math.max(0, Math.min(p.y, src.rows));
    }

    const widthA = distance(corners[2], corners[3]);
    const widthB = distance(corners[1], corners[0]);
    const heightA = distance(corners[1], corners[2]);
    const heightB = distance(corners[0], corners[3]);
    const quadW = Math.max(widthA, widthB);
    const quadH = Math.max(heightA, heightB);

    let dstW = Math.round(Math.max(1, quadW));
    let dstH = Math.round(dstW / A4_RATIO);
    const MAX_DIM = 5000;
    if (dstH > MAX_DIM) {
      dstH = Math.round(Math.max(1, quadH));
      dstW = Math.round(dstH * A4_RATIO);
    }

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

    // IMPORTANT: Do NOT modify colors / apply threshold / normalize etc.
    cv.imshow(resultCanvas, warped);

    // cleanup
    src.delete(); srcPts.delete(); dstPts.delete(); M.delete(); warped.delete();
    console.log('[app.js] applyTransformA4 done; resultCanvas updated');
  }

  // ---------------- small utils ----------------
  function distance(a,b){ return Math.hypot(a.x - b.x, a.y - b.y); }
  function orderPoints(pts) {
    let sums = pts.map(p => p.x + p.y);
    let diffs = pts.map(p => p.x - p.y);
    let tl = pts[sums.indexOf(Math.min(...sums))];
    let br = pts[sums.indexOf(Math.max(...sums))];
    let tr = pts[diffs.indexOf(Math.min(...diffs))];
    let bl = pts[diffs.indexOf(Math.max(...diffs))];
    return [{x:tl.x,y:tl.y},{x:tr.x,y:tr.y},{x:br.x,y:br.y},{x:bl.x,y:bl.y}];
  }

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

  origCanvas.addEventListener('dblclick', () => {
    corners = [
      {x:0,y:0},
      {x:origCanvas.width,y:0},
      {x:origCanvas.width,y:origCanvas.height},
      {x:0,y:origCanvas.height}
    ];
    drawHandles();
  });

  // size for result canvas display (doesn't affect warp size)
  resultCanvas.width = 800;
  resultCanvas.height = 1124;

  console.log('[app.js] Initialization complete. Ready.');
}); // end whenDOMReady
