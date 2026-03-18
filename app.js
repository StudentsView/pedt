// app.js (FINAL - stable)

document.addEventListener('DOMContentLoaded', () => {

const video = document.getElementById('video');
const origCanvas = document.getElementById('origCanvas');
const resultCanvas = document.getElementById('resultCanvas');
const fileInput = document.getElementById('fileInput');
const detectBtn = document.getElementById('detectBtn');
const applyBtn = document.getElementById('applyBtn');

const origCtx = origCanvas.getContext('2d');

let corners = null;

const A4_RATIO = 210 / 297;
const RATIO_TOL = 0.25;

// ---------------- 이미지 업로드 ----------------
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const img = new Image();
  img.onload = () => {
    origCanvas.width = img.width;
    origCanvas.height = img.height;
    origCtx.drawImage(img, 0, 0);
    console.log('이미지 로드 완료');
  };
  img.src = URL.createObjectURL(file);
});

// ---------------- 자동 감지 ----------------
detectBtn.addEventListener('click', () => {
  if (!origCanvas.width) {
    alert('이미지 먼저 넣어라');
    return;
  }
  autoDetect();
});

function autoDetect() {
  let src = cv.imread(origCanvas);
  let gray = new cv.Mat();
  let edges = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5,5), 0);
  cv.Canny(gray, edges, 50, 150);

  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();

  cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let best = null;

  for (let i = 0; i < contours.size(); i++) {
    let cnt = contours.get(i);
    let area = cv.contourArea(cnt);

    if (area < 1000) continue;

    let peri = cv.arcLength(cnt, true);
    let approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

    if (approx.rows === 4) {
      let pts = [];
      for (let j = 0; j < 4; j++) {
        pts.push({
          x: approx.intPtr(j,0)[0],
          y: approx.intPtr(j,0)[1]
        });
      }

      pts = orderPoints(pts);

      let w = Math.max(
        distance(pts[0], pts[1]),
        distance(pts[2], pts[3])
      );

      let h = Math.max(
        distance(pts[0], pts[3]),
        distance(pts[1], pts[2])
      );

      let ratio = w / h;
      let diff = Math.min(
        Math.abs(ratio - A4_RATIO),
        Math.abs((1/ratio) - A4_RATIO)
      );

      if (!best || diff < best.diff) {
        best = { pts, diff, area };
      }
    }
  }

  if (!best) {
    alert('문서 못 찾음');
    src.delete(); gray.delete(); edges.delete();
    contours.delete(); hierarchy.delete();
    return;
  }

  corners = best.pts;

  console.log('문서 감지 완료');

  // 🔥 자동 변환 실행
  applyTransform();

  src.delete(); gray.delete(); edges.delete();
  contours.delete(); hierarchy.delete();
}

// ---------------- 변환 ----------------
function applyTransform() {
  if (!corners) return;

  let src = cv.imread(origCanvas);

  let width = Math.max(
    distance(corners[0], corners[1]),
    distance(corners[2], corners[3])
  );

  let height = width / A4_RATIO;

  let srcPts = cv.matFromArray(4,1,cv.CV_32FC2, [
    corners[0].x, corners[0].y,
    corners[1].x, corners[1].y,
    corners[2].x, corners[2].y,
    corners[3].x, corners[3].y
  ]);

  let dstPts = cv.matFromArray(4,1,cv.CV_32FC2, [
    0,0,
    width,0,
    width,height,
    0,height
  ]);

  let M = cv.getPerspectiveTransform(srcPts, dstPts);
  let dst = new cv.Mat();

  cv.warpPerspective(
    src,
    dst,
    M,
    new cv.Size(width, height),
    cv.INTER_LINEAR,
    cv.BORDER_CONSTANT,
    new cv.Scalar()
  );

  // 🔥 절대 색감 건드리지 않음
  cv.imshow(resultCanvas, dst);

  src.delete();
  dst.delete();
  srcPts.delete();
  dstPts.delete();
  M.delete();
}

// ---------------- 유틸 ----------------
function distance(a,b){
  return Math.hypot(a.x-b.x, a.y-b.y);
}

function orderPoints(pts) {
  let sum = pts.map(p => p.x + p.y);
  let diff = pts.map(p => p.x - p.y);

  return [
    pts[sum.indexOf(Math.min(...sum))],
    pts[diff.indexOf(Math.min(...diff))],
    pts[sum.indexOf(Math.max(...sum))],
    pts[diff.indexOf(Math.max(...diff))]
  ];
}

});
