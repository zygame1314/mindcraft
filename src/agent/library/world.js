import pf from 'mineflayer-pathfinder';
import * as mc from '../../utils/mcdata.js';


export function getNearestFreeSpace(bot, size=1, distance=8) {
    /**
     * Get the nearest empty space with solid blocks beneath it of the given size.
     * @param {Bot} bot - The bot to get the nearest free space for.
     * @param {number} size - The (size x size) of the space to find, default 1.
     * @param {number} distance - The maximum distance to search, default 8.
     * @returns {Vec3} - The south west corner position of the nearest free space.
     * @example
     * let position = world.getNearestFreeSpace(bot, 1, 8);
     **/
    let empty_pos = bot.findBlocks({
        matching: (block) => {
            return block && block.name == 'air';
        },
        maxDistance: distance,
        count: 1000
    });
    for (let i = 0; i < empty_pos.length; i++) {
        let empty = true;
        for (let x = 0; x < size; x++) {
            for (let z = 0; z < size; z++) {
                let top = bot.blockAt(empty_pos[i].offset(x, 0, z));
                let bottom = bot.blockAt(empty_pos[i].offset(x, -1, z));
                if (!top || !top.name == 'air' || !bottom || bottom.drops.length == 0 || !bottom.diggable) {
                    empty = false;
                    break;
                }
            }
            if (!empty) break;
        }
        if (empty) {
            return empty_pos[i];
        }
    }
}


export function getBlockAtPosition(bot, x=0, y=0, z=0) {
     /**
     * Get a block from the bot's relative position 
     * @param {Bot} bot - The bot to get the block for.
     * @param {number} x - The relative x offset to serach, default 0.
     * @param {number} y - The relative y offset to serach, default 0.
     * @param {number} y - The relative z offset to serach, default 0. 
     * @returns {Block} - The nearest block.
     * @example
     * let blockBelow = world.getBlockAtPosition(bot, 0, -1, 0);
     * let blockAbove = world.getBlockAtPosition(bot, 0, 2, 0); since minecraft position is at the feet
     **/
    let block = bot.blockAt(bot.entity.position.offset(x, y, z));
    if (!block) block = {name: 'air'};
       
    return block;
}


export function getSurroundingBlocks(bot) {
    /**
     * Get the surrounding blocks from the bot's environment.
     * @param {Bot} bot - The bot to get the block for.
     * @returns {string[]} - A list of block results as strings.
     * @example
     **/
    // Create a list of block position results that can be unpacked.
    let res = [];
    res.push(`Block Below: ${getBlockAtPosition(bot, 0, -1, 0).name}`);
    res.push(`Block at Legs: ${getBlockAtPosition(bot, 0, 0, 0).name}`);
    res.push(`Block at Head: ${getBlockAtPosition(bot, 0, 1, 0).name}`);

    return res;
}


export function getFirstBlockAboveHead(bot, ignore_types=null, distance=32) {
     /**
     * Searches a column from the bot's position for the first solid block above its head
     * @param {Bot} bot - The bot to get the block for.
     * @param {string[]} ignore_types - The names of the blocks to ignore.
     * @param {number} distance - The maximum distance to search, default 32.
     * @returns {string} - The fist block above head.
     * @example
     * let firstBlockAboveHead = world.getFirstBlockAboveHead(bot, null, 32);
     **/
    // if ignore_types is not a list, make it a list.
    let ignore_blocks = []; 
    if (ignore_types === null) ignore_blocks = ['air', 'cave_air'];
    else {
        if (!Array.isArray(ignore_types))
            ignore_types = [ignore_types];
        for(let ignore_type of ignore_types) {
            if (mc.getBlockId(ignore_type)) ignore_blocks.push(ignore_type);
        }
    }
    // The block above, stops when it finds a solid block .
    let block_above = {name: 'air'};
    let height = 0
    for (let i = 0; i < distance; i++) {
        let block = bot.blockAt(bot.entity.position.offset(0, i+2, 0));
        if (!block) block = {name: 'air'};
        // Ignore and continue
        if (ignore_blocks.includes(block.name)) continue;
        // Defaults to any block
        block_above = block;
        height = i;
        break;
    }

    if (ignore_blocks.includes(block_above.name)) return 'none';
    
    return `${block_above.name} (${height} blocks up)`;
}


