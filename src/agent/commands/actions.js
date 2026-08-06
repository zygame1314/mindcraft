import * as skills from '../library/skills.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { readdirSync, readFileSync } from 'fs';
import * as mc from '../../utils/mcdata.js';
import * as world from '../library/world.js';

// 预设建筑模板生成器：AI 给一个 type 关键词，代码层产出标准 blueprint
// ({levels:[{coordinates:[x,y,z], placement:[[...]]}]})，再交给 buildStructure 搭。
// 这样 AI 不必编码也不必逐块 placeBlock，从命令层就把"搭建筑"封进确定逻辑。
// placement 用 [z][x] 二维数组，元素为方块名；null/'' 跳过，'air' 表示清除已有块。
function makePresetBlueprint(type, block, width, height, ox, oy, oz) {
    const B = block || 'oak_planks';
    const W = Math.max(1, Math.min(32, width || 5));
    const H = Math.max(1, Math.min(32, height || 3));
    // 坐标向下取整，与 placeBlock 内部 Math.floor 一致；bot 站在脚下方块上方
    const sx = Math.floor(ox), sy = Math.floor(oy), sz = Math.floor(oz);
    const mk = (rows) => ({ coordinates: [sx, sy, sz], placement: rows });
    if (type === 'floor') {
        const rows = [];
        for (let z = 0; z < W; z++) {
            const row = [];
            for (let x = 0; x < W; x++) row.push(B);
            rows.push(row);
        }
        return { levels: [mk(rows)] };
    }
    if (type === 'wall') {
        const rows = [];
        for (let z = 0; z < 1; z++) {
            const row = [];
            for (let x = 0; x < W; x++) row.push(B);
            rows.push(row);
        }
        const levels = [];
        for (let y = 0; y < H; y++) {
            levels.push({ coordinates: [sx, sy + y, sz], placement: rows.map(r => r.slice()) });
        }
        return { levels };
    }
    if (type === 'pillar') {
        // 单格柱塔，便于承重排序验证；高度 H
        const rows = [[B]];
        const levels = [];
        for (let y = 0; y < H; y++) {
            levels.push({ coordinates: [sx, sy + y, sz], placement: rows.map(r => r.slice()) });
        }
        return { levels };
    }
    if (type === 'house') {
        // 5x5 平面、4 墙高的小屋：地基+封顶实心，墙只围外框，内部 3x3 真空间。
        // 正南（z=4）中央开 2 格高门洞，左右墙上各留 1 格窗户（玻璃），可进光照。
        const SIZE = 5;
        const wallH = 4;
        const plane = (fill) => {
            const rows = [];
            for (let z = 0; z < SIZE; z++) {
                const row = [];
                for (let x = 0; x < SIZE; x++) {
                    const edge = x === 0 || x === SIZE - 1 || z === 0 || z === SIZE - 1;
                    row.push(edge ? B : fill);
                }
                rows.push(row);
            }
            return rows;
        };
        const glass = 'glass';
        const levels = [];
        for (let y = 0; y < wallH + 2; y++) {
            let rows;
            if (y === 0) {
                rows = plane(B);                          // 地基实心
            } else if (y === wallH + 1) {
                rows = plane(B);                          // 封顶实心
            } else {
                rows = plane('air');                      // 墙体外框+内部空
                // 正南 z=4 行中央开 2 格高门洞（y=1,2），y=3 在门顶填 B 作门楣
                if (y === 1 || y === 2) rows[SIZE - 1][2] = 'air';
                // 窗户：东墙(x=4) 和西墙(x=0) 各留一格玻璃，放在墙高中部 y=2
                if (y === 2) {
                    rows[2][0] = glass;                   // 西窗
                    rows[2][SIZE - 1] = glass;            // 东窗
                    // 北墙(z=0)中央也留一窗，透气+采光
                    rows[0][2] = glass;
                }
            }
            levels.push({ coordinates: [sx, sy + y, sz], placement: rows });
        }
        return { levels };
    }
    return null;
}

// --- 社区蓝图接入 ---
// src/agent/npc/construction/*.json 的格式：
//   { name, offset, blocks:[y][z][x] }
//   blocks 的 y 是"含地下偏移"的全局层序：blocks[offset] 才是地面第一层。
//   offset 通常为 -1（表示地面下一格是地基），blocks 长度 = offset + 实际层数。
//   generic 名：'planks'/'log'/'door'/'bed'/'torch' 等不带木种/颜色前缀，
//   需要在放置时按背包存量解析成具体方块（getTypeOfGeneric）。
// buildStructure 需要的格式：
//   { levels:[{ coordinates:[x,y,z], placement:[z][x] }] }
// 转换规则：
//   - 每个全局 y 层 -> 一个 level，坐标 = 起点 + y（offset 已含在 blocks 索引里）。
//   - generic 名在转换期无法解析（要读背包/附近方块），保留原样交给 placeBlock；
//     placeBlock 内部 cheat 路径对 'door'/'bed' 有多格处理，对 'planks'/'log'
//     会因 findInventoryItem('planks') 失败而放不下。故这里先做一次"尽力解析"：
//     若背包里有该 generic 的任意木种实例，挑背包里最多的那种替换；查不到就
//     原样传下去，让 placeBlock 自己报"没有 planks"（AI 据此去伐木）。
//   - 'air' 保留，buildStructure 会调 breakBlockAt 清掉。
//   - '' 空串/null 跳过（不写进 levels，省一格空操作）。
function resolveGenericBlockName(bot, name) {
    if (!name) return name;
    if (mc.MATCHING_WOOD_BLOCKS.includes(name)) {
        const inv = world.getInventoryCounts(bot);
        let best = null, bestCount = 0;
        for (const item in inv) {
            for (const wood of mc.WOOD_TYPES) {
                if (item === wood + '_' + name || (name === 'log' && item === wood + '_log')) {
                    if (inv[item] > bestCount) { bestCount = inv[item]; best = item; }
                }
            }
        }
        if (best) return best;
        return 'oak_' + name;
    }
    if (name === 'bed') {
        const inv = world.getInventoryCounts(bot);
        for (const color of mc.WOOL_COLORS) {
            if (inv[color + '_bed'] > 0) return color + '_bed';
        }
        return 'red_bed';
    }
    return name;
}

