import minecraftData from 'minecraft-data';
import settings from '../agent/settings.js';
import { createBot } from 'mineflayer';
import prismarine_items from 'prismarine-item';
import { pathfinder } from 'mineflayer-pathfinder';
import { plugin as pvp } from 'mineflayer-pvp';
import { plugin as collectblock } from 'mineflayer-collectblock';
import { plugin as autoEat } from 'mineflayer-auto-eat';
import plugin from 'mineflayer-armor-manager';
const armorManager = plugin;
let mc_version = settings.minecraft_version;
let mcdata = null;
let Item = null;

/**
 * @typedef {string} ItemName
 * @typedef {string} BlockName
*/

export const WOOD_TYPES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'];
export const MATCHING_WOOD_BLOCKS = [
    'log',
    'planks',
    'sign',
    'boat',
    'fence_gate',
    'door',
    'fence',
    'slab',
    'stairs',
    'button',
    'pressure_plate',
    'trapdoor'
]
export const WOOL_COLORS = [
    'white',
    'orange',
    'magenta',
    'light_blue',
    'yellow',
    'lime',
    'pink',
    'gray',
    'light_gray',
    'cyan',
    'purple',
    'blue',
    'brown',
    'green',
    'red',
    'black'
]


export function initBot(username) {
    const options = {
        username: username,
        host: settings.host,
        port: settings.port,
        auth: settings.auth,
        version: mc_version,
        checkTimeoutInterval: 60000,  // 60s keep-alive check (default 30s) — reduces disconnects on slow servers
    }
    if (!mc_version || mc_version === "auto") {
        delete options.version;
    }

    const bot = createBot(options);

    // Throttle position packets to avoid kicks on Paper/Spigot servers
    // Paper enforces stricter packet rate limits than vanilla, causing ECONNRESET
    // when mineflayer sends position updates faster than 50ms apart
    let lastPositionUpdate = 0;
    let pendingPositionPacket = null;
    const POSITION_THROTTLE_MS = 50;
    const originalWrite = bot._client.write.bind(bot._client);
    bot._client.write = function(name, data) {
        if (name === 'position' || name === 'position_look' || name === 'look') {
            const now = Date.now();
            if (now - lastPositionUpdate < POSITION_THROTTLE_MS) {
                // Queue this packet so the last position update is never lost
                if (!pendingPositionPacket) {
                    pendingPositionPacket = setTimeout(() => {
                        pendingPositionPacket = null;
                        lastPositionUpdate = Date.now();
                        originalWrite(name, data);
                    }, POSITION_THROTTLE_MS - (now - lastPositionUpdate));
                }
                return;
            }
            lastPositionUpdate = now;
            if (pendingPositionPacket) {
                clearTimeout(pendingPositionPacket);
                pendingPositionPacket = null;
            }
        }
        return originalWrite(name, data);
    };

    // Suppress PartialReadError for non-critical packets
    // Paper servers sometimes send packets that node-minecraft-protocol
    // can't fully parse (scoreboard, resource_pack, custom_payload, etc.)
    // These errors crash the bot but the packets aren't needed for gameplay
    const originalEmit = bot._client.emit.bind(bot._client);
    bot._client.emit = function(event, ...args) {
        if (event === 'error' && args[0]) {
            const err = args[0];
            const errStr = err instanceof Error ? err.message : String(err);
            if (errStr.includes('PartialReadError')) {
                console.warn('[mcdata] Suppressed PartialReadError:', errStr.substring(0, 120));
                return true; // Swallow the error
            }
        }
        return originalEmit(event, ...args);
    };

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvp);
    bot.loadPlugin(collectblock);
    bot.loadPlugin(autoEat);
    bot.loadPlugin(armorManager); // auto equip armor
    bot.once('resource_pack', () => {
        bot.acceptResourcePack();
    });

    bot.once('login', () => {
        mc_version = bot.version;
        mcdata = minecraftData(mc_version);
        Item = prismarine_items(mc_version);

        // 修复 minecraft-data 上游 bug：1.20.5+ 的方块数据把铁矿石/煤矿石等的
        // material 字段从 "mineable/pickaxe" 错误改成 "incorrect_for_wooden_tool" 等
        // "工具不适配"标签。prismarine-block 的 digTime 用 registry.materials[this.material]
        // 查工具倍率，而 incorrect_for_* 标签下没有工具倍率 → isBestTool 恒 false →
        // blockBreakingSpeed 退回 1（手挖速度）。于是铁镐挖铁矿也算手挖，digTime 从
        // 750ms 膨胀到 4550ms，挖矿慢 6 倍。
        // 修复：patch bot.digTime，遇到 incorrect_for_* material 时，根据方块的
        // harvestTools 工具 id 与各 mineable/* 标签的工具倍率表求交集，还原成正确的
        // mineable/* material 再算 digTime。
        const _origDigTime = bot.digTime.bind(bot);
        const mineableTags = ['mineable/pickaxe', 'mineable/shovel', 'mineable/axe', 'mineable/hoe'];
        // 缓存 incorrect_for_* → 正确 mineable 标签的映射（同版本不变）
        const incorrectMaterialFix = {};
        function resolveMineableMaterial(block) {
            const mat = block.material;
            if (!mat || !mat.startsWith('incorrect_for_')) return null;
            if (incorrectMaterialFix[mat]) return incorrectMaterialFix[mat];
            // harvestTools: {工具id: true}，用这些 id 与各 mineable/* 标签的倍率表求交集
            const harvestIds = block.harvestTools ? Object.keys(block.harvestTools).map(Number) : [];
            let best = null;
            for (const tag of mineableTags) {
                const table = mcdata?.materials?.[tag];
                if (!table) continue;
                const overlap = harvestIds.filter(id => table[id] != null);
                if (overlap.length > 0) { best = tag; break; }
            }
            if (best) incorrectMaterialFix[mat] = best;
            return best;
        }
        bot.digTime = function (block) {
            const fixed = resolveMineableMaterial(block);
            // bot 挖矿几乎都在地面，但 digTime 在 dig 极早期算，onGround 可能刚寻路到位
            // 还在抖动（false），施加 5x 空中惩罚 → digTime 膨胀 5 倍（如铁矿 750→3750ms）。
            // bot 挖矿场景强制按落地算，真正空中挖（搭桥/跳挖）极少且服务端会按真实
            // 状态兜底，不会因 finish 偏早而崩。临时改 onGround 只影响本次 digTime 调用。
            const origOnGround = bot.entity.onGround;
            let patched = false;
            if (!origOnGround) { bot.entity.onGround = true; patched = true; }
            try {
                if (fixed) {
                    const origMat = block.material;
                    block.material = fixed;
                    try { return _origDigTime(block); }
                    finally { block.material = origMat; }
                }
                return _origDigTime(block);
            }             finally {
                if (patched) bot.entity.onGround = origOnGround;
            }
        };

        // 修复 mineflayer creative 插件的槽位死锁 bug：bot.creative.setInventorySlot
        // 抛错（如 makeItem 给了无效物品让 Item.toNotch 崩、或 timeout 5s 未收 ack）
        // 时，内部标志 creativeSlotsUpdates[slot] 不被重置（只有成功路径才在末尾
        // 置 false），导致该槽位后续所有调用立刻 throw "Setting slot N cancelled"，
        // placeBlock 一旦踩雷就再也放不了任何块。这里用自带 try/finally 标志的版本
        // 完全替换它：直接写 set_creative_slot 包 + 等待 updateSlot 事件，拒绝/超时
        // 时都清标志，彻底解死锁。
        if (bot.creative && typeof bot.creative.setInventorySlot === 'function') {
            const slotLocks = {};
            bot.creative.setInventorySlot = async function setInventorySlot (slot, item, waitTimeout = 400) {
                if (slotLocks[slot]) {
                    throw new Error(`Setting slot ${slot} cancelled due to calling bot.creative.setInventorySlot(${slot}, ...) again`);
                }
                slotLocks[slot] = true;
                try {
                    if (item == null) {
                        bot._client.write('set_creative_slot', { slot, item: null });
                        bot._setSlot(slot, null);
                        return;
                    }
                    // Item.toNotch 对无效物品（type=null/0）会崩，先校验。
                    // 注意 prismarine-item 用 item.type 存物品 id，不是 item.id（不存在）。
                    if (item.type == null || item.type <= 0) {
                        throw new Error(`无效物品，无法设槽 ${slot}：${item?.name || item}`);
                    }
                    const notch = Item.toNotch(item);
                    bot._client.write('set_creative_slot', { slot, item: notch });
                    // 本地先反演槽位，让紧接着的 findInventoryItem 不用等服务端 ack 就能拿到
                    if (typeof bot._setSlot === 'function') bot._setSlot(slot, item);
                    // 等服务端回 updateSlot 确认（带超时），收不到也只当慢，不锁死
                    await new Promise((resolve) => {
                        let done = false;
                        const onSlot = (oldItem, newItem) => {
                            if (newItem && newItem.name === item.name && newItem.count === item.count) {
                                if (!done) { done = true; bot.inventory.off(`updateSlot:${slot}`, onSlot); resolve(); }
                            }
                        };
                        bot.inventory.once(`updateSlot:${slot}`, onSlot);
                        setTimeout(() => { if (!done) { done = true; bot.inventory.off(`updateSlot:${slot}`, onSlot); resolve(); } }, waitTimeout);
                    });
                } finally {
                    slotLocks[slot] = false;
                }
            };
        }
    });

    return bot;
}