export function getRelativeDirection(bot, targetPos) {
    /**
     * 把目标位置相对 bot 解析成「相对坐标 + 世界方位 + 朝向方位」。
     * 世界方位按 MC 约定：+Z 南 / -Z 北 / +X 东 / -X 西 / +Y 上 / -Y 下。
     * 朝向方位依 bot.entity.yaw 计算（yaw=0 朝 +Z/南）：
     *   前=(-sin yaw, cos yaw)，右=(-cos yaw, -sin yaw)，再按主导轴归类。
     * @param {Bot} bot
     * @param {Vec3} targetPos
     * @returns {{dx:number, dy:number, dz:number, dist:number, worldDir:string, headingDir:string}}
     * @example
     * let r = world.getRelativeDirection(bot, block.position); // r.headingDir === '前'
     **/
    const bp = bot.entity.position;
    const dx = targetPos.x - bp.x;
    const dy = targetPos.y - bp.y;
    const dz = targetPos.z - bp.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);

    let worldDir = '此处';
    let headingDir = '此处';
    if (dist > 0.5) {
        // 世界方位：取绝对值最大的轴
        if (ay >= ax && ay >= az) worldDir = dy > 0 ? '上' : '下';
        else if (az >= ax) worldDir = dz > 0 ? '南' : '北';
        else worldDir = dx > 0 ? '东' : '西';

        // 朝向方位：垂直方向主导时直接判上/下，否则投影到 bot 的前/后/左/右
        if (ay > ax && ay > az) {
            headingDir = dy > 0 ? '上' : '下';
        } else {
            const yaw = bot.entity.yaw || 0;
            const fx = -Math.sin(yaw), fz = Math.cos(yaw);   // 前向
            const rx = -Math.cos(yaw), rz = -Math.sin(yaw); // 右向
            const fComp = dx * fx + dz * fz;
            const rComp = dx * rx + dz * rz;
            if (Math.abs(fComp) >= Math.abs(rComp)) headingDir = fComp > 0 ? '前' : '后';
            else headingDir = rComp > 0 ? '右' : '左';
        }
    }
    return { dx: Math.round(dx), dy: Math.round(dy), dz: Math.round(dz), dist, worldDir, headingDir };
}


// 判断 bot 是否处于"室内"。沿四个水平方向各逐格射线扫描，找第一块非空气方块
// 作为该方向的墙/边界，记录其位置/距离/方块；同时扫头顶第一块实体方块（顶/天花板）
// 和脚下方块（地板）。据此推断围合情况、估算房间大小、找门/缺口。
//
// 判定"墙"的标准：非 air/cave_air/水/熔岩/草/雪/叶 等可穿透/非实体方块。
// 这与玩家直觉一致——火柴盒的木板墙、石砖墙都算墙；露天田野的草不算墙，
// 这样露天时四向大概率扫不到墙（超出扫描上限仍是空气），不会误判成室内。
function _isWallLike(block) {
    if (!block) return false;
    const n = block.name;
    if (n === 'air' || n === 'cave_air') return false;
    if (n === 'water' || n === 'lava') return false;
    if (n === 'short_grass' || n === 'tall_grass' || n === 'fern') return false;
    if (n.endsWith('leaves')) return false;
    if (n === 'snow' || n === 'snow_block') return false;
    if (n.endsWith('vine') || n.endsWith('moss')) return false;
    return true;
}

function _isLiquid(block) {
    if (!block) return false;
    const n = block.name;
    return n === 'water' || n === 'lava' || n === 'flowing_water' || n === 'flowing_lava';
}

