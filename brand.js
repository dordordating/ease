const colors = {
  violet: ["#c1a4ff", "#9a73f1", "#6441ce"],
  blue: ["#9ecbff", "#518de0", "#1e54a9"],
  mint: ["#93e5c9", "#38ae91", "#16775e"],
  amber: ["#ffe3a6", "#d99a43", "#a55917"]
};

export function paintBrand(canvas, palette) {
  const context = canvas.getContext("2d");
  context.scale(canvas.width / 128, canvas.height / 128);
  const gradient = context.createLinearGradient(11, 8, 115, 127);
  (colors[palette] ?? colors.violet).forEach((color, index) => gradient.addColorStop(index / 2, color));
  context.beginPath();
  context.roundRect(4, 4, 120, 120, 30);
  context.fillStyle = gradient;
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = "#ffffff50";
  context.stroke();
  const bolt = new Path2D("M92 39H57L39 63h36L56 88H36");
  context.lineWidth = 11;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.save();
  context.translate(0, 3);
  context.strokeStyle = "#16233e55";
  context.stroke(bolt);
  context.restore();
  context.strokeStyle = "#fff";
  context.stroke(bolt);
  return context;
}

export async function setToolbarBrand(palette) {
  const imageData = Object.fromEntries([16, 32].map((size) => {
    const canvas = new OffscreenCanvas(size, size);
    return [size, paintBrand(canvas, palette).getImageData(0, 0, size, size)];
  }));
  await chrome.action.setIcon({ imageData });
}