export function isHuntable(mob) {
    if (!mob || !mob.name) return false;
    const animals = ['chicken', 'cow', 'llama', 'mooshroom', 'pig', 'rabbit', 'sheep'];
    return animals.includes(mob.name.toLowerCase()) && !mob.metadata[16]; // metadata 16 is not baby
}

export function isHostile(mob) {
    if (!mob || !mob.name) return false;
    return  (mob.type === 'mob' || mob.type === 'hostile') && mob.name !== 'iron_golem' && mob.name !== 'snow_golem';
}

/**
 * 当前威胁度评分：数值越大越该优先处理。用于 defendSelf 在一群敌人里
 * 选「现在最该打/最该躲」的目标，而不是无脑打最近的。
 *
 * 评分要素（由高到低权重）：
 *  1. 正在冲刺/即将爆炸的苦力怕      → 1000（必须立刻挡/拉开，否则被炸）
 *  2. 史莱姆/岩浆怪按体型大→小       → 100/35/12（大的伤害高且还在分裂增兵，
 *     优先清掉大怪，避免越打越多）
 *  3. 近距离（≤2.5）贴脸的近战怪     → +150（已经在打 bot 了，比远处那个急）
 *  4. 苦力怕本身                     → +80（即使没冲刺，也比普通怪危险）
 *  5. 亡灵射手（骷髅/流浪者）        → +60（远程持续消耗，不近身也在输出）
 *  6. 其余普通怪基础分 10
 *
 * 史莱姆/岩浆怪同一名字分多种 size，mineflayer 用 metadata 区分体型：
 *  entity.metadata[10]（1.19+ 有的版本改成其他 index，这里兼容性取，取不到就按名字兜底）。
 * 取不到元数据时按名字区分：slime 本身是 size，magma_cube 同理。
 *
 * 返回 0 表示这不是敌对生物（调用方应已用 isHostile 过滤，但仍兜底返回 0）。
 */
