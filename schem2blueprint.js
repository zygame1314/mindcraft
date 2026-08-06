#!/usr/bin/env node
// schem2blueprint.js
// 把根目录下的 Minecraft 蓝图文件（.schem / .schematic / .litematic / .nbt）
// 自动转换成 mindcraft 社区蓝图格式（{ name, offset, blocks:[y][z][x] }），
// 并写入 src/agent/npc/construction/<文件名>.json，随后 !buildStructure 即可直接用。
//
// 用法：
//   node schem2blueprint.js              # 转换根目录下所有支持的蓝图
//   node schem2blueprint.js a.schem      # 只转指定文件
//   node schem2blueprint.js --mc 1.20.4  # 指定 MC 版本（默认 1.20.4，影响方块 ID 映射）
//   node schem2blueprint.js --dry-run    # 只打印不写文件
//   node schem2blueprint.js --offset -1  # 覆盖 offset（地面下层数，默认 0）
//   node schem2blueprint.js house.schem --name 小木屋  # 指定中文蓝图名（只对单文件生效）
//
// 蓝图名支持中文：转换后用 !buildStructure 小木屋 即可搭建。注意 --name 仅在
// 只转一个文件时生效（批量转换时忽略，用文件名本身当蓝图名）。
//
// 支持格式：
//   .schem       Sponge / WorldEdit 2.x（NBT，含 BlockData 调色板+位打包体积）
//   .schematic   WorldEdit 1.x（NBT，含 Blocks/Add/BlockEntities 字节数组，方块 ID 制）
//   .litematic   Litematica（NBT，含 Regions，每区 BlockStatePalette + packed long 数组）
//   .nbt         结构方块（NBT，含 block_palette + 各 pos 的 state index）
//
// 方块名映射：用 prismarine-registry(<version>) 把 stateId/blockId 解析成
// "oak_planks" 这种 mindcraft 识别的方块名。无法识别的方块记成 "air" 并在
// 末尾打印警告，不静默吞掉——让你知道哪些方块版本不兼容。
//
// 依赖：prismarine-nbt / prismarine-registry / prismarine-block（均为
// mineflayer 体系的传递依赖，无需额外 npm install）。

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename, extname, resolve } from 'path';
import { gunzipSync } from 'zlib';
import nbt from 'prismarine-nbt';
import registry from 'prismarine-registry';

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'src', 'agent', 'npc', 'construction');

// --- 参数解析 ---
let mcVersion = '1.20.4';
let dryRun = false;
let offsetOverride = null;
let nameOverride = null; // --name：覆盖输出蓝图名（支持中文），文件名仍用此名
const explicitFiles = [];
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--mc') { mcVersion = process.argv[++i]; }
    else if (a === '--dry-run') { dryRun = true; }
    else if (a === '--offset') { offsetOverride = parseInt(process.argv[++i], 10); }
    else if (a === '--name') { nameOverride = process.argv[++i]; }
    else if (a === '--help' || a === '-h') { console.log(`用法见脚本顶部注释。`); process.exit(0); }
    else if (!a.startsWith('--')) { explicitFiles.push(a); }
}

const SUPPORTED = ['.schem', '.schematic', '.litematic', '.nbt'];
const reg = registry(mcVersion);

// 建 stateId -> name 反查表。registry 的 blocksByName[<name>] 给 minStateId/maxStateId，
// 每个状态 id 都对应同一个 name（属性差异不关心，搭出来默认朝向就行）。
const stateIdToName = new Map();
for (const name in reg.blocksByName) {
    const b = reg.blocksByName[name];
    if (!b || b.minStateId == null) continue;
    for (let sid = b.minStateId; sid <= b.maxStateId; sid++) stateIdToName.set(sid, name);
}
// 旧版 blockId（.schematic）-> name
const blockIdToName = new Map();
for (const name in reg.blocksByName) {
    const b = reg.blocksByName[name];
    if (b && b.id != null) blockIdToName.set(b.id, name);
}

const unknownBlocks = new Set();