export function getEnclosure(bot, maxDist = 24) {
    /**
     * 判断 bot 是否处于"室内"（火柴盒/洞穴/房间），并返回四面墙、顶、底的位置与距离。
     * @param {Bot} bot
     * @param {number} maxDist - 每个方向最大扫描距离，默认 24。
     * @returns {{ enclosed:boolean, confidence:string, size:string, walls:Object, ceiling:Object|null, floor:Object, openings:Array }}
     *   walls 形如 { 北:{name, pos, rel, dist}, 南:..., 东:..., 西:... }
     *   openings: 缺墙的方向（出口/门候选）列表
     * @example
     * let e = world.getEnclosure(bot); // e.enclosed===true 表示在室内
     **/
    const bp = bot.entity.position;
    const feetY = Math.floor(bp.y);
    // 水平扫描在 bot 腿部高度(y=0)进行；头顶在 y=2 起向上扫；地板扫脚下方块
    const wallDirs = [
        { dir: '北', dx: 0, dz: -1 },
        { dir: '南', dx: 0, dz: 1 },
        { dir: '东', dx: 1, dz: 0 },
        { dir: '西', dx: -1, dz: 0 },
    ];

    const walls = {};
    let wallCount = 0;
    for (const d of wallDirs) {
        let found = null;
        for (let i = 1; i <= maxDist; i++) {
            const block = bot.blockAt(bp.offset(d.dx * i, 0, d.dz * i));
            if (_isWallLike(block)) {
                found = { name: block.name, pos: block.position, dist: i, r: null };
                break;
            }
        }
        walls[d.dir] = found;
        if (found) wallCount++;
    }

    // 顶：从头顶上方逐格向上找第一块实体方块
    let ceiling = null;
    for (let i = 2; i <= maxDist; i++) {
        const block = bot.blockAt(bp.offset(0, i, 0));
        if (_isWallLike(block)) {
            // dist=相对脚的距离；aboveHead=相对头顶的净空格数（i-2）。
            // 2格高房→aboveHead=0(头顶直接封顶)；3格高→1(头顶上方1格空气再封顶)。
            ceiling = { name: block.name, pos: block.position, dist: i, aboveHead: i - 2 };
            break;
        }
    }

    // 底：脚下方块（地板/地面）
    const floorBlock = bot.blockAt(bp.offset(0, -1, 0));
    const floor = floorBlock ? { name: floorBlock.name, pos: floorBlock.position, dist: 1 } : null;

    // 围合判定：至少 3 面墙 + 有顶 才算"室内"；4 面墙且墙都较近则高置信
    const openings = [];
    for (const d of wallDirs) {
        if (!walls[d.dir]) openings.push(d.dir);
    }

    let enclosed = false;
    let confidence = '无';
    if (wallCount >= 3 && ceiling) {
        enclosed = true;
        // 4 面墙 + 有顶 + 最近墙 <=8 → 高置信(完整火柴盒)；3 面(有门) → 中
        const minWallDist = Math.min(...wallDirs.map(d => walls[d.dir] ? walls[d.dir].dist : 99));
        if (wallCount === 4 && minWallDist <= 8) confidence = '高';
        else confidence = '中';
    } else if (wallCount >= 2 && ceiling) {
        // 墙不全（L 形/半开放），算"半围合"，不标室内但提示
        enclosed = false;
        confidence = '半围合';
    }

    // 估算尺寸：有缺墙方向时用另一侧距离近似，仍能给个跨度
    // 南北跨度 = 南墙dist + 北墙dist + 1（缺一侧时用另一侧代）
    const ns = walls['南'] ? walls['南'].dist : (walls['北'] ? walls['北'].dist : 0);
    const nn = walls['北'] ? walls['北'].dist : (walls['南'] ? walls['南'].dist : 0);
    const ne = walls['东'] ? walls['东'].dist : (walls['西'] ? walls['西'].dist : 0);
    const nw = walls['西'] ? walls['西'].dist : (walls['东'] ? walls['东'].dist : 0);
    let sizeStr = '未知';
    if (wallCount >= 2) {
        const xSpan = ne + nw + 1;
        const zSpan = ns + nn + 1;
        const ySpan = ceiling ? ceiling.dist + 1 : '?';
        sizeStr = `${xSpan}x${zSpan}x${ySpan}`;
    }

    return { enclosed, confidence, sizeStr, walls, ceiling, floor, openings };
}