export function threatScore(mob) {
    if (!mob || !mob.name) return 0;
    const name = mob.name;

    // 苦力怕冲刺/爆炸判定：metadata[16] 为 1 表示正在引爆（与 pvp checkExplosion 一致）
    let creeperSizzling = false;
    try {
        if (name === 'creeper' && mob.metadata && mob.metadata[16] === 1) {
            creeperSizzling = true;
        }
    } catch (_) { }

    if (creeperSizzling) return 1000;

    let score = 10;

    // 史莱姆 / 岩浆怪按体型加分：大的伤害高且分裂会增兵，先清大的。
    // mineflayer 中 slime/magma_cube 的 size 存在 metadata 里；不同版本 index
    // 不一致，这里多个常见 index 都试，取不到就退一步按“是否带 size 名/经验值”估算。
    if (name === 'slime' || name === 'magma_cube') {
        let size = 1;
        try {
            for (const idx of [8, 10, 14, 16]) {
                const v = mob.metadata?.[idx];
                if (typeof v === 'number' && v >= 0 && v <= 4) { size = v; break; }
            }
        } catch (_) { }
        // size=0/1 是最小档：小史莱姆不掉血且既推不动 bot 也几乎打不动（mc 测试伤害 0），
        // 视为「无害而烦人」。给极低分甚至 0，大幅低于普通怪，避免被这只无害垃圾优先攻击
        // 而错过旁边真实威胁。size=2 中等怪伤害一般，size 3/4 大怪伤害高会分裂增兵。
        score = [0, 2, 35, 100, 120][size] ?? 2;
    }

    // 苦力怕（未冲刺）整体偏高：贴脸也会炸，比普通近战更危险
    if (name === 'creeper') score += 80;

    // 远程输出怪：即便不贴脸也在持续输出（骷髅/流浪者射箭、掠夺者射弩、女巫扔药水）。
    // 优先级必须高于大史莱姆（100）——否则 bot 会去砍大史莱姆而被掠夺者射穿。
    // 基础分 10 + 这里加 120 = 130，稳压大史莱姆的 100。
    // （骷髅马自身不会攻击，是骑它的骷髅在打，故剔除 skeleton_horse。）
    if (name === 'skeleton' || name === 'stray' || name === 'pillager' || name === 'witch') score += 120;

    // 贴脸近战加成：已经在 attack 范围内打 bot 的最急
    let dist = 999;
    try { dist = mob.position?.distanceTo ? mob.position.distanceTo(this?.entity?.position ?? mob.position) : 999; } catch (_) { }
    // 上面的 this 在普通函数调用里不可靠，距离加成改由调用方传入会更准；
    // 但 defendSelf 调用处已有 bot 可用，这里留个兜底：取不到就不加，避免误判。
    return score;
}