// --- NBT 读取（支持 gzip 压缩与裸 NBT） ---
async function readNBT(buf) {
    // prismarine-nbt.parse 能自动识别 gzip（它内部判 magic bytes）
    try {
        const { parsed } = await nbt.parse(buf, 'big');
        return nbt.simplify(parsed);
    } catch (e) {
        // parse 有时对未压缩的小端 NBT 判不准，再试 little
        const { parsed } = await nbt.parse(buf, 'little');
        return nbt.simplify(parsed);
    }
}

function isGzip(buf) {
    return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

// 位打包读取：从 packed long 数组里取 index 处的 `bitsPerEntry` 位值。
// Litematica / Sponge 都用这种 "bit array in long[]" 布局，每 long 装 64 位，
// 跨 long 边界时高低位拼接（Java 风格 little-endian within long）。
function readBitArray(longArr, index, bitsPerEntry) {
    // longArr: number[]（JS number，可能丢精度，故优先用 BigInt 路径）
    const longsPerEntry = Math.ceil(64 / bitsPerEntry); // 通常 1
    const bitIndex = index * bitsPerEntry;
    let firstLong, bitOffset;
    let result = 0n;
    // 用 BigInt 版本避免大 long 精度丢失
    const bigArr = longArr.map(x => BigInt(x));
    for (let i = 0; i < longsPerEntry; i++) {
        const startBit = bitIndex + i * 64;
        const longIdx = Math.floor(startBit / 64);
        const bitInLong = startBit % 64;
        let lv = bigArr[longIdx] ?? 0n;
        // Java long 是有符号的，转成无符号 64 位
        if (lv < 0n) lv = lv + (1n << 64n);
        // 取该 long 里需要的位段
        const bitsAvail = 64 - bitInLong;
        const take = Math.min(bitsPerEntry - i * 64, bitsAvail);
        const mask = (1n << BigInt(take)) - 1n;
        const chunk = (lv >> BigInt(bitInLong)) & mask;
        result |= chunk << BigInt(i * 64);
    }
    return Number(result & ((1n << BigInt(bitsPerEntry)) - 1n));
}

// 读取 packed long 数组的一个 entry（Sponge/Litematica 通用：位在 long 内低对齐，
// 跨 long 时高位续）。这是更稳的纯 BigInt 实现。
function readPackedBits(longArr, index, bitsPerEntry) {
    if (bitsPerEntry === 0) return 0;
    const bitIndex = BigInt(index) * BigInt(bitsPerEntry);
    const longIndex = Number(bitIndex >> 6n);
    const bitOffset = Number(bitIndex & 63n);
    let lv = longArr[longIndex];
    if (lv == null) return 0;
    lv = BigInt(lv);
    if (lv < 0n) lv += (1n << 64n);
    let value = lv >> BigInt(bitOffset);
    // 跨 long 边界
    if (bitOffset + bitsPerEntry > 64) {
        let lv2 = longArr[longIndex + 1];
        if (lv2 != null) {
            lv2 = BigInt(lv2);
            if (lv2 < 0n) lv2 += (1n << 64n);
            value |= (lv2 << BigInt(64 - bitOffset));
        }
    }
    const mask = (1n << BigInt(bitsPerEntry)) - 1n;
    return Number(value & mask);
}

function stateIdToBlockName(sid) {
    if (sid == null) return 'air';
    const n = stateIdToName.get(sid);
    if (n) return n;
    unknownBlocks.add(`stateId:${sid}`);
    return 'air';
}

function blockIdToBlockName(bid) {
    if (bid == null) return 'air';
    const n = blockIdToName.get(bid);
    if (n) return n;
    unknownBlocks.add(`blockId:${bid}`);
    return 'air';
}

// 把方块名规整成 mindcraft 友好形式：去掉 minecraft: 前缀；少数重命名。
function normalizeName(raw) {
    if (!raw || raw === 'minecraft:air' || raw === 'air') return 'air';
    let name = raw.replace(/^minecraft:/, '');
    // mindcraft 蓝图用 generic 名（planks/log/door/bed/torch）让 placeBlock 按背包解析。
    // 但转换来的蓝图用具体名更稳妥（搭出来就是设计者选的那种木）。保持具体名。
    return name;
}

// --- 各格式解析器，统一返回 { width, height, length, blocks:[y][z][x]=name, offset } ---

// Sponge .schem (WorldEdit 2.x)：NBT 结构
//   Width/Height/Length (short), Palette (map: name->id), BlockData (byteArray, varint 编码),
//   DataVersion (int). 坐标序：x 沿 Width, y 沿 Height, z 沿 Length，索引 = x + z*Width + y*Width*Length
//   BlockData 是 varint[]（每个条目一个变长整数），不是定宽位打包！
//   参见 Sponge 规范 varint[] 与 baritone 实现的 VarInt.read。
function parseSchem(doc) {
    const w = doc.Width, h = doc.Height, l = doc.Length;
    const palette = doc.Palette; // { name: id }
    const data = doc.BlockData;  // byteArray
    if (w == null || h == null || l == null || !palette || !data) {
        throw new Error('.schem 缺少必要字段（Width/Height/Length/Palette/BlockData）');
    }
    // 反转 palette: id -> name
    const idToName = {};
    for (const name in palette) idToName[palette[name]] = normalizeName(name);
    const buf = Buffer.from(data);
    // varint 解码：每条目是一个 Protobuf 式 varint（低 7 位 payload，高位 continuation）。
    const total = w * h * l;
    const blockData = new Array(total);
    let offset = 0;
    for (let i = 0; i < total; i++) {
        if (offset >= buf.length) throw new Error(`.schem BlockData 在第 ${i} 格提前结束`);
        let val = 0, shift = 0, b;
        do {
            b = buf[offset++];
            val |= (b & 0x7f) << shift;
            shift += 7;
        } while ((b & 0x80) !== 0 && shift < 35);
        blockData[i] = val;
    }
    const blocks = [];
    for (let y = 0; y < h; y++) {
        const layer = [];
        for (let z = 0; z < l; z++) {
            const row = [];
            for (let x = 0; x < w; x++) {
                const idx = x + z * w + y * w * l; // 规范：x + z*Width + y*Width*Length
                const pid = blockData[idx];
                row.push(idToName[pid] ?? 'air');
            }
            layer.push(row);
        }
        blocks.push(layer);
    }
    return { width: w, height: h, length: l, blocks, offset: 0 };
}

// .schematic (WorldEdit 1.x / MCEdit)：NBT
//   Width/Height/Length (short), Blocks (byteArray, blockId), Add (byteArray, 高位, 可选),
//   Data (byteArray, 元数据). 坐标序同 Sponge: (y*length+z)*width+x
//   blockId 12+ 的高位在 Add 数组里（每格 1 byte）。
function parseSchematic(doc) {
    const w = doc.Width, h = doc.Height, l = doc.Length;
    const blocksArr = doc.Blocks;
    if (w == null || h == null || l == null || !blocksArr) {
        throw new Error('.schematic 缺少 Width/Height/Length/Blocks');
    }
    const addArr = doc.Add; // 可选
    const buf = Buffer.from(blocksArr);
    const addBuf = addArr ? Buffer.from(addArr) : null;
    const blocks = [];
    for (let y = 0; y < h; y++) {
        const layer = [];
        for (let z = 0; z < l; z++) {
            const row = [];
            for (let x = 0; x < w; x++) {
                const idx = (y * l + z) * w + x;
                let bid = buf[idx] & 0xff;
                if (addBuf) bid |= (addBuf[idx] & 0xff) << 8;
                row.push(normalizeName(blockIdToBlockName(bid)));
            }
            layer.push(row);
        }
        blocks.push(layer);
    }
    return { width: w, height: h, length: l, blocks, offset: 0 };
}

// .litematic (Litematica)：NBT
//   Regions: { <name>: { Width/Height/Length (int), BlockStatePalette (list of {Name,Properties}),
//                        BlockStates (longArray, packed), Position (int[3]) } }
//   取第一个 region。坐标序：x 沿 Width, y 沿 Height, z 沿 Length；
//   index = (y * length + z) * width + x，packed 读取按 readPackedBits。
//   bitsPerEntry = max(2, ceil(log2(palette.length)))。
function parseLitematic(doc) {
    const regions = doc.Regions;
    if (!regions) throw new Error('.litematic 缺少 Regions');
    const regionNames = Object.keys(regions);
    if (regionNames.length === 0) throw new Error('.litematic 的 Regions 为空');
    const r = regions[regionNames[0]];
    const w = r.Width, h = r.Height, l = r.Length;
    const palette = r.BlockStatePalette; // [{ Name, Properties }]
    const states = r.BlockStates;        // longArray
    if (w == null || h == null || l == null || !palette || !states) {
        throw new Error('.litematic region 缺少 Width/Height/Length/BlockStatePalette/BlockStates');
    }
    const paletteNames = palette.map(p => normalizeName(p.Name));
    const bitsPerEntry = Math.max(2, Math.ceil(Math.log2(palette.length)));
    const blocks = [];
    for (let y = 0; y < h; y++) {
        const layer = [];
        for (let z = 0; z < l; z++) {
            const row = [];
            for (let x = 0; x < w; x++) {
                const idx = (y * l + z) * w + x;
                const pid = readPackedBits(states, idx, bitsPerEntry);
                row.push(paletteNames[pid] ?? 'air');
            }
            layer.push(row);
        }
        blocks.push(layer);
    }
    return { width: w, height: h, length: l, blocks, offset: 0 };
}

// .nbt (结构方块)：NBT
//   size: [x,y,z], palette: [{Name, Properties}], blocks: [{pos:[x,y,z], state:int}]
//   pos 是相对结构原点的 0 基坐标；缺省的格子是 air。
function parseStructureNBT(doc) {
    const size = doc.size; // [x,y,z]
    const palette = doc.palette; // [{Name, Properties}]
    const blocksList = doc.blocks; // [{pos, state}]
    if (!size || !palette) throw new Error('.nbt 缺少 size/palette');
    const w = size[0], h = size[1], l = size[2];
    const paletteNames = palette.map(p => normalizeName(p.Name));
    // 初始化全 air 三维数组 [y][z][x]
    const blocks = [];
    for (let y = 0; y < h; y++) {
        const layer = [];
        for (let z = 0; z < l; z++) {
            const row = new Array(w).fill('air');
            layer.push(row);
        }
        blocks.push(layer);
    }
    for (const b of (blocksList || [])) {
        const [x, y, z] = b.pos;
        const pid = b.state;
        if (y >= 0 && y < h && z >= 0 && z < l && x >= 0 && x < w) {
            blocks[y][z][x] = paletteNames[pid] ?? 'air';
        }
    }
    return { width: w, height: h, length: l, blocks, offset: 0 };
}

// --- 自动找最底层非空、底下全是空 -> 抬升 offset，让 bot 站地面层 ---
// 蓝图里 blocks[0] 若全是 air/空，buildStructure 会把它当地面下层白白放 air。
// 实际很多 schematic 第 0 层是地基。这里不做自动抬升，保留 offset=0，让用户用
// --offset 覆盖。communityBlueprintToLevels 会把 blocks[offset] 当地面第一层。
function trimEmptyTopLayers(parsed) {
    // 去掉顶部连续全 air 层（很多人导出时带了 1-2 层空气顶）
    let topNonAir = parsed.blocks.length;
    while (topNonAir > 1) {
        const layer = parsed.blocks[topNonAir - 1];
        const allAir = layer.every(row => row.every(c => c === 'air' || c === '' || c == null));
        if (allAir) topNonAir--;
        else break;
    }
    if (topNonAir < parsed.blocks.length) {
        parsed.blocks = parsed.blocks.slice(0, topNonAir);
        parsed.height = topNonAir;
    }
}

// 统计非 air 方块，用于报告
function countSolid(parsed) {
    let n = 0;
    for (const layer of parsed.blocks)
        for (const row of layer)
            for (const c of row)
                if (c !== 'air' && c !== '' && c != null) n++;
    return n;
}

// 方块频次表（让用户知道要备多少料）
function blockFrequency(parsed) {
    const m = {};
    for (const layer of parsed.blocks)
        for (const row of layer)
            for (const c of row) {
                if (c === 'air' || c === '' || c == null) continue;
                m[c] = (m[c] || 0) + 1;
            }
    return m;
}

async function convertFile(filePath) {
    const ext = extname(filePath).toLowerCase();
    if (!SUPPORTED.includes(ext)) return null;
    const fileBase = basename(filePath, ext);
    // --name 覆盖：允许中文蓝图名。只对单个文件生效（多文件时忽略）。
    const baseName = nameOverride || fileBase;
    let raw = readFileSync(filePath);
    if (isGzip(raw)) raw = gunzipSync(raw);
    const doc = await readNBT(raw);
    let parsed;
    if (ext === '.schem') parsed = parseSchem(doc);
    else if (ext === '.schematic') parsed = parseSchematic(doc);
    else if (ext === '.litematic') parsed = parseLitematic(doc);
    else parsed = parseStructureNBT(doc);
    trimEmptyTopLayers(parsed);
    const offset = offsetOverride != null ? offsetOverride : 0;
    const out = {
        name: baseName,
        offset,
        blocks: parsed.blocks,
    };
    return { out, parsed, baseName };
}

async function main() {
    const files = explicitFiles.length
        ? explicitFiles.map(f => resolve(ROOT, f))
        : readdirSync(ROOT)
            .filter(f => SUPPORTED.includes(extname(f).toLowerCase()))
            .map(f => join(ROOT, f));
    if (files.length === 0) {
        console.log(`根目录下没有可转换的蓝图（${SUPPORTED.join('/')}）。`);
        console.log(`把蓝图文件放进项目根目录：${ROOT}`);
        return;
    }
    console.log(`MC 版本：${mcVersion}，找到 ${files.length} 个蓝图文件。`);
    if (!existsSync(OUT_DIR)) {
        console.error(`输出目录不存在：${OUT_DIR}`);
        process.exit(1);
    }
    let okCount = 0;
    for (const f of files) {
        try {
            const r = await convertFile(f);
            if (!r) continue;
            const { out, parsed, baseName } = r;
            const solid = countSolid(parsed);
            const freq = blockFrequency(parsed);
            const outPath = join(OUT_DIR, baseName + '.json');
            const summary = `${parsed.width}x${parsed.length}x${parsed.height}（宽x长x高），${solid} 个实体方块`;
            console.log(`\n✓ ${basename(f)} -> ${baseName}.json`);
            console.log(`  尺寸 ${summary}`);
            console.log(`  offset=${out.offset}`);
            console.log(`  材料清单：`);
            const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
            for (const [name, cnt] of sorted) console.log(`    ${name}: ${cnt}`);
            if (!dryRun) {
                writeFileSync(outPath, JSON.stringify(out, null, 2));
                console.log(`  已写入 ${outPath}`);
                console.log(`  现在可以用 !buildStructure ${baseName} 搭建。`);
            } else {
                console.log(`  (dry-run，未写文件)`);
            }
            okCount++;
        } catch (e) {
            console.error(`\n✗ ${basename(f)} 转换失败：${e.message}`);
            console.error(`  ${e.stack?.split('\n')[1] || ''}`);
        }
    }
    if (unknownBlocks.size > 0) {
        console.log(`\n⚠ 无法识别的方块（已记为 air）：`);
        for (const u of unknownBlocks) console.log(`  ${u}`);
        console.log(`  可能是 MC 版本不匹配，试试 --mc <版本>。`);
    }
    console.log(`\n完成：成功 ${okCount}/${files.length}。`);
}

main().catch(e => { console.error('致命错误：', e); process.exit(1); });