function communityBlueprintToLevels(bot, bp, sx, sy, sz) {
    const offset = bp.offset || 0;
    const blocks = bp.blocks;
    const sizey = blocks.length;
    const levels = [];
    for (let y = 0; y < sizey; y++) {
        const worldY = sy + y;            // offset 已含在 blocks 索引里：blocks[0] 是 offset 层
        const layer = blocks[y] || [];
        const placement = [];
        for (let z = 0; z < layer.length; z++) {
            const row = layer[z] || [];
            const out = [];
            for (let x = 0; x < row.length; x++) {
                let name = row[x];
                if (name === null || name === undefined || name === '') { out.push(null); continue; }
                if (name === 'air') { out.push('air'); continue; }
                out.push(resolveGenericBlockName(bot, name));
            }
            placement.push(out);
        }
        levels.push({ coordinates: [sx, worldY, sz], placement });
    }
    return { levels };
}

// 懒加载社区蓝图目录缓存（避免每次 !buildStructure 都读盘）。
let _communityBlueprintsCache = null;
function loadCommunityBlueprints() {
    if (_communityBlueprintsCache) return _communityBlueprintsCache;
    const dir = 'src/agent/npc/construction';
    const map = {};
    try {
        for (const file of readdirSync(dir)) {
            if (!file.endsWith('.json')) continue;
            const name = file.slice(0, -5);
            map[name] = JSON.parse(readFileSync(dir + '/' + file, 'utf8'));
        }
    } catch (e) {
        console.log('读取社区蓝图目录失败：', e?.message || e);
    }
    _communityBlueprintsCache = map;
    return map;
}

// 方块名（去状态后）-> 实际物品名的映射。多数方块名==物品名，少数例外：
// iron_chain 方块在物品表里叫 chain；grass_block 在物品表也叫 grass_block（有物品）。
// 这里只列例外；其余靠 itemsByName 查不到时再回退到 blocksByName 同名。
const BLOCK_TO_ITEM_NAME = {
    'iron_chain': 'chain',
    // lit=false/true 的红石灯方块用同一物品 redstone_lamp；剥状态后已是 redstone_lamp。
    // 双高层半砖（type=double）实际由两块普通半砖合成，单独标记下面处理。
};

// 把蓝图方块名（可能带 [状态]）转成生存放置所需的物品名。
// 返回 null 表示该方块不需要物品（air/空）或无法映射。
function blockNameToItemName(blockName) {
    if (!blockName || blockName === 'air') return null;
    // 剥掉状态串：grass_block[snowy=false] -> grass_block
    const base = blockName.replace(/\[.*$/, '');
    if (base === 'air' || base === '') return null;
    // double 半砖（如 deepslate_brick_slab[type=double]）放下去算 1 块，
    // 但生存合成/采集时按 1 个普通半砖算（放置两块叠成 double，游戏内部如此）。
    // 为简化材料统计，double 当 1 个同名半砖物品计。
    // 这里直接返回 base，状态已剥掉，base 就是 deepslate_brick_slab。
    return BLOCK_TO_ITEM_NAME[base] || base;
}

// 统计蓝图所需材料（物品名->数量），air/空不计。
function blueprintMaterialCounts(bp) {
    const counts = {};
    if (!bp || !Array.isArray(bp.blocks)) return counts;
    for (const layer of bp.blocks) {
        for (const row of layer) {
            for (const cell of row) {
                const item = blockNameToItemName(cell);
                if (item) counts[item] = (counts[item] || 0) + 1;
            }
        }
    }
    return counts;
}

// 查找蓝图名（支持模糊匹配，与 !buildStructure 一致）。
function findCommunityBlueprint(wanted) {
    const community = loadCommunityBlueprints();
    const norm = s => (s || '').toLowerCase().replace(/[\s_-]+/g, '');
    for (const name in community) {
        if (name === wanted || norm(name) === norm(wanted)) return { bp: community[name], name };
    }
    return null;
}

// 把 chest 参数（箱子别名或 x 坐标）解析成 skills 期望的 x/y/z。
// - chest 为空：返回全 null，skills 用最近箱子。
// - chest 是数字串（可带负号/小数点）：当作 x 坐标，配 chest_y/chest_z。
// - chest 是非数字字符串：查 memory_bank 的箱子名/别名，命中返回其坐标。
// 找不到名字时记一条日志并返回全 null（退回最近箱子），不让命令直接报错崩。
function resolveChestArg(agent, chest, chest_y, chest_z) {
    if (chest == null || chest === '') return { x: null, y: null, z: null };
    // 数字坐标
    if (/^-?\d+(\.\d+)?$/.test(String(chest).trim())) {
        return { x: Number(chest), y: chest_y, z: chest_z };
    }
    // 箱子别名
    const mb = agent.memory_bank;
    const name = mb.resolvePlaceName(chest) || chest;
    const c = mb.recallChest(name);
    if (c && c.pos) return { x: c.pos[0], y: c.pos[1], z: c.pos[2] };
    // 找不到时列出所有已记箱子名，避免 AI 反复盲调 !viewNearbyChests 想确认
    const known = mb.getChestKeys();
    skills.log(agent.bot, `没记住过叫 "${chest}" 的箱子。已记的箱子：${known || '（无）'}。用 !viewNearbyChests 看附近实物箱子。`);
    return { notFound: true };
}


function runAsAction(actionFn, resume = false, timeout = -1) {
    let actionLabel = null;  // Will be set on first use

    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        const actionFnWithAgent = async () => {
            await actionFn(agent, ...args);
        };
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
        if (code_return.interrupted && !code_return.timedout)
            return;
        return code_return.message;
    }

    return wrappedAction;
}