export function scanDirection(bot, direction, maxDist = 64) {
    /**
     * 沿给定世界方向逐格射线扫描，返回依次遇到的方块序列。
     * 用于探测远处/高处的目标，弥补 !nearbyBlocks 8格半径的盲区，
     * 例如查"东边那根石柱多高"——选 direction='east' 能看到柱根到柱顶整列方块。
     * 空气/草/叶/雪等非实体方块被跳过，水/岩浆等液体单独记为[液体]段。
     * @param {Bot} bot
     * @param {string} direction - 世界方位：north/south/east/west/up/down（中文北南东西上下也可）。
     * @param {number} maxDist - 最大扫描距离，默认 64。
     * @returns {{ hits:Array, segments:Array }}
     *   hits: 依次遇到的非空方块 [{name, pos, dist}]
     *   segments: 连续实体的段 [{name, startY/endY 或 startX/Z, len, startPos, endPos}]（可推断柱子高度/墙长度）
     * @example
     * let s = world.scanDirection(bot, 'east', 64); // s.segments[0].len 就是东边石柱高度
     **/
    const dirMap = {
        'north': [0, 0, -1], '北': [0, 0, -1],
        'south': [0, 0, 1], '南': [0, 0, 1],
        'east': [1, 0, 0], '东': [1, 0, 0],
        'west': [-1, 0, 0], '西': [-1, 0, 0],
        'up': [0, 1, 0], '上': [0, 1, 0],
        'down': [0, -1, 0], '下': [0, -1, 0],
    };
    const d = dirMap[direction];
    if (!d) return { error: `未知方向 '${direction}'，可用: north/south/east/west/up/down 或 北/南/东/西/上/下` };
    const bp = bot.entity.position;
    const hits = [];
    let segments = [];
    let cur = null; // 当前连续段 {name, startPos, endPos, len, axis, height?}
    const isHorizontal = d[0] !== 0 || d[2] !== 0;
    const axis = (d[0] !== 0) ? 'x' : (d[2] !== 0) ? 'z' : 'y';

    // 测一个方块在 y 方向上连续同材质的延伸高度（向上+向下），用于水平扫描时补"柱子多高"。
    const measureVertical = (pos, name) => {
        let topY = pos.y, botY = pos.y;
        for (let y = pos.y + 1; y < pos.y + maxDist; y++) {
            const b = bot.blockAt(pos.offset ? pos.offset(0, y - pos.y, 0) : null);
            if (!b || b.name !== name) break;
            topY = y;
        }
        for (let y = pos.y - 1; y > pos.y - maxDist; y--) {
            const b = bot.blockAt(pos.offset ? pos.offset(0, y - pos.y, 0) : null);
            if (!b || b.name !== name) break;
            botY = y;
        }
        return { height: topY - botY + 1, topY, botY };
    };

    for (let i = 1; i <= maxDist; i++) {
        const block = bot.blockAt(bp.offset(d[0] * i, d[1] * i, d[2] * i));
        const name = block ? block.name : 'air';
        const wallLike = _isWallLike(block);
        const liquid = _isLiquid(block);
        if (wallLike || liquid) {
            hits.push({ name, pos: block.position, dist: i, liquid });
            // 连续段：同材质相邻 → 续段；否则结束旧段开新段
            if (cur && cur.name === name) {
                cur.endPos = block.position;
                cur.len++;
            } else {
                if (cur) segments.push(cur);
                cur = { name, startPos: block.position, endPos: block.position, len: 1, axis, liquid };
            }
        } else {
            if (cur) { segments.push(cur); cur = null; }
        }
    }
    if (cur) segments.push(cur);

    // 水平扫描：给每个段补"纵向高度"，让 AI 一眼看出"东边石柱高36格"而非只"宽1格"。
    if (isHorizontal) {
        for (const s of segments) {
            try {
                const v = measureVertical(s.startPos, s.name);
                s.height = v.height;
                s.verticalSpan = { topY: v.topY, botY: v.botY };
            } catch (_) { s.height = null; }
        }
    }
    return { hits, segments };
}