/**
 * 给定 bot 和一个敌对实体，返回带距离加成后的威胁分。
 * 调用方已有 bot，比 threatScore 内部更能准确算距离。
 */
export function threatScoreWithBot(bot, mob) {
    let base = threatScore(mob);
    if (!bot || !mob?.position) return base;
    let dist = 999;
    try { dist = mob.position.distanceTo(bot.entity.position); } catch (_) { }
    const rangedMobs = ['skeleton', 'stray', 'pillager', 'witch'];
    const flyingMobs = ['phantom', 'ghast', 'blaze', 'bee'];
    const isRanged = rangedMobs.includes(mob.name);
    const isFlying = flyingMobs.includes(mob.name);
    const isMostlyHarmless = base <= 2; // 小史莱姆等几乎无伤害的怪，不计贴脸加成

    if (dist <= 2.5) base += isMostlyHarmless ? 5 : 150;  // 贴脸近战在打 bot；无伤害的顶多 +5
    else if (dist <= 6) base += isMostlyHarmless ? 2 : 40; // 近距离；无伤害的几乎 +0
    else if (dist >= 12) {
        // 远的怪对普通近战暂时不构成威胁，略微降权；但远程射手/飞行怪即便在 16 格
        // 外也在持续输出/越拖越不利，绝不能降权——否则 bot 在打近战僵尸时被远处
        // 骷髅射穿都不改打目标。对它们保持稳定权重且略升（风筝越久越要脱战去处理）。
        if (isRanged) base += 30;
        else if (isFlying) base += 20;
        else base -= 10;
    }
    return base;
}

// blocks that don't work with collectBlock, need to be manually collected
export function mustCollectManually(blockName) {
    // all crops (that aren't normal blocks), torches, buttons, levers, redstone,
    const full_names = ['wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart', 'cocoa', 'sugar_cane', 'kelp', 'short_grass', 'fern', 'tall_grass', 'bamboo',
        'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'lilac', 'wither_rose', 'lily_of_the_valley', 'wither_rose',
        'lever', 'redstone_wire', 'lantern']
    const partial_names = ['sapling', 'torch', 'button', 'carpet', 'pressure_plate', 'mushroom', 'tulip', 'bush', 'vines', 'fern']
    return full_names.includes(blockName.toLowerCase()) || partial_names.some(partial => blockName.toLowerCase().includes(partial));
}

export function getItemId(itemName) {
    let item = mcdata.itemsByName[itemName];
    if (item) {
        return item.id;
    }
    return null;
}

export function getItemName(itemId) {
    let item = mcdata.items[itemId]
    if (item) {
        return item.name;
    }
    return null;
}

export function getBlockId(blockName) {
    let block = mcdata.blocksByName[blockName];
    if (block) {
        return block.id;
    }
    return null;
}

export function getBlockName(blockId) {
    let block = mcdata.blocks[blockId]
    if (block) {
        return block.name;
    }
    return null;
}

