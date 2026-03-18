let video = document.getElementById("video");
let canvas = document.getElementById("canvas");
let resultCanvas = document.getElementById("result");
let ctx = canvas.getContext("2d");

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
}

function capture() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0);

  processImage(canvas);
}

// 업로드 처리
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

// 📄 스캔 처리 (OpenCV)
function processImage(canvas) {
  let src = cv.imread(canvas);
  let gray = new cv.Mat();
  let edged = new cv.Mat();

  // grayscale
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  // blur
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

  // edge detection
  cv.Canny(gray, edged, 75, 200);

  // contours
  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  cv.findContours(edged, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  let maxArea = 0;
  let biggest = null;

  for (let i = 0; i < contours.size(); i++) {
    let cnt = contours.get(i);
    let area = cv.contourArea(cnt);
    if (area > maxArea) {
      maxArea = area;
      biggest = cnt;
    }
  }

  if (biggest) {
    let rect = cv.boundingRect(biggest);

    let cropped = src.roi(rect);

    // threshold (스캔 느낌)
    let final = new cv.Mat();
    cv.cvtColor(cropped, final, cv.COLOR_RGBA2GRAY);
    cv.adaptiveThreshold(final, final, 255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY, 11, 2);

    cv.imshow(resultCanvas, final);

    final.delete();
    cropped.delete();
  }

  src.delete(); gray.delete(); edged.delete();
  contours.delete(); hierarchy.delete();
}

// 다운로드
function download() {
  let link = document.createElement('a');
  link.download = 'scan.png';
  link.href = resultCanvas.toDataURL();
  link.click();
}
