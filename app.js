let video = document.getElementById("video");
let canvas = document.getElementById("canvas");
let resultCanvas = document.getElementById("result");
let ctx = canvas.getContext("2d");

// 📸 카메라 시작
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
}

// 📸 촬영
function capture() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0);

  processImage(canvas);
}

// 📁 업로드 처리
document.getElementById("upload").addEventListener("change", function(e) {
  const file = e.target.files[0];
  const img = new Image();

  img.onload = function() {
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    processImage(canvas);
  };

  img.src = URL.createObjectURL(file);
});

// 📄 핵심 스캔 함수
function processImage(canvas) {
  let src = cv.imread(canvas);
  let gray = new cv.Mat();
  let edged = new cv.Mat();

  // 1. 전처리
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
  cv.Canny(gray, edged, 50, 150);

  // 2. contour 찾기
  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  cv.findContours(edged, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let biggest = null;
  let maxArea = 0;

  for (let i = 0; i < contours.size(); i++) {
    let cnt = contours.get(i);
    let area = cv.contourArea(cnt);

    if (area < 5000) continue;

    let peri = cv.arcLength(cnt, true);
    let approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

    if (approx.rows === 4 && area > maxArea) {
      biggest = approx;
      maxArea = area;
    }
  }

  if (!biggest) {
    console.log("문서 감지 실패");
    cv.imshow(resultCanvas, src);
    cleanup();
    return;
  }

  // 3. 좌표 추출
  let pts = [];
  for (let i = 0; i < 4; i++) {
    pts.push({
      x: biggest.intPtr(i, 0)[0],
      y: biggest.intPtr(i, 0)[1]
    });
  }

  pts = orderPoints(pts);

  // 4. 크기 계산
  let widthA = distance(pts[2], pts[3]);
  let widthB = distance(pts[1], pts[0]);
  let maxWidth = Math.max(widthA, widthB);

  let heightA = distance(pts[1], pts[2]);
  let heightB = distance(pts[0], pts[3]);
  let maxHeight = Math.max(heightA, heightB);

  // 5. perspective transform
  let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    pts[0].x, pts[0].y,
    pts[1].x, pts[1].y,
    pts[2].x, pts[2].y,
    pts[3].x, pts[3].y
  ]);

  let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    maxWidth, 0,
    maxWidth, maxHeight,
    0, maxHeight
  ]);

  let M = cv.getPerspectiveTransform(srcTri, dstTri);
  let warped = new cv.Mat();

  cv.warpPerspective(src, warped, M, new cv.Size(maxWidth, maxHeight));

  // 6. 이미지 보정 (노출/휘도/대비/블랙포인트 느낌)
  let adjusted = new cv.Mat();

  let alpha = 1.5; // 대비 (≈50%)
  let beta = 50;   // 밝기 (노출 + 휘도)

  warped.convertTo(adjusted, -1, alpha, beta);

  // 블랙포인트 느낌 (명암 확장)
  cv.normalize(adjusted, adjusted, 0, 255, cv.NORM_MINMAX);

  // 출력
  cv.imshow(resultCanvas, adjusted);

  // 메모리 정리
  src.delete(); gray.delete(); edged.delete();
  contours.delete(); hierarchy.delete();
  warped.delete(); adjusted.delete();
  srcTri.delete(); dstTri.delete(); M.delete();
}

// 📏 거리 계산
function distance(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

// 📐 꼭짓점 정렬
function orderPoints(pts) {
  let sum = pts.map(p => p.x + p.y);
  let diff = pts.map(p => p.x - p.y);

  let topLeft = pts[sum.indexOf(Math.min(...sum))];
  let bottomRight = pts[sum.indexOf(Math.max(...sum))];
  let topRight = pts[diff.indexOf(Math.min(...diff))];
  let bottomLeft = pts[diff.indexOf(Math.max(...diff))];

  return [topLeft, topRight, bottomRight, bottomLeft];
}

// 💾 다운로드
function download() {
  let link = document.createElement('a');
  link.download = 'scan.png';
  link.href = resultCanvas.toDataURL();
  link.click();
}