export function getEntityId(entityName) {
    let entity = mcdata.entitiesByName[entityName];
    if (entity) {
        return entity.id;
    }
    return null;
}

export function getAllItems(ignore) {
    if (!ignore) {
        ignore = [];
    }
    let items = []
    for (const itemId in mcdata.items) {
        const item = mcdata.items[itemId];
        if (!ignore.includes(item.name)) {
            items.push(item);
        }
    }
    return items;
}

export function getAllItemIds(ignore) {
    const items = getAllItems(ignore);
    let itemIds = [];
    for (const item of items) {
        itemIds.push(item.id);
    }
    return itemIds;
}

export function getAllBlocks(ignore) {
    if (!ignore) {
        ignore = [];
    }
    let blocks = []
    for (const blockId in mcdata.blocks) {
        const block = mcdata.blocks[blockId];
        if (!ignore.includes(block.name)) {
            blocks.push(block);
        }
    }
    return blocks;
}

export function getAllBlockIds(ignore) {
    const blocks = getAllBlocks(ignore);
    let blockIds = [];
    for (const block of blocks) {
        blockIds.push(block.id);
    }
    return blockIds;
}

export function getAllBiomes() {
    return mcdata.biomes;
}

export function getItemCraftingRecipes(itemName) {
    let itemId = getItemId(itemName);
    if (!mcdata.recipes[itemId]) {
        return null;
    }

    let recipes = [];
    for (let r of mcdata.recipes[itemId]) {
        let recipe = {};
        let ingredients = [];
        if (r.ingredients) {
            ingredients = r.ingredients;
        } else if (r.inShape) {
            ingredients = r.inShape.flat();
        }
        for (let ingredient of ingredients) {
            let ingredientName = getItemName(ingredient);
            if (ingredientName === null) continue;
            if (!recipe[ingredientName])
                recipe[ingredientName] = 0;
            recipe[ingredientName]++;
        }
        recipes.push([
            recipe,
            {craftedCount : r.result.count}
        ]);
    }
    // sort recipes by if their ingredients include common items
    const commonItems = ['oak_planks', 'oak_log', 'coal', 'cobblestone'];
    recipes.sort((a, b) => {
        let commonCountA = Object.keys(a[0]).filter(key => commonItems.includes(key)).reduce((acc, key) => acc + a[0][key], 0);
        let commonCountB = Object.keys(b[0]).filter(key => commonItems.includes(key)).reduce((acc, key) => acc + b[0][key], 0);
        return commonCountB - commonCountA;
    });

    return recipes;
}

export function isSmeltable(itemName) {
    const misc_smeltables = ['beef', 'chicken', 'cod', 'mutton', 'porkchop', 'rabbit', 'salmon', 'tropical_fish', 'potato', 'kelp', 'sand', 'cobblestone', 'clay_ball'];
    return itemName.includes('raw') || itemName.includes('log') || misc_smeltables.includes(itemName);
}

export function getSmeltingFuel(bot) {
    let fuel = bot.inventory.items().find(i => i.name === 'coal' || i.name === 'charcoal' || i.name === 'blaze_rod')
    if (fuel)
        return fuel;
    fuel = bot.inventory.items().find(i => i.name.includes('log') || i.name.includes('planks'))
    if (fuel)
        return fuel;
    return bot.inventory.items().find(i => i.name === 'coal_block' || i.name === 'lava_bucket');
}

export function getFuelSmeltOutput(fuelName) {
    if (fuelName === 'coal' || fuelName === 'charcoal')
        return 8;
    if (fuelName === 'blaze_rod')
        return 12;
    if (fuelName.includes('log') || fuelName.includes('planks'))
        return 1.5
    if (fuelName === 'coal_block')
        return 80;
    if (fuelName === 'lava_bucket')
        return 100;
    return 0;
}

export function getItemSmeltingIngredient(itemName) {
    return {    
        baked_potato: 'potato',
        steak: 'raw_beef',
        cooked_chicken: 'raw_chicken',
        cooked_cod: 'raw_cod',
        cooked_mutton: 'raw_mutton',
        cooked_porkchop: 'raw_porkchop',
        cooked_rabbit: 'raw_rabbit',
        cooked_salmon: 'raw_salmon',
        dried_kelp: 'kelp',
        iron_ingot: 'raw_iron',
        gold_ingot: 'raw_gold',
        copper_ingot: 'raw_copper',
        glass: 'sand'
    }[itemName];
}