export function getNearestBlocks(bot, block_types=null, distance=8, count=10000) {
    /**
     * Get a list of the nearest blocks of the given types.
     * @param {Bot} bot - The bot to get the nearest block for.
     * @param {string[]} block_types - The names of the blocks to search for.
     * @param {number} distance - The maximum distance to search, default 16.
     * @param {number} count - The maximum number of blocks to find, default 10000.
     * @returns {Block[]} - The nearest blocks of the given type.
     * @example
     * let woodBlocks = world.getNearestBlocks(bot, ['oak_log', 'birch_log'], 16, 1);
     **/
    // if blocktypes is not a list, make it a list
    let block_ids = [];
    if (block_types === null) {
        block_ids = mc.getAllBlockIds(['air']);
    }
    else {
        if (!Array.isArray(block_types))
            block_types = [block_types];
        for(let block_type of block_types) {
            block_ids.push(mc.getBlockId(block_type));
        }
    }
    return getNearestBlocksWhere(bot, block_ids, distance, count);  
}

export function getNearestBlocksWhere(bot, predicate, distance=8, count=10000) {
    /**
     * Get a list of the nearest blocks that satisfy the given predicate.
     * @param {Bot} bot - The bot to get the nearest blocks for.
     * @param {function} predicate - The predicate to filter the blocks.
     * @param {number} distance - The maximum distance to search, default 16.
     * @param {number} count - The maximum number of blocks to find, default 10000.
     * @returns {Block[]} - The nearest blocks that satisfy the given predicate.
     * @example
     * let waterBlocks = world.getNearestBlocksWhere(bot, block => block.name === 'water', 16, 10);
     **/
    let positions = bot.findBlocks({matching: predicate, maxDistance: distance, count: count});
    let blocks = positions.map(position => bot.blockAt(position));
    return blocks;
}


export function getNearestBlock(bot, block_type, distance=16) {
     /**
     * Get the nearest block of the given type.
     * @param {Bot} bot - The bot to get the nearest block for.
     * @param {string} block_type - The name of the block to search.
     * @param {number} distance - The maximum distance to search, default 16.
     * @returns {Block} - The nearest block of the given type.
     * @example
     * let coalBlock = world.getNearestBlock(bot, 'coal_ore', 16);
     **/
    let blocks = getNearestBlocks(bot, block_type, distance, 1);
    if (blocks.length > 0) {
        return blocks[0];
    }
    return null;
}

const _yield = () => new Promise(resolve => setImmediate(resolve));

export async function getNearestBlockAsync(bot, block_type, distance=16) {
    /**
     * Async, non-blocking version of getNearestBlock.
     * Searches outward in expanding shells so the event loop can breathe
     * between batches (keeps socket.io heartbeats alive → no disconnect).
     * Use this instead of getNearestBlock for large search radii.
     * @param {Bot} bot - The bot to get the nearest block for.
     * @param {string} block_type - The name of the block to search.
     * @param {number} distance - The maximum distance to search, default 16.
     * @returns {Promise<Block|null>} - The nearest block of the given type, or null.
     **/
    // 小范围直接走同步路径，开销可忽略
    if (distance <= 64) {
        return getNearestBlock(bot, block_type, distance);
    }
    // 向外逐圈扩大：先扫近的，近的没有再放大。每圈之间 yield，让心跳通过。
    // 步长 64：64→128→192→...→distance。最内圈用同步也行，但统一异步更简单。
    const step = 64;
    let r = step;
    while (r < distance) {
        const block = getNearestBlock(bot, block_type, r);
        if (block) return block;
        await _yield();
        r += step;
    }
    // 最后一圈到完整 distance
    return getNearestBlock(bot, block_type, distance);
}


