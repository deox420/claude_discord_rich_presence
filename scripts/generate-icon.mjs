// Genera un icono .ico 32x32 (círculo en color Claude) para la bandeja.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIZE = 32;
// Color Claude (coral/terracota) en BGRA
const B = 0x57,
  G = 0x77,
  R = 0xd9;

const xor = Buffer.alloc(SIZE * SIZE * 4);
const cx = (SIZE - 1) / 2;
const cy = (SIZE - 1) / 2;
const radius = SIZE / 2 - 1;

// Filas de abajo hacia arriba (bottom-up)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const srcY = SIZE - 1 - y;
    const dx = x - cx;
    const dy = srcY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const off = (y * SIZE + x) * 4;
    if (dist <= radius) {
      // antialias suave en el borde
      const edge = radius - dist;
      const a = edge >= 1 ? 255 : Math.round(Math.max(0, edge) * 255);
      xor[off] = B;
      xor[off + 1] = G;
      xor[off + 2] = R;
      xor[off + 3] = a;
    } else {
      xor[off] = 0;
      xor[off + 1] = 0;
      xor[off + 2] = 0;
      xor[off + 3] = 0;
    }
  }
}

const andMask = Buffer.alloc(SIZE * 4, 0); // 32 filas * 4 bytes, todo opaco

const header = Buffer.alloc(40);
header.writeUInt32LE(40, 0); // biSize
header.writeInt32LE(SIZE, 4); // biWidth
header.writeInt32LE(SIZE * 2, 8); // biHeight (XOR + AND)
header.writeUInt16LE(1, 12); // biPlanes
header.writeUInt16LE(32, 14); // biBitCount
// resto 0

const dib = Buffer.concat([header, xor, andMask]);

const icondir = Buffer.alloc(6);
icondir.writeUInt16LE(0, 0); // reserved
icondir.writeUInt16LE(1, 2); // type icon
icondir.writeUInt16LE(1, 4); // count

const entry = Buffer.alloc(16);
entry.writeUInt8(SIZE, 0); // width
entry.writeUInt8(SIZE, 1); // height
entry.writeUInt8(0, 2); // colors
entry.writeUInt8(0, 3); // reserved
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bitCount
entry.writeUInt32LE(dib.length, 8); // bytesInRes
entry.writeUInt32LE(6 + 16, 12); // offset

const ico = Buffer.concat([icondir, entry, dib]);

const outDir = join(__dirname, "..", "assets");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "tray-icon.ico");
writeFileSync(out, ico);
console.log(`Icono generado: ${out} (${ico.length} bytes)`);