export const actionsList = [
    {
        name: '!newAction',
        description: '编写并运行自定义 JS 代码以完成复杂任务（如多步操作、循环、状态跟踪）。单步简单任务请使用专用命令。代码中可直接调用 skills/world 函数，并使用 log(bot, msg) 报告进度。',
        params: {
            'prompt': { type: 'string', description: '引导代码生成的详细分步计划。' }
        },
        perform: async function (agent, prompt) {
            // just ignore prompt - it is now in context in chat history
            if (!settings.allow_insecure_coding) {
                agent.openChat('newAction 已禁用。请在 settings.js 中设置 allow_insecure_coding=true 来启用。');
                return "newAction 不允许！代码编写功能已在设置中禁用。请通知用户。";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(agent.history);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, { timeout: settings.code_timeout_mins });
            return result;
        }
    },
    {
        name: '!stop',
        description: '强制停止当前正在执行的所有动作和命令。',
        perform: async function (agent) {
            await agent.actions.stop();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            let msg = 'Agent stopped.';
            if (agent.self_prompter.isActive())
                msg += ' Self-prompting still active.';
            return msg;
        }
    },
    {
        name: '!stfu',
        description: '停止所有聊天和自我提示，但继续执行当前动作。',
        perform: async function (agent) {
            agent.openChat('闭嘴了。');
            agent.shutUp();
            return;
        }
    },
    {
        name: '!restart',
        description: '重启 Agent 进程。',
        perform: async function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: '清除聊天记录。',
        perform: async function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!goToPlayer',
        description: '前往指定玩家的位置。',
        params: {
            'player_name': { type: 'string', description: '要前往的玩家名称。' },
            'closeness': { type: 'float', description: '与玩家保持的距离。', domain: [0, Infinity] }
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            await skills.goToPlayer(agent.bot, player_name, closeness);
        })
    },
    {
        name: '!followPlayer',
        description: '持续跟随指定玩家。',
        params: {
            'player_name': { type: 'string', description: '要跟随的玩家名称。' },
            'follow_dist': { type: 'float', description: '跟随距离。', domain: [0, Infinity] }
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: '前往指定的 x, y, z 坐标。',
        params: {
            'x': { type: 'float', description: 'X 坐标。', domain: [-Infinity, Infinity] },
            'y': { type: 'float', description: 'Y 坐标。', domain: [-64, 320] },
            'z': { type: 'float', description: 'Z 坐标。', domain: [-Infinity, Infinity] },
            'closeness': { type: 'float', description: '与目标位置保持的距离。', domain: [0, Infinity] }
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.goToPosition(agent.bot, x, y, z, closeness);
        })
    },
    {
        name: '!searchForBlock',
        description: '在指定范围内寻找并前往最近的指定类型方块。',
        params: {
            'type': { type: 'BlockName', description: '要寻找的方块类型。' },
            'search_range': { type: 'float', description: '搜索范围。最小 32。', domain: [10, 512, '[]'] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!searchForEntity',
        description: '在指定范围内寻找并前往最近的指定类型实体。',
        params: {
            'type': { type: 'string', description: '要寻找的实体类型。' },
            'search_range': { type: 'float', description: '搜索范围。', domain: [32, 512] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: '向任意方向离开当前位置一段距离。',
        params: { 'distance': { type: 'float', description: '离开的距离。', domain: [0, Infinity] } },
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!rememberHere',
        description: '把当前位置存为命名地点，可带备注。例：!rememberHere("家","箱子在西墙")。已存在同名会更新备注。',
        params: {
            'name': { type: 'string', description: '地点名，例如 "家"、"钓鱼点"。' },
            'note': { type: 'string', description: '可选备注，例如 "箱子在西墙"、"出生点"。', optional: true }
        },
        perform: async function (agent, name, note) {
            const pos = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z, note || '');
            return `已记住地点 "${name}" 于 (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})${note ? `，备注：${note}` : ''}。`;
        }
    },
    {
        name: '!rememberPlace',
        description: '把指定坐标存为命名地点，用于记录别人报的坐标或远处地点。例：!rememberPlace("村庄",-1074,63,-480,"玩家发现的村庄")。已存在同名会更新。',
        params: {
            'name': { type: 'string', description: '地点名，例如 "大村"、"地狱门"。' },
            'x': { type: 'float', description: 'X 坐标。', domain: [-Infinity, Infinity] },
            'y': { type: 'float', description: 'Y 坐标。', domain: [-64, 320] },
            'z': { type: 'float', description: 'Z 坐标。', domain: [-Infinity, Infinity] },
            'note': { type: 'string', description: '可选备注，例如 "玩家发现的村庄"、"岩浆池"。', optional: true }
        },
        perform: async function (agent, name, x, y, z, note) {
            agent.memory_bank.rememberPlace(name, x, y, z, note || '');
            return `已记住地点 "${name}" 于 (${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)})${note ? `，备注：${note}` : ''}。`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: '前往之前保存的地点。',
        params: { 'name': { type: 'string', description: '要前往的地点名称。' } },
        perform: runAsAction(async (agent, name) => {
            const resolved = agent.memory_bank.resolvePlaceName(name);
            if (!resolved) {
                skills.log(agent.bot, `没找到叫 "${name}" 的地点。用 !savedPlaces 看全部已记地点。`);
                return;
            }
            const pos = agent.memory_bank.recallPlace(resolved);
            if (!pos) {
                skills.log(agent.bot, `地点 "${resolved}" 没有坐标。`);
                return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
        })
    },
    {
        name: '!givePlayer',
        description: '将指定物品交给指定玩家。',
        params: {
            'player_name': { type: 'string', description: '接收物品的玩家名称。' },
            'item_name': { type: 'ItemName', description: '要给予的物品名称。' },
            'num': { type: 'int', description: '给予物品的数量。', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!consume',
        description: '食用/饮用指定物品。',
        params: { 'item_name': { type: 'ItemName', description: '要消费的物品名称。' } },
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: '装备指定物品。',
        params: { 'item_name': { type: 'ItemName', description: '要装备的物品名称。' } },
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!putInChest',
        description: '把物品放进箱子。可用箱子名字或坐标。例：!putInChest("coal",2,"矿物箱") 或 !putInChest("coal",2,-694,60,-235)。不传则用最近的箱子。',
        params: {
            'item_name': { type: 'ItemName', description: '要放的物品名。' },
            'num': { type: 'int', description: '数量。', domain: [1, Number.MAX_SAFE_INTEGER] },
            'chest': { type: 'string', description: '箱子别名（如"矿物箱"）或 x 坐标。省略用最近箱子。', optional: true },
            'chest_y': { type: 'int', description: 'y 坐标（传了 chest 且是数字时用）。', optional: true, domain: [-64, 320] },
            'chest_z': { type: 'int', description: 'z 坐标。', optional: true, domain: [-Infinity, Infinity] }
        },
        perform: runAsAction(async (agent, item_name, num, chest, chest_y, chest_z) => {
            const r = resolveChestArg(agent, chest, chest_y, chest_z);
            if (r.notFound) return;
            await skills.putInChest(agent.bot, item_name, num, r.x, r.y, r.z);
        })
    },
    {
        name: '!takeFromChest',
        description: '从箱子取物品。可用箱子名字或坐标。例：!takeFromChest("iron_ingot",4,"矿物箱") 或 !takeFromChest("iron_ingot",4,-694,60,-235)。',
        params: {
            'item_name': { type: 'ItemName', description: '要取的物品名。' },
            'num': { type: 'int', description: '数量。', domain: [1, Number.MAX_SAFE_INTEGER] },
            'chest': { type: 'string', description: '箱子别名或 x 坐标。省略用最近箱子。', optional: true },
            'chest_y': { type: 'int', description: 'y 坐标。', optional: true, domain: [-64, 320] },
            'chest_z': { type: 'int', description: 'z 坐标。', optional: true, domain: [-Infinity, Infinity] }
        },
        perform: runAsAction(async (agent, item_name, num, chest, chest_y, chest_z) => {
            const r = resolveChestArg(agent, chest, chest_y, chest_z);
            if (r.notFound) return;
            await skills.takeFromChest(agent.bot, item_name, num, r.x, r.y, r.z);
        })
    },
    {
        name: '!viewChest',
        description: '看箱子内容。可用箱子名字或坐标。例：!viewChest("矿物箱") 或 !viewChest(-694,60,-235)。不传则看最近箱子。',
        params: {
            'chest': { type: 'string', description: '箱子别名或 x 坐标。省略看最近箱子。', optional: true },
            'chest_y': { type: 'int', description: 'y 坐标。', optional: true, domain: [-64, 320] },
            'chest_z': { type: 'int', description: 'z 坐标。', optional: true, domain: [-Infinity, Infinity] }
        },
        perform: runAsAction(async (agent, chest, chest_y, chest_z) => {
            const r = resolveChestArg(agent, chest, chest_y, chest_z);
            if (r.notFound) return;
            await skills.viewChest(agent.bot, r.x, r.y, r.z);
        })
    },
    {
        name: '!viewNearbyChests',
        description: '列出附近所有箱子的坐标和内容。用这个一次看清所有箱子，再用坐标或别名操作 !viewChest/!putInChest/!takeFromChest。',
        params: {
            'range': { type: 'int', description: 'The search radius in blocks. Defaults to 32.', optional: true, domain: [1, 128], default: 32 }
        },
        perform: runAsAction(async (agent, range) => {
            await skills.viewNearbyChests(agent.bot, range);
        })
    },
    {
        name: '!discard',
        description: '从背包中丢弃指定物品。',
        params: {
            'item_name': { type: 'ItemName', description: '要丢弃的物品名称。' },
            'num': { type: 'int', description: '丢弃的数量。', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            const start_loc = agent.bot.entity.position;
            await skills.moveAway(agent.bot, 5);
            await skills.discard(agent.bot, item_name, num);
            await skills.goToPosition(agent.bot, start_loc.x, start_loc.y, start_loc.z, 0);
        })
    },
    {
        name: '!collectBlocks',
        description: '收集最近的指定类型方块。矿石类使用基础名（如 "diamond"）将自动包含深板岩变体。',
        params: {
            'type': { type: 'BlockName', description: '要收集的方块类型。' },
            'num': { type: 'int', description: '收集数量。', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, type, num) => {
            await skills.collectBlock(agent.bot, type, num);
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!buildStructure',
        description: '在当前位置按照模板搭建筑，请先准备好材料。',
        params: {
            'type': { type: 'string', description: '蓝图名（如 small_wood_house，用 !listBlueprints 看全部）或模板名（house/wall/pillar/floor）。' },
            'block': { type: 'BlockName', description: '主体方块（仅 wall/pillar/floor 简单模板用，默认 oak_planks）。', optional: true },
            'width': { type: 'int', description: '宽度（仅 wall/floor 简单模板用）。', optional: true, domain: [1, 32] },
            'height': { type: 'int', description: '高度（仅 wall/pillar 简单模板用）。', optional: true, domain: [1, 32] }
        },
        perform: runAsAction(async (agent, type, block, width, height) => {
            const p = agent.bot.entity.position;
            const sx = Math.floor(p.x), sy = Math.floor(p.y), sz = Math.floor(p.z);
            // 1) 先查社区蓝图目录（带门窗床箱屋顶的精致蓝图）
            const found = findCommunityBlueprint((type || '').trim());
            if (found) {
                const { bp, name } = found;
                skills.log(agent.bot, `使用社区蓝图 "${name}"（${bp.blocks.length} 层，offset=${bp.offset}）。`);
                const blueprint = communityBlueprintToLevels(agent.bot, bp, sx, sy, sz);
                await skills.buildStructure(agent.bot, blueprint);
                return;
            }
            // 2) 再退回简单模板
            const blueprint = makePresetBlueprint(type || 'house', block || 'oak_planks', width, height, p.x, p.y, p.z);
            if (!blueprint) {
                const community = loadCommunityBlueprints();
                const known = Object.keys(community).join(', ') || '（无）';
                skills.log(agent.bot, `未知蓝图/模板 "${type}"。可用社区蓝图：${known}。简单模板：house / wall / pillar / floor。`);
                return;
            }
            await skills.buildStructure(agent.bot, blueprint);
        }, false, 20)
    },
    {
        name: '!listBlueprints',
        description: '列出所有可用的建筑蓝图名，供 !buildStructure 使用。',
        params: {},
        perform: runAsAction(async (agent) => {
            const community = loadCommunityBlueprints();
            const names = Object.keys(community);
            let msg = `可用社区蓝图（${names.length} 个，自带门窗床箱，推荐）：\n`;
            for (const n of names) {
                const bp = community[n];
                const sx = bp.blocks[0][0].length, sz = bp.blocks[0].length, sy = bp.blocks.length;
                msg += `  - ${n}（${sx}x${sz}x${sy} 层${bp.offset != 0 ? '，含地下' + (-bp.offset) + '层' : ''}）\n`;
            }
            msg += `简单模板：house（5x5带门窗小屋）/ wall / pillar / floor（用 block/width/height 参数）。`;
            skills.log(agent.bot, msg);
        })
    },
    {
        name: '!blueprintMaterials',
        description: '查看建造某蓝图需要哪些材料，并与当前背包对比，告诉你缺多少。生存模式搭建筑前先查这个。',
        params: {
            'type': { type: 'string', description: '蓝图名（用 !listBlueprints 看全部）。' }
        },
        perform: runAsAction(async (agent, type) => {
            const found = findCommunityBlueprint((type || '').trim());
            if (!found) {
                const community = loadCommunityBlueprints();
                const known = Object.keys(community).join(', ') || '（无）';
                skills.log(agent.bot, `没找到蓝图 "${type}"。可用蓝图：${known}。`);
                return;
            }
            const { bp, name } = found;
            const need = blueprintMaterialCounts(bp);
            const inv = world.getInventoryCounts(agent.bot);
            // 分类：已有/不足/完全缺
            const sorted = Object.entries(need).sort((a, b) => b[1] - a[1]);
            let lines = [`蓝图 "${name}"（${bp.blocks.length} 层）所需材料：`];
            let totalSlots = sorted.length;
            let totalMissing = 0;
            const missing = [];
            for (const [item, count] of sorted) {
                const have = inv[item] || 0;
                if (have >= count) {
                    lines.push(`  ${item}: 需 ${count}（已有 ${have}，够）`);
                } else if (have > 0) {
                    const lack = count - have;
                    totalMissing += lack;
                    missing.push(`${item}x${lack}`);
                    lines.push(`  ${item}: 需 ${count}（已有 ${have}，缺 ${lack}）`);
                } else {
                    totalMissing += count;
                    missing.push(`${item}x${count}`);
                    lines.push(`  ${item}: 需 ${count}（背包没有，全缺）`);
                }
            }
            lines.push(`共 ${totalSlots} 种材料，缺 ${totalMissing} 块。`);
            if (missing.length > 0) {
                lines.push(`缺料清单：${missing.join(', ')}。`);
                lines.push(`用 !collectBlock <方块名> <数量> 去采集，或 !craftRecipe 合成后重新查。`);
            } else {
                lines.push(`材料齐全，可以 !buildStructure ${name} 了。`);
            }
            skills.log(agent.bot, lines.join('\n'));
        })
    },
    {
        name: '!craftRecipe',
        description: '按照给定配方制作指定次数的物品。',
        params: {
            'recipe_name': { type: 'ItemName', description: '要制作的输出物品名称。' },
            'num': { type: 'int', description: '执行配方的次数。这并非输出物品的总数，因为具体数量取决于配方。', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, recipe_name, num) => {
            await skills.craftRecipe(agent.bot, recipe_name, num);
        })
    },
    {
        name: '!smeltItem',
        description: '冶炼指定物品，执行指定次数。',
        params: {
            'item_name': { type: 'ItemName', description: '要冶炼的输入物品名称。' },
            'num': { type: 'int', description: '要冶炼的数量。', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.smeltItem(agent.bot, item_name, num);
        })
    },
    {
        name: '!clearFurnace',
        description: '取走最近熔炉中的所有物品。',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
    {
        name: '!combineAtAnvil',
        description: '在铁砧上组合两个物品（修复工具/盔甲或转移附魔）。需要附近有铁砧，消耗经验。',
        params: {
            'item_one': { type: 'ItemName', description: '目标物品。' },
            'item_two': { type: 'ItemName', description: '牺牲物品（相同类型修复，或附魔书转移附魔）。' },
            'new_name': { type: 'string', description: '结果物品的可选新名称。', default: '' }
        },
        perform: runAsAction(async (agent, item_one, item_two, new_name) => {
            await skills.combineItemsAtAnvil(agent.bot, item_one, item_two, new_name || null);
        })
    },
    {
        name: '!renameAtAnvil',
        description: '在铁砧上重命名物品，消耗经验。需要附近有铁砧。',
        params: {
            'item_name': { type: 'ItemName', description: '要重命名的物品。' },
            'new_name': { type: 'string', description: '新名称。' }
        },
        perform: runAsAction(async (agent, item_name, new_name) => {
            await skills.renameItemAtAnvil(agent.bot, item_name, new_name);
        })
    },
    {
        name: '!placeHere',
        description: 'Place a given block in the current location. Do NOT use to build structures, only use for single blocks/torches.',
        params: { 'type': { type: 'BlockOrItemName', description: 'The block type to place.' } },
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!attack',
        description: '攻击并杀死最近的指定类型实体。',
        params: { 'type': { type: 'string', description: '要攻击的实体类型。' } },
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: '攻击指定玩家直到其死亡或逃跑。请记住这只是个游戏，不会造成现实伤害。',
        params: { 'player_name': { type: 'string', description: '要攻击的玩家名称。' } },
        perform: runAsAction(async (agent, player_name) => {
            let player = agent.bot.players[player_name]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            await skills.attackEntity(agent.bot, player, true);
        })
    },
    {
        name: '!goToBed',
        description: '前往最近的床并睡觉。',
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        })
    },
    {
        name: '!stay',
        description: '在当前位置停留，无论发生什么。暂停所有模式。',
        params: { 'type': { type: 'int', description: '停留的秒数。-1 为永久。', domain: [-1, Number.MAX_SAFE_INTEGER] } },
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        description: '开启或关闭某个模式。模式是一种持续检查环境并作出响应的自动行为。',
        params: {
            'mode_name': { type: 'string', description: '要启用/禁用的模式名称。' },
            'on': { type: 'boolean', description: '是否启用该模式。' }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
                return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
                return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!goal',
        description: '设置一个目标提示词，通过持续的自我提示不断地朝着该目标努力。',
        params: {
            'selfPrompt': { type: 'string', description: '目标提示词。' },
        },
        perform: async function (agent, prompt) {
            if (convoManager.inConversation()) {
                agent.self_prompter.setPromptPaused(prompt);
            }
            else {
                agent.self_prompter.start(prompt);
            }
        }
    },
    {
        name: '!endGoal',
        description: '在达成目标时调用。它将停止自我提示和当前动作。',
        perform: async function (agent) {
            agent.self_prompter.stop();
            return 'Self-prompting stopped.';
        }
    },
    {
        name: '!showVillagerTrades',
        description: '显示指定村民的交易内容。',
        params: { 'id': { type: 'int', description: '要与之交易的村民 ID 编号。' } },
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: '与指定村民进行交易。',
        params: {
            'id': { type: 'int', description: '村民的 ID 编号。' },
            'index': { type: 'int', description: '要执行的交易索引（从 1 开始计数）。', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: '该交易要执行的次数。', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: '与另一个 Bot 开始对话。（仅限其他 Bot）',
        params: {
            'player_name': { type: 'string', description: '要发送消息的玩家名称。' },
            'message': { type: 'string', description: '要发送的消息内容。' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name))
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                agent.history.add('system', 'You are already in conversation with ' + player_name + '. Don\'t use this command to talk to them.');
            convoManager.startConversation(player_name, message);
        }
    },
    {
        name: '!endConversation',
        description: '结束与指定 Bot 的对话。（仅限其他 Bot）',
        params: {
            'player_name': { type: 'string', description: '要结束对话的玩家名称。' }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
    },
    {
        name: '!lookAtPlayer',
        description: '看向玩家，或与玩家看向同一方向。',
        params: {
            'player_name': { type: 'string', description: '目标玩家名称' },
            'direction': {
                type: 'string',
                description: '查看方式 ("at": 看向玩家, "with": 与玩家看向同一方向)',
            }
        },
        perform: async function (agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!lookAtPosition',
        description: '看向指定的坐标。',
        params: {
            'x': { type: 'int', description: 'x 坐标' },
            'y': { type: 'int', description: 'y 坐标' },
            'z': { type: 'int', description: 'z 坐标' }
        },
        perform: async function (agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPosition(x, y, z);
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: '向下挖掘指定距离。如果到达岩浆、水或下方有 >=4 格的掉落将停止。',
        params: { 'distance': { type: 'int', description: '向下挖掘的距离', domain: [1, Number.MAX_SAFE_INTEGER] } },
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance)
        })
    },
    {
        name: '!goToSurface',
        description: '将 Bot 移至其上方的最高方块（通常是地表）。',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!goToShore',
        description: '从水里/岸边爬上岸。',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToShore(agent.bot);
        })
    },
    {
        name: '!fish',
        description: '装备钓鱼竿并钓鱼。等待直到有鱼上钩或达到指定超时时间。',
        params: {
            'timeout_ms': { type: 'int', description: '等待上钩的最大毫秒数。默认为 60000。', domain: [1000, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, timeout_ms) => {
            await skills.fish(agent.bot, timeout_ms || 60000);
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!tillAndSow',
        description: '在给定位置耕地，并可选地种植指定类型的种子。',
        params: {
            'x': { type: 'int', description: '耕地的 x 坐标。' },
            'y': { type: 'int', description: '耕地的 y 坐标。', domain: [-64, 320] },
            'z': { type: 'int', description: '耕地的 z 坐标。' },
            'seed_type': { type: 'string', description: '要种植的种子名称，为空则仅耕地。' }
        },
        perform: runAsAction(async (agent, x, y, z, seed_type) => {
            await skills.tillAndSow(agent.bot, x, y, z, seed_type || null);
        })
    },
    {
        name: '!useOn',
        description: '在最近的指定类型目标上使用给定的工具（右键）。',
        params: {
            'tool_name': { type: 'string', description: '要使用的工具名称，或 "hand" 表示空手。' },
            'target': { type: 'string', description: '目标，可以是实体类型、方块类型，或 "nothing" 表示无目标。' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
    {
        name: '!rememberChest',
        description: '给箱子记录别名和用途。例：!rememberChest("矿物箱","存矿石")。可选坐标精确指定。',
        params: {
            'name': { type: 'string', description: '箱子别名。' },
            'purpose': { type: 'string', description: '用途描述。' },
            'chest_x': { type: 'int', description: 'x 坐标，省略则用最近箱子。', optional: true, domain: [-Infinity, Infinity] },
            'chest_y': { type: 'int', description: 'y 坐标。', optional: true, domain: [-64, 320] },
            'chest_z': { type: 'int', description: 'z 坐标。', optional: true, domain: [-Infinity, Infinity] }
        },
        perform: runAsAction(async (agent, name, purpose, chest_x, chest_y, chest_z) => {
            const bot = agent.bot;
            const range = (chest_x != null) ? 32 : 5;
            const chest = await skills._resolveChestForMemory(bot, chest_x, chest_y, chest_z, range);
            if (!chest) {
                skills.log(bot, '附近没有箱子可记录。');
                return;
            }
            // 检测双联箱另一半，一起记进 positions。
            // 必须用 isChestOtherHalf 校验 facing/方向/互补 type，不能只看 type 互补：
            // 并排多排双联箱时，不同箱子的两半也可能相邻且 type 互补（left+right），
            // 旧实现会把它们误配成一对，导致记忆里两个箱子共用一半坐标、互相覆盖名字。
            const positions = [[chest.position.x, chest.position.y, chest.position.z]];
            try {
                const t = chest._properties?.type;
                if (t === 'left' || t === 'right') {
                    const adj = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
                    for (const [dx, dy, dz] of adj) {
                        const nb = bot.blockAt(chest.position.offset(dx, dy, dz));
                        if (nb && nb.name === chest.name && skills.isChestOtherHalf(chest, nb)) {
                            positions.push([nb.position.x, nb.position.y, nb.position.z]);
                            break;
                        }
                    }
                }
            } catch (_) { }
            const pos = positions[0];
            // findChestByPos 精确匹配任一组成方块。若命中已命名箱子，说明在改名/重记，
            // 显式删旧条目再记新的，避免同一物理箱子留多条记录。
            let oldName = null;
            for (const p of positions) {
                oldName = agent.memory_bank.findChestByPos(...p);
                if (oldName) break;
            }
            const isReassign = oldName && oldName !== name && !oldName.startsWith('箱子(');
            if (isReassign) agent.memory_bank.forgetChest(oldName);
            // 清理精确同坐标的占位条目
            for (const p of positions) {
                const ph = `箱子(${p[0]},${p[1]},${p[2]})`;
                if (ph !== name && agent.memory_bank.recallChest(ph)) agent.memory_bank.forgetChest(ph);
            }
            agent.memory_bank.rememberChest(name, purpose || '', null, positions);
            const coordStr = positions.length > 1
                ? positions.map(p => `(${p[0]},${p[1]},${p[2]})`).join('|')
                : `(${pos[0]},${pos[1]},${pos[2]})`;
            let msg = `已记住箱子 "${name}" 于 ${coordStr}，用途：${purpose || '未填'}。要看内容用 !viewChest。`;
            if (isReassign) msg += `（该箱子原记为 "${oldName}"，已改名，勿重复记录。）`;
            skills.log(bot, msg);
        })
    },
    {
        name: '!recallChest',
        description: '回忆之前用 !rememberChest 记过的某个箱子用途和坐标。要看箱子里的东西用 !viewChest。',
        params: { 'name': { type: 'string', description: '箱子的别名。' } },
        perform: async function (agent, name) {
            const c = agent.memory_bank.recallChest(name);
            if (!c) {
                return `没记住过叫 "${name}" 的箱子。用 !savedPlaces 看全部。`;
            }
            let pos = c.pos ? `(${c.pos[0]}, ${c.pos[1]}, ${c.pos[2]})` : '位置未知';
            return `箱子 "${name}" ${pos}，用途：${c.purpose || '未填'}。要看内容用 !viewChest(${c.pos ? `${c.pos[0]}, ${c.pos[1]}, ${c.pos[2]}` : ''})。`;
        }
    },
    {
        name: '!findChest',
        description: '用自然语言匹配最合适的已记箱子。例：!findChest("找点吃的")。',
        params: { 'query': { type: 'string', description: '需求描述。' } },
        perform: async function (agent, query) {
            if (!query) return '请描述你要找什么箱子，例：!findChest("存挖到的矿石")';
            const emb = agent.prompter?.embedding_model || null;
            const matches = await agent.memory_bank.findChestBySemantic(query, emb, 3);
            if (matches.length === 0) {
                return `没有匹配"${query}"的已记箱子。用 !viewNearbyChests 看附近实物箱子，或 !rememberChest 给箱子记用途。`;
            }
            const lines = [`匹配"${query}"的箱子（按相关度排序）：`];
            for (const m of matches) {
                const c = agent.memory_bank.recallChest(m.name);
                const pos = c?.pos ? `(${c.pos[0]},${c.pos[1]},${c.pos[2]})` : '';
                const purpose = (c?.purpose && c.purpose !== '用途未知') ? c.purpose : (c?.suggestedPurpose || '用途未知');
                lines.push(`- ${m.name} ${pos} 用途:${purpose} 相关度:${(m.score * 100).toFixed(0)}%`);
            }
            lines.push(`用箱子名直接操作，例：!putInChest("oak_log", 10, "${matches[0].name}")`);
            return lines.join('\n');
        }
    },
    {
        name: '!rememberNote',
        description: '记录一条简短的自由文本笔记。',
        params: { 'text': { type: 'string', description: '笔记内容。' } },
        perform: async function (agent, text) {
            const ok = agent.memory_bank.addNote(text);
            return ok ? `已记笔记："${text}"` : '笔记为空或已存在。';
        }
    },
    {
        name: '!recallNote',
        description: '查询笔记。不带参数列出全部；带关键词筛选。',
        params: { 'keyword': { type: 'string', description: '关键词。', optional: true } },
        perform: async function (agent, keyword) {
            const notes = agent.memory_bank.recallNotes(keyword || null);
            if (notes.length === 0) return keyword ? `没有含 "${keyword}" 的笔记。` : '还没有笔记。';
            return notes.map(n => `- ${n.text}${n.ts ? ` (${new Date(n.ts).toLocaleString('zh-CN')})` : ''}`).join('\n');
        }
    },
    {
        name: '!rememberFact',
        description: '记录一条永久事实（不会被摘要覆盖）。',
        params: { 'text': { type: 'string', description: '事实内容。' } },
        perform: async function (agent, text) {
            const ok = agent.memory_bank.addFact(text);
            return ok ? `已记永久事实："${text}"` : '事实为空或已存在。';
        }
    },
    {
        name: '!forget',
        description: '删除记忆。支持：place, chest, note, fact, all。',
        params: {
            'kind': { type: 'string', description: '记忆类型。' },
            'keyword': { type: 'string', description: '删除关键词。', optional: true }
        },
        perform: async function (agent, kind, keyword) {
            const mb = agent.memory_bank;
            const kw = keyword || '';
            if (kind === 'place') {
                if (!kw) return '需要关键词。';
                const hit = Object.keys(mb.places).filter(k => k.includes(kw));
                if (hit.length === 0) return `没有匹配 "${kw}" 的地点。`;
                hit.forEach(k => delete mb.places[k]);
                return `已删除地点：${hit.join(', ')}`;
            }
            if (kind === 'chest') {
                if (!kw) return '需要关键词。';
                const hit = Object.keys(mb.chests).filter(k => k.includes(kw));
                if (hit.length === 0) return `没有匹配 "${kw}" 的箱子。`;
                hit.forEach(k => delete mb.chests[k]);
                return `已删除箱子：${hit.join(', ')}`;
            }
            if (kind === 'note') {
                const n = mb.forgetNote(kw || null);
                return n > 0 ? `已删除 ${n} 条笔记。` : '没有匹配的笔记。';
            }
            if (kind === 'fact') {
                const n = mb.forgetFact(kw || null);
                return n > 0 ? `已删除 ${n} 条永久事实。` : '没有匹配的事实。';
            }
            if (kind === 'all') {
                const p = Object.keys(mb.places).length;
                const c = Object.keys(mb.chests).length;
                const nn = mb.notes.length;
                const f = mb.facts.length;
                mb.places = {}; mb.chests = {}; mb.notes = []; mb.facts = [];
                return `已清空所有记忆（${p} 地点, ${c} 箱子, ${nn} 笔记, ${f} 事实）。`;
            }
            return `未知类型 "${kind}"。支持：place / chest / note / fact / all。`;
        }
    },
];