export function getNearbyEntities(bot, maxDistance=16) {
    let entities = [];
    for (const entity of Object.values(bot.entities)) {
        const distance = entity.position.distanceTo(bot.entity.position);
        if (distance > maxDistance) continue;
        entities.push({ entity: entity, distance: distance });
    }
    entities.sort((a, b) => a.distance - b.distance);
    let res = [];
    for (let i = 0; i < entities.length; i++) {
        res.push(entities[i].entity);
    }
    return res;
}

export function getNearestEntityWhere(bot, predicate, maxDistance=16) {
    return bot.nearestEntity(entity => predicate(entity) && bot.entity.position.distanceTo(entity.position) < maxDistance);
}


export function getNearbyPlayers(bot, maxDistance) {
    if (maxDistance == null) maxDistance = 16;
    let players = [];
    for (const entity of Object.values(bot.entities)) {
        const distance = entity.position.distanceTo(bot.entity.position);
        if (distance > maxDistance) continue;
        if (entity.type == 'player' && entity.username != bot.username) {
            players.push({ entity: entity, distance: distance });
        } 
    }
    players.sort((a, b) => a.distance - b.distance);
    let res = [];
    for (let i = 0; i < players.length; i++) {
        res.push(players[i].entity);
    }
    return res;
}

// Helper function to get villager profession from metadata
export function getVillagerProfession(entity) {
    // Villager profession mapping based on metadata
    const professions = {
        0: 'Unemployed',
        1: 'Armorer',
        2: 'Butcher', 
        3: 'Cartographer',
        4: 'Cleric',
        5: 'Farmer',
        6: 'Fisherman',
        7: 'Fletcher',
        8: 'Leatherworker',
        9: 'Librarian',
        10: 'Mason',
        11: 'Nitwit',
        12: 'Shepherd',
        13: 'Toolsmith',
        14: 'Weaponsmith'
    };
    
    if (entity.metadata && entity.metadata[18]) {
        // Check if metadata[18] is an object with villagerProfession property
        if (typeof entity.metadata[18] === 'object' && entity.metadata[18].villagerProfession !== undefined) {
            const professionId = entity.metadata[18].villagerProfession;
            const level = entity.metadata[18].level || 1;
            const professionName = professions[professionId] || 'Unknown';
            return `${professionName} L${level}`;
        }
        // Fallback for direct profession ID
        else if (typeof entity.metadata[18] === 'number') {
            const professionId = entity.metadata[18];
            return professions[professionId] || 'Unknown';
        }
    }
    
    // If we can't determine profession but it's an adult villager
    if (entity.metadata && entity.metadata[16] !== 1) { // Not a baby
        return 'Adult';
    }
    
    return 'Unknown';
}


export function getInventoryCounts(bot) {
    /**
     * Get an object representing the bot's inventory.
     * @param {Bot} bot - The bot to get the inventory for.
     * @returns {object} - An object with item names as keys and counts as values.
     * @example
     * let inventory = world.getInventoryCounts(bot);
     * let oakLogCount = inventory['oak_log'];
     * let hasWoodenPickaxe = inventory['wooden_pickaxe'] > 0;
     **/
    let inventory = {};
    for (const slot of bot.inventory.slots) {
        if (slot != null && slot.name) {
            if (inventory[slot.name] == null) {
                inventory[slot.name] = 0;
            }
            inventory[slot.name] += slot.count;
        }
    }
    return inventory;
}


export function getCraftableItems(bot) {
    /**
     * Get a list of all items that can be crafted with the bot's current inventory.
     * @param {Bot} bot - The bot to get the craftable items for.
     * @returns {string[]} - A list of all items that can be crafted.
     * @example
     * let craftableItems = world.getCraftableItems(bot);
     **/
    let table = getNearestBlock(bot, 'crafting_table');
    if (!table) {
        for (const item of bot.inventory.items()) {
            if (item != null && item.name === 'crafting_table') {
                table = item;
                break;
            }
        }
    }
    let res = [];
    for (const item of mc.getAllItems()) {
        let recipes = bot.recipesFor(item.id, null, 1, table);
        if (recipes.length > 0)
            res.push(item.name);
    }
    return res;
}


