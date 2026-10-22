type RgbaColor = [number, number, number, number];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode image"));
    image.src = dataUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to encode image"));
        return;
      }
      resolve(blob);
    }, mimeType);
  });
}

function averageCornerColor(data: Uint8ClampedArray, width: number, height: number): RgbaColor {
  const sampleSize = Math.max(2, Math.min(12, Math.floor(Math.min(width, height) / 10)));
  const points: Array<[number, number]> = [];

  for (let y = 0; y < sampleSize; y += 1) {
    for (let x = 0; x < sampleSize; x += 1) {
      points.push([x, y], [width - 1 - x, y], [x, height - 1 - y], [width - 1 - x, height - 1 - y]);
    }
  }

  const sums = [0, 0, 0, 0];
  for (const [x, y] of points) {
    const offset = (y * width + x) * 4;
    sums[0] += data[offset];
    sums[1] += data[offset + 1];
    sums[2] += data[offset + 2];
    sums[3] += data[offset + 3];
  }

  return [
    Math.round(sums[0] / points.length),
    Math.round(sums[1] / points.length),
    Math.round(sums[2] / points.length),
    Math.round(sums[3] / points.length),
  ];
}

function pixelMatchesColor(data: Uint8ClampedArray, offset: number, color: RgbaColor, tolerance: number): boolean {
  if (data[offset + 3] <= 8) return true;
  return Math.max(
    Math.abs(data[offset] - color[0]),
    Math.abs(data[offset + 1] - color[1]),
    Math.abs(data[offset + 2] - color[2]),
  ) <= tolerance;
}

function removeConnectedEdgeBackground(canvas: HTMLCanvasElement, tolerance: number, feather: number) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas is unavailable");

  const { width, height } = canvas;
  const imageData = context.getImageData(0, 0, width, height);
  const { data } = imageData;
  const color = averageCornerColor(data, width, height);
  const marked = new Uint8Array(width * height);
  const queue: number[] = [];

  const enqueue = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (marked[index]) return;
    const offset = index * 4;
    if (!pixelMatchesColor(data, offset, color, tolerance)) return;
    marked[index] = 1;
    queue.push(index);
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor];
    const x = index % width;
    const y = Math.floor(index / width);
    enqueue(x + 1, y);
    enqueue(x - 1, y);
    enqueue(x, y + 1);
    enqueue(x, y - 1);
  }

  for (let index = 0; index < marked.length; index += 1) {
    if (marked[index]) data[index * 4 + 3] = 0;
  }

  const featherRadius = Math.max(0, Math.min(4, Math.round(feather)));
  if (featherRadius > 0) {
    const featherTolerance = tolerance + featherRadius * 12;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (marked[index]) continue;

        let touchesBackground = false;
        for (let dy = -featherRadius; dy <= featherRadius && !touchesBackground; dy += 1) {
          for (let dx = -featherRadius; dx <= featherRadius; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            if (marked[ny * width + nx]) {
              touchesBackground = true;
              break;
            }
          }
        }

        if (!touchesBackground) continue;
        const offset = index * 4;
        const distance = Math.max(
          Math.abs(data[offset] - color[0]),
          Math.abs(data[offset + 1] - color[1]),
          Math.abs(data[offset + 2] - color[2]),
        );
        if (distance > featherTolerance) continue;
        const keepRatio = clamp((distance - tolerance) / Math.max(1, featherTolerance - tolerance), 0, 1);
        data[offset + 3] = Math.round(data[offset + 3] * keepRatio);
      }
    }
  }

  context.putImageData(imageData, 0, 0);
  return { color, removedPixels: queue.length };
}

export async function removeConnectedEdgeBackgroundFromDataUrl(
  dataUrl: string,
  options: { tolerance?: number; feather?: number } = {},
): Promise<{ blob: Blob; removedPixels: number; color: RgbaColor }> {
  if (typeof document === "undefined") {
    throw new Error("Canvas is unavailable");
  }

  const image = await loadImage(dataUrl);
  const width = Math.max(1, image.naturalWidth || image.width);
  const height = Math.max(1, image.naturalHeight || image.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas is unavailable");
  }

  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const removed = removeConnectedEdgeBackground(
    canvas,
    clamp(options.tolerance ?? 42, 0, 255),
    clamp(options.feather ?? 2, 0, 4),
  );
  const blob = await canvasToBlob(canvas, "image/png");

  return { blob, removedPixels: removed.removedPixels, color: removed.color };
}