export function getItemBlockSources(itemName) {
    let itemId = getItemId(itemName);
    let sources = [];
    for (let block of getAllBlocks()) {
        if (block.drops.includes(itemId)) {
            sources.push(block.name);
        }
    }
    return sources;
}

export function getItemAnimalSource(itemName) {
    return {    
        raw_beef: 'cow',
        raw_chicken: 'chicken',
        raw_cod: 'cod',
        raw_mutton: 'sheep',
        raw_porkchop: 'pig',
        raw_rabbit: 'rabbit',
        raw_salmon: 'salmon',
        leather: 'cow',
        wool: 'sheep'
    }[itemName];
}

export function getBlockTool(blockName) {
    let block = mcdata.blocksByName[blockName];
    if (!block || !block.harvestTools) {
        return null;
    }
    return getItemName(Object.keys(block.harvestTools)[0]);  // Double check first tool is always simplest
}

export function makeItem(name, amount=1) {
    return new Item(getItemId(name), amount);
}

/**
 * Returns the number of ingredients required to use the recipe once.
 * 
 * @param {Recipe} recipe
 * @returns {Object<mc.ItemName, number>} an object describing the number of each ingredient.
 */
export function ingredientsFromPrismarineRecipe(recipe) {
    let requiredIngedients = {};
    if (recipe.inShape)
        for (const ingredient of recipe.inShape.flat()) {
            if(ingredient.id<0) continue; //prismarine-recipe uses id -1 as an empty crafting slot
            const ingredientName = getItemName(ingredient.id);
            requiredIngedients[ingredientName] ??=0;
            requiredIngedients[ingredientName] += ingredient.count;
        }
    if (recipe.ingredients)
        for (const ingredient of recipe.ingredients) {
            if(ingredient.id<0) continue;
            const ingredientName = getItemName(ingredient.id);
            requiredIngedients[ingredientName] ??=0;
            requiredIngedients[ingredientName] -= ingredient.count;
            //Yes, the `-=` is intended.
            //prismarine-recipe uses positive numbers for the shaped ingredients but negative for unshaped.
            //Why this is the case is beyond my understanding.
        }
    return requiredIngedients;
}

/**
 * Calculates the number of times an action, such as a crafing recipe, can be completed before running out of resources.
 * @template T - doesn't have to be an item. This could be any resource.
 * @param {Object.<T, number>} availableItems - The resources available; e.g, `{'cobble_stone': 7, 'stick': 10}`
 * @param {Object.<T, number>} requiredItems - The resources required to complete the action once; e.g, `{'cobble_stone': 3, 'stick': 2}`
 * @param {boolean} discrete - Is the action discrete?
 * @returns {{num: number, limitingResource: (T | null)}} the number of times the action can be completed and the limmiting resource; e.g `{num: 2, limitingResource: 'cobble_stone'}`
 */
export function calculateLimitingResource(availableItems, requiredItems, discrete=true) {
    let limitingResource = null;
    let num = Infinity;
    for (const itemType in requiredItems) {
        if (availableItems[itemType] < requiredItems[itemType] * num) {
            limitingResource = itemType;
            num = availableItems[itemType] / requiredItems[itemType];
        }
    }
    if(discrete) num = Math.floor(num);
    return {num, limitingResource}
}

let loopingItems = new Set();

export function initializeLoopingItems() {

    loopingItems = new Set(['coal',
        'wheat',
        'bone_meal',
        'diamond',
        'emerald',
        'raw_iron',
        'raw_gold',
        'redstone',
        'blue_wool',
        'packed_mud',
        'raw_copper',
        'iron_ingot',
        'dried_kelp',
        'gold_ingot',
        'slime_ball',
        'black_wool',
        'quartz_slab',
        'copper_ingot',
        'lapis_lazuli',
        'honey_bottle',
        'rib_armor_trim_smithing_template',
        'eye_armor_trim_smithing_template',
        'vex_armor_trim_smithing_template',
        'dune_armor_trim_smithing_template',
        'host_armor_trim_smithing_template',
        'tide_armor_trim_smithing_template',
        'wild_armor_trim_smithing_template',
        'ward_armor_trim_smithing_template',
        'coast_armor_trim_smithing_template',
        'spire_armor_trim_smithing_template',
        'snout_armor_trim_smithing_template',
        'shaper_armor_trim_smithing_template',
        'netherite_upgrade_smithing_template',
        'raiser_armor_trim_smithing_template',
        'sentry_armor_trim_smithing_template',
        'silence_armor_trim_smithing_template',
        'wayfinder_armor_trim_smithing_template']);
}