export function getPosition(bot) {
    /**
     * Get your position in the world (Note that y is vertical).
     * @param {Bot} bot - The bot to get the position for.
     * @returns {Vec3} - An object with x, y, and x attributes representing the position of the bot.
     * @example
     * let position = world.getPosition(bot);
     * let x = position.x;
     **/
    return bot.entity.position;
}


export function getNearbyEntityTypes(bot) {
    /**
     * Get a list of all nearby mob types.
     * @param {Bot} bot - The bot to get nearby mobs for.
     * @returns {string[]} - A list of all nearby mobs.
     * @example
     * let mobs = world.getNearbyEntityTypes(bot);
     **/
    let mobs = getNearbyEntities(bot, 16);
    let found = [];
    for (let i = 0; i < mobs.length; i++) {
        if (!found.includes(mobs[i].name)) {
            found.push(mobs[i].name);
        }
    }
    return found;
}

export function isEntityType(name) {
    /**
     * Check if a given name is a valid entity type.
     * @param {string} name - The name of the entity type to check.
     * @returns {boolean} - True if the name is a valid entity type, false otherwise.
     */
    return mc.getEntityId(name) !== null;
}

export function getNearbyPlayerNames(bot) {
    /**
     * Get a list of all nearby player names.
     * @param {Bot} bot - The bot to get nearby players for.
     * @returns {string[]} - A list of all nearby players.
     * @example
     * let players = world.getNearbyPlayerNames(bot);
     **/
    let players = getNearbyPlayers(bot, 64);
    let found = [];
    for (let i = 0; i < players.length; i++) {
        if (!found.includes(players[i].username) && players[i].username != bot.username) {
            found.push(players[i].username);
        }
    }
    return found;
}


export function getNearbyBlockTypes(bot, distance=16) {
    /**
     * Get a list of all nearby block names.
     * @param {Bot} bot - The bot to get nearby blocks for.
     * @param {number} distance - The maximum distance to search, default 16.
     * @returns {string[]} - A list of all nearby blocks.
     * @example
     * let blocks = world.getNearbyBlockTypes(bot);
     **/
    let blocks = getNearestBlocks(bot, null, distance);
    let found = [];
    for (let i = 0; i < blocks.length; i++) {
        if (!found.includes(blocks[i].name)) {
            found.push(blocks[i].name);
        }
    }
    return found;
}

export async function isClearPath(bot, target) {
    /**
     * Check if there is a path to the target that requires no digging or placing blocks.
     * @param {Bot} bot - The bot to get the path for.
     * @param {Entity} target - The target to path to.
     * @returns {boolean} - True if there is a clear path, false otherwise.
     */
    let movements = new pf.Movements(bot)
    movements.canDig = false;
    movements.canPlaceOn = false;
    movements.canOpenDoors = false;
    let goal = new pf.goals.GoalNear(target.position.x, target.position.y, target.position.z, 1);
    let path = await bot.pathfinder.getPathTo(movements, goal, 100);
    return path.status === 'success';
}

export function shouldPlaceTorch(bot) {
    if (!bot.modes.isOn('torch_placing') || bot.interrupt_code) return false;
    const pos = getPosition(bot);
    // TODO: check light level instead of nearby torches, block.light is broken
    let nearest_torch = getNearestBlock(bot, 'torch', 6);
    if (!nearest_torch)
        nearest_torch = getNearestBlock(bot, 'wall_torch', 6);
    if (!nearest_torch) {
        const block = bot.blockAt(pos);
        let has_torch = bot.inventory.findInventoryItem('torch');
        return has_torch && block?.name === 'air';
    }
    return false;
}

export function getBiomeName(bot) {
    /**
     * Get the name of the biome the bot is in.
     * @param {Bot} bot - The bot to get the biome for.
     * @returns {string} - The name of the biome.
     * @example
     * let biome = world.getBiomeName(bot);
     **/
    const biomeId = bot.world.getBiome(bot.entity.position);
    return mc.getAllBiomes()[biomeId].name;
}
