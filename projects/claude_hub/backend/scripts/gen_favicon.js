#!/usr/bin/env node
/**
 * 生成 Clootee 图标的位图版本（favicon.ico / apple-touch-icon.png / icon-192|512.png）。
 * 矢量源是 frontend/favicon.svg；这里用纯 Node 手工光栅化（4x4 超采样）+ 手写 PNG/ICO 编码，
 * 不引任何依赖，Windows / Linux 都能跑。改了 favicon.svg 就把这里的常量同步一下再跑：
 *   node backend/scripts/gen_favicon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', '..', 'frontend');

// ——— 设计常量（对应 favicon.svg 的 64x64 坐标系）———
const S = 64;
const RADIUS_BG = 14;          // 圆角方块
const C = 32;                  // 圆心
const R_RING = 16;             // C 环半径
const W_RING = 10;             // C 环线宽
const GAP_DEG = 40;            // 缺口半角（右侧）
const CUR = 4.4;               // 中心光标方块半边长
const CUR_R = 2.7;             // 光标圆角
const C1 = [0x5b, 0x8c, 0xff]; // 渐变起点 #5b8cff
const C2 = [0x8b, 0x5c, 0xf6]; // 渐变终点 #8b5cf6
const SS = 4;                  // 每像素超采样边数

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// 圆角矩形 SDF（<=0 在内部），box 半边长 h，圆角 r
function sdRoundRect(x, y, h, r) {
  const qx = Math.abs(x) - (h - r);
  const qy = Math.abs(y) - (h - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// 带圆头的圆弧 SDF：缺口开在右侧（角度 ±GAP_DEG 之间为空）
function sdArc(x, y) {
  const dx = x - C, dy = y - C;
  const ang = Math.abs(Math.atan2(dy, dx)) * 180 / Math.PI; // 0=右, 180=左
  if (ang >= GAP_DEG) return Math.abs(Math.hypot(dx, dy) - R_RING) - W_RING / 2;
  // 落在缺口扇区：量到两个圆头端点的距离
  const a = GAP_DEG * Math.PI / 180;
  const ex = C + R_RING * Math.cos(a);
  const eyUp = C - R_RING * Math.sin(a);
  const eyDn = C + R_RING * Math.sin(a);
  const d = Math.min(Math.hypot(x - ex, y - eyUp), Math.hypot(x - ex, y - eyDn));
  return d - W_RING / 2;
}

function renderRGBA(size) {
  const buf = Buffer.alloc(size * size * 4);
  const scale = S / size;      // 像素 -> 设计坐标
  const step = scale / SS;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let covBg = 0, covFg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) * step;
          const y = (py * SS + sy + 0.5) * step;
          if (sdRoundRect(x - C, y - C, S / 2, RADIUS_BG) <= 0) covBg++;
          const fg = Math.min(sdArc(x, y), sdRoundRect(x - C, y - C, CUR, CUR_R));
          if (fg <= 0) covFg++;
        }
      }
      const n = SS * SS;
      const aBg = covBg / n, aFg = covFg / n;
      // 渐变按对角线插值
      const t = clamp01(((px + 0.5) / size + (py + 0.5) / size) / 2);
      const bg = [0, 1, 2].map((i) => C1[i] + (C2[i] - C1[i]) * t);
      // 白色前景合成到渐变底上，整体再乘背景 alpha
      const rgb = [0, 1, 2].map((i) => Math.round(bg[i] * (1 - aFg) + 255 * aFg));
      const o = (py * size + px) * 4;
      buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2];
      buf[o + 3] = Math.round(aBg * 255);
    }
  }
  return buf;
}

// ——— 最小 PNG 编码器 ———
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ——— ICO 容器（内嵌 PNG，Vista+ / 所有现代浏览器都认）———
function encodeICO(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = [];
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size;
    d[1] = e.size >= 256 ? 0 : e.size;
    d[2] = 0; d[3] = 0;
    d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6);
    d.writeUInt32BE(0, 8); d.writeUInt32LE(e.png.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.png.length;
    dir.push(d);
  }
  return Buffer.concat([head, ...dir, ...entries.map((e) => e.png)]);
}

const png = (size) => encodePNG(renderRGBA(size), size);
const icoSizes = [16, 32, 48];
const ico = encodeICO(icoSizes.map((size) => ({ size, png: png(size) })));
fs.writeFileSync(path.join(OUT_DIR, 'favicon.ico'), ico);
const files = [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]];
for (const [name, size] of files) fs.writeFileSync(path.join(OUT_DIR, name), png(size));
console.log('favicon.ico', ico.length, 'bytes (' + icoSizes.join('/') + ')');
for (const [name, size] of files) console.log(name, fs.statSync(path.join(OUT_DIR, name)).size, 'bytes', size + 'px');

module.exports = { renderRGBA, encodePNG };