/**
 * Gets a detailed plan for crafting an item considering current inventory
 */
export function getDetailedCraftingPlan(targetItem, count = 1, current_inventory = {}) {
    initializeLoopingItems();
    if (!targetItem || count <= 0 || !getItemId(targetItem)) {
        return "Invalid input. Please provide a valid item name and positive count.";
    }

    if (isBaseItem(targetItem)) {
        const available = current_inventory[targetItem] || 0;
        if (available >= count) return "You have all required items already in your inventory!";
        return `${targetItem} is a base item, you need to find ${count - available} more in the world`;
    }

    const inventory = { ...current_inventory };
    const leftovers = {};
    const plan = craftItem(targetItem, count, inventory, leftovers);
    return formatPlan(targetItem, plan);
}

function isBaseItem(item) {
    return loopingItems.has(item) || getItemCraftingRecipes(item) === null;
}

function craftItem(item, count, inventory, leftovers, crafted = { required: {}, steps: [], leftovers: {} }) {
    // Check available inventory and leftovers first
    const availableInv = inventory[item] || 0;
    const availableLeft = leftovers[item] || 0;
    const totalAvailable = availableInv + availableLeft;

    if (totalAvailable >= count) {
        // Use leftovers first, then inventory
        const useFromLeft = Math.min(availableLeft, count);
        leftovers[item] = availableLeft - useFromLeft;
        
        const remainingNeeded = count - useFromLeft;
        if (remainingNeeded > 0) {
            inventory[item] = availableInv - remainingNeeded;
        }
        return crafted;
    }

    // Use whatever is available
    const stillNeeded = count - totalAvailable;
    if (availableLeft > 0) leftovers[item] = 0;
    if (availableInv > 0) inventory[item] = 0;

    if (isBaseItem(item)) {
        crafted.required[item] = (crafted.required[item] || 0) + stillNeeded;
        return crafted;
    }

    const recipe = getItemCraftingRecipes(item)?.[0];
    if (!recipe) {
        crafted.required[item] = stillNeeded;
        return crafted;
    }

    const [ingredients, result] = recipe;
    const craftedPerRecipe = result.craftedCount;
    const batchCount = Math.ceil(stillNeeded / craftedPerRecipe);
    const totalProduced = batchCount * craftedPerRecipe;

    // Add excess to leftovers
    if (totalProduced > stillNeeded) {
        leftovers[item] = (leftovers[item] || 0) + (totalProduced - stillNeeded);
    }

    // Process each ingredient
    for (const [ingredientName, ingredientCount] of Object.entries(ingredients)) {
        const totalIngredientNeeded = ingredientCount * batchCount;
        craftItem(ingredientName, totalIngredientNeeded, inventory, leftovers, crafted);
    }

    // Add crafting step
    const stepIngredients = Object.entries(ingredients)
        .map(([name, amount]) => `${amount * batchCount} ${name}`)
        .join(' + ');
    crafted.steps.push(`Craft ${stepIngredients} -> ${totalProduced} ${item}`);

    return crafted;
}

function formatPlan(targetItem, { required, steps, leftovers }) {
    const lines = [];

    if (Object.keys(required).length > 0) {
        lines.push('You are missing the following items:');
        Object.entries(required).forEach(([item, count]) => 
            lines.push(`- ${count} ${item}`));
        lines.push('\nOnce you have these items, here\'s your crafting plan:');
    } else {
        lines.push('You have all items required to craft this item!');
        lines.push('Here\'s your crafting plan:');
    }

    lines.push('');
    lines.push(...steps);

    if (Object.keys(required).some(item => item.includes('oak')) && !targetItem.includes('oak')) {
        lines.push('Note: Any varient of wood can be used for this recipe.');
    }

    if (Object.keys(leftovers).length > 0) {
        lines.push('\nYou will have leftover:');
        Object.entries(leftovers).forEach(([item, count]) => 
            lines.push(`- ${count} ${item}`));
    }

    return lines.join('\n');
}
