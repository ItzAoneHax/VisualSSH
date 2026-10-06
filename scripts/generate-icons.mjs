/**
 * 生成 VisualSSH 应用图标（无第三方依赖）。
 * 输出：src-tauri/icons/{32x32.png,128x128.png,128x128@2x.png,icon.ico}
 * 图形语言与 favicon.svg 一致：azure→periwinkle 渐变圆角方块 + 白色 ❯ 折角箭头。
 *
 * 用法：node scripts/generate-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "icons");

// ---- 像素渲染 ----

const GRAD_FROM = [91, 140, 255]; // #5B8CFF
const GRAD_TO = [155, 139, 255]; // #9B8BFF

/** 点到线段 AB 的距离 */
function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1)),
  );
  const dx = px - (ax + t * abx);
  const dy = py - (ay + t * aby);
  return Math.hypot(dx, dy);
}

/** 渲染一张 size×size 的 RGBA 位图 */
function render(size) {
  const px = new Uint8Array(size * size * 4);
  const r = size * 0.225; // 圆角半径
  const feather = Math.max(1, size / 128); // 抗锯齿羽化
  const strokeW = size * 0.048;

  // ❯ 折角箭头的两条笔画（相对坐标）
  const segs = [
    [0.37, 0.305, 0.625, 0.5],
    [0.625, 0.5, 0.37, 0.695],
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;

      // 圆角方形 SDF → alpha
      const qx = Math.abs(cx - size / 2) - (size / 2 - r);
      const qy = Math.abs(cy - size / 2) - (size / 2 - r);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      const bgAlpha = Math.max(0, Math.min(1, 0.5 - d / feather));

      // 渐变底色
      const t = (cx + cy) / (2 * size);
      const cr = Math.round(GRAD_FROM[0] + (GRAD_TO[0] - GRAD_FROM[0]) * t);
      const cg = Math.round(GRAD_FROM[1] + (GRAD_TO[1] - GRAD_FROM[1]) * t);
      const cb = Math.round(GRAD_FROM[2] + (GRAD_TO[2] - GRAD_FROM[2]) * t);

      // 箭头笔画覆盖
      let dArrow = Infinity;
      for (const [ax, ay, bx, by] of segs) {
        dArrow = Math.min(
          dArrow,
          distToSegment(cx, cy, ax * size, ay * size, bx * size, by * size),
      );
      }
      const arrowAlpha = Math.max(0, Math.min(1, (strokeW - dArrow) / feather + 0.5));

      // 白色笔画合成到渐变底上
      const rr = Math.round(cr + (255 - cr) * arrowAlpha);
      const g2 = Math.round(cg + (255 - cg) * arrowAlpha);
      const b2 = Math.round(cb + (255 - cb) * arrowAlpha);
      const a2 = Math.max(bgAlpha, arrowAlpha * bgAlpha);

      const i = (y * size + x) * 4;
      px[i] = rr;
      px[i + 1] = g2;
      px[i + 2] = b2;
      px[i + 3] = Math.round(a2 * 255);
    }
  }
  return px;
}

// ---- PNG 编码 ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  // 每行前置 1 字节过滤器类型 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw.set(Buffer.from(rgba.buffer, y * size * 4, size * 4), y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- ICO 编码（32bpp BMP，兼容资源编译器）----

function encodeIcoBmp(rgba, size) {
  const rowBits = ((size + 31) >> 5) << 5; // AND 掩码行按 32 位对齐
  const xorSize = size * size * 4;
  const andSize = rowBits * size / 8;
  const bmp = Buffer.alloc(40 + xorSize + andSize);

  const h = (value, offset) => bmp.writeUInt32LE(value, offset);
  h(40, 0); // BITMAPINFOHEADER
  h(size, 4);
  h(size * 2, 8); // 高度 = XOR + AND 两倍
  bmp.writeUInt16LE(1, 12);
  bmp.writeUInt16LE(32, 14);

  // 像素自底向上、BGRA
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4;
      const dst = 40 + (y * size + x) * 4;
      bmp[dst] = rgba[src + 2];
      bmp[dst + 1] = rgba[src + 1];
      bmp[dst + 2] = rgba[src];
      bmp[dst + 3] = rgba[src + 3];
    }
  }
  // AND 掩码全 0（透明度由 alpha 通道负责），已由 Buffer.alloc 置零

  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 图像类型：图标
  header.writeUInt16LE(1, 4); // 图像数量
  header[6] = size >= 256 ? 0 : size;
  header[7] = size >= 256 ? 0 : size;
  header.writeUInt16LE(1, 8); // 调色板
  header.writeUInt16LE(32, 10); // bpp
  header.writeUInt32LE(bmp.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, bmp]);
}

// ---- 输出 ----

mkdirSync(outDir, { recursive: true });
for (const [size, file] of [
  [32, "32x32.png"],
  [128, "128x128.png"],
  [256, "128x128@2x.png"],
]) {
  writeFileSync(join(outDir, file), encodePng(render(size), size));
  console.log(`✓ ${file} (${size}×${size})`);
}
writeFileSync(join(outDir, "icon.ico"), encodeIcoBmp(render(32), 32));
console.log("✓ icon.ico (32×32, 32bpp BMP)");
