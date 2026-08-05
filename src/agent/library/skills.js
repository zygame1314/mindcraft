import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../settings.js";

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;

// 玩家常见建筑方块：导航（goToGoal 破坏性 fallback）和脱困（unstuck 模式）
// 挖障碍时都应跳过这些方块，避免 bot 把玩家家的墙/屋顶/装饰挖穿脱困。
// 自然地形（泥土/石头/沙子/矿石等）不在此列，仍可挖以脱困。
export const protectedBuildingBlocks = [
    // 木板与原木（墙体）
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
    'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks',
    'crimson_planks', 'warped_planks',
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
    'mangrove_log', 'cherry_log', 'bamboo', 'crimson_stem', 'warped_stem',
    'stripped_oak_log', 'stripped_spruce_log', 'stripped_birch_log', 'stripped_jungle_log',
    'stripped_acacia_log', 'stripped_cherry_log', 'stripped_dark_oak_log',
    'stripped_mangrove_log', 'stripped_crimson_stem', 'stripped_warped_stem',
    // 石砖与建筑石材（含深板岩砖，玩家常用于建房）
    'stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'chiseled_stone_bricks',
    'deepslate_bricks', 'cracked_deepslate_bricks', 'nether_bricks', 'red_nether_bricks',
    'mud_bricks', 'end_stone_bricks', 'quartz_bricks', 'sandstone', 'cut_sandstone',
    'red_sandstone', 'cut_red_sandstone', 'bricks', 'polished_blackstone_bricks',
    // 楼梯/台阶/墙/栅栏（建筑构件）
    'stone_stairs', 'cobblestone_stairs', 'stone_brick_stairs', 'mossy_stone_brick_stairs',
    'cobblestone_wall', 'stone_brick_wall', 'mossy_cobblestone_wall', 'brick_wall',
    'oak_fence', 'spruce_fence', 'birch_fence', 'jungle_fence', 'acacia_fence',
    'dark_oak_fence', 'mangrove_fence', 'cherry_fence', 'bamboo_fence',
    'crimson_fence', 'warped_fence', 'nether_brick_fence',
    'oak_slab', 'spruce_slab', 'birch_slab', 'jungle_slab', 'acacia_slab',
    'dark_oak_slab', 'mangrove_slab', 'cherry_slab', 'bamboo_slab',
    'crimson_slab', 'warped_slab', 'stone_slab', 'smooth_stone_slab',
    'cobblestone_slab', 'stone_brick_slab', 'brick_slab',
    // 装饰/功能性方块
    'glass', 'glass_pane', 'tinted_glass',
    'white_wool', 'orange_wool', 'magenta_wool', 'light_blue_wool', 'yellow_wool',
    'lime_wool', 'pink_wool', 'gray_wool', 'light_gray_wool', 'cyan_wool',
    'purple_wool', 'blue_wool', 'brown_wool', 'green_wool', 'red_wool', 'black_wool',
    'terracotta', 'white_terracotta', 'orange_terracotta', 'magenta_terracotta',
    'light_blue_terracotta', 'yellow_terracotta', 'lime_terracotta', 'pink_terracotta',
    'gray_terracotta', 'light_gray_terracotta', 'cyan_terracotta', 'purple_terracotta',
    'blue_terracotta', 'brown_terracotta', 'green_terracotta', 'red_terracotta',
    'black_terracotta',
    'white_concrete', 'orange_concrete', 'magenta_concrete', 'light_blue_concrete',
    'yellow_concrete', 'lime_concrete', 'pink_concrete', 'gray_concrete',
    'light_gray_concrete', 'cyan_concrete', 'purple_concrete', 'blue_concrete',
    'brown_concrete', 'green_concrete', 'red_concrete', 'black_concrete',
    'white_carpet', 'orange_carpet', 'magenta_carpet', 'light_blue_carpet',
    'yellow_carpet', 'lime_carpet', 'pink_carpet', 'gray_carpet', 'light_gray_carpet',
    'cyan_carpet', 'purple_carpet', 'blue_carpet', 'brown_carpet', 'green_carpet',
    'red_carpet', 'black_carpet',
    'bookshelf', 'chiseled_bookshelf', 'crafting_table', 'furnace', 'blast_furnace',
    'lantern', 'soul_lantern', 'torch', 'wall_torch', 'jack_o_lantern', 'sea_lantern',
    'flower_pot', 'bedrock',
];

// 解析为方块 id 集合，供 unstuck 等模块按 type 快速判断是否受保护。
// 懒加载：只在首次访问时解析一次，避免模块加载期 mcdata 未就绪。
let _protectedBlockIdSet = null;
export function getProtectedBlockIds() {
    if (_protectedBlockIdSet === null) {
        _protectedBlockIdSet = new Set();
        for (const name of protectedBuildingBlocks) {
            const id = mc.getBlockId(name);
            if (id != null) _protectedBlockIdSet.add(id);
        }
    }
    return _protectedBlockIdSet;
}

export function log(bot, message) {
    bot.output += message + '\n';
}

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) { return false; }
    }
    return false;
}

async function equipHighestAttack(bot) {
    let weapons = bot.inventory.items().filter(item => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter(item => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return;
    // 攻速表（取自 mineflayer-pvp 的 AttackSpeeds.json）
    const attackSpeeds = {
        wooden_sword: 1.6, golden_sword: 1.6, stone_sword: 1.6, iron_sword: 1.6,
        diamond_sword: 1.6, netherite_sword: 1.6, trident: 1.1,
        wooden_shovel: 1.0, golden_shovel: 1.0, stone_shovel: 1.0, iron_shovel: 1.0,
        diamond_shovel: 1.0, netherite_shovel: 1.0,
        wooden_pickaxe: 1.2, golden_pickaxe: 1.2, stone_pickaxe: 1.2, iron_pickaxe: 1.2,
        diamond_pickaxe: 1.2, netherite_pickaxe: 1.2,
        wooden_axe: 0.8, golden_axe: 1.0, stone_axe: 0.8, iron_axe: 0.9,
        diamond_axe: 1.0, netherite_axe: 1.0,
        other: 4.0
    };
    const getSpeed = name => attackSpeeds[name] ?? attackSpeeds.other;
    // 按 DPS（单次伤害 × 攻速）排序；同 DPS 时优先剑（攻速快、不浪费工具耐久）
    weapons.sort((a, b) => {
        const dpsA = (a.attackDamage ?? 1) * getSpeed(a.name);
        const dpsB = (b.attackDamage ?? 1) * getSpeed(b.name);
        if (Math.abs(dpsB - dpsA) > 0.01) return dpsB - dpsA;
        const aSword = a.name.includes('sword') ? 1 : 0;
        const bSword = b.name.includes('sword') ? 1 : 0;
        return bSword - aSword;
    });
    let weapon = weapons[0];
    if (weapon)
        await bot.equip(weapon, 'hand');
}

// --- 盾牌格挡辅助 ---
// mineflayer-pvp 自带盾牌逻辑：每次 attack 前自动 deactivateItem、攻击后自动
// activateItem(true) 重新举盾（PVP.js attemptAttack）；苦力怕爆炸时 checkExplosion
// 会自动举盾 2s 并跳过攻击。所以这里【不要】在战斗循环里反复 activate/deactivate，
// 否则时序和 pvp 的 TaskQueue 错位——pvp 攻击前刚松盾、我们却又举上，导致攻击瞬间
// 仍处于格挡状态而打不出伤害；pvp 攻击后刚举盾、我们却又放下，导致没有格挡窗口。
// 我们只负责：战前装备盾牌、开战主动举一次盾（覆盖从开始到首次 attack 的空窗）、
// 战斗结束 deactivateItem 松盾（pvp.stop() 不会自动松盾，不松会一直减速）。
async function equipShield(bot) {
    const OFF_HAND_SLOT = 45;
    const off = bot.inventory.slots[OFF_HAND_SLOT];
    if (off && off.name.includes('shield')) return true;
    const shield = bot.inventory.items().find(item => item.name.includes('shield'));
    if (!shield) return false;
    try { await bot.equip(shield, 'off-hand'); return true; } catch (_) { return false; }
}

function raiseShield(bot) {
    try { bot.activateItem(true); } catch (_) { } // true = 副手，盾牌进入格挡
}

function lowerShield(bot) {
    try { bot.deactivateItem(); } catch (_) { } // 松开，停止格挡
}

export async function craftRecipe(bot, itemName, num = 1) {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    let placedTable = false;

    if (mc.getItemCraftingRecipes(itemName).length == 0) {
        log(bot, `${itemName} 不是物品，或者没有合成配方！`);
        return false;
    }

    // get recipes that don't require a crafting table
    let recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, null);
    let craftingTable = null;
    const craftingTableRange = 16;
    placeTable: if (!recipes || recipes.length === 0) {
        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, true);
        if (!recipes || recipes.length === 0) break placeTable; //Don't bother going to the table if we don't have the required resources.

        // Look for crafting table
        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null) {

            // Try to place crafting table
            let hasTable = world.getInventoryCounts(bot)['crafting_table'] > 0;
            if (hasTable) {
                let pos = world.getNearestFreeSpace(bot, 1, 6);
                await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                if (craftingTable) {
                    recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
                    placedTable = true;
                }
            }
            else {
                log(bot, `合成 ${itemName} 需要工作台。`)
                return false;
            }
        }
        else {
            recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
        }
    }
    if (!recipes || recipes.length === 0) {
        log(bot, `你没有足够的资源合成 ${itemName}。需要: ${Object.entries(mc.getItemCraftingRecipes(itemName)[0][0]).map(([key, value]) => `${key}: ${value}`).join(', ')}。`);
        if (placedTable) {
            await collectBlock(bot, 'crafting_table', 1);
        }
        return false;
    }

    if (craftingTable && bot.entity.position.distanceTo(craftingTable.position) > 4) {
        const reached = await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
        // 重新获取工作台方块（导航过程中可能已被破坏或位置变化）
        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (!reached || !craftingTable || bot.entity.position.distanceTo(craftingTable.position) > 4.5) {
            log(bot, `无法到达工作台，合成 ${itemName} 失败。`);
            if (placedTable) {
                try { await collectBlock(bot, 'crafting_table', 1); } catch (_) { }
            }
            return false;
        }
    }

    const recipe = recipes[0];
    console.log('crafting...');
    //Check that the agent has sufficient items to use the recipe `num` times.
    const inventory = world.getInventoryCounts(bot); //Items in the agents inventory
    const requiredIngredients = mc.ingredientsFromPrismarineRecipe(recipe); //Items required to use the recipe once.
    const craftLimit = mc.calculateLimitingResource(inventory, requiredIngredients);

    if (craftLimit.num <= 0) {
        log(bot, `材料不足，无法合成 ${itemName}。缺少: ${requiredIngredients.map(i => `${i.name} x${i.count}`).join(', ')}。`);
        if (placedTable) {
            try { await collectBlock(bot, 'crafting_table', 1); } catch (_) { }
        }
        return false;
    }

    await bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable);
    if (craftLimit.num < num) log(bot, `${craftLimit.limitingResource} 不够合成 ${num} 个，只合成了 ${craftLimit.num} 个。你现在有 ${world.getInventoryCounts(bot)[itemName]} 个 ${itemName}。`);
    else log(bot, `成功合成了 ${itemName}，你现在有 ${world.getInventoryCounts(bot)[itemName]} 个 ${itemName}。`);
    if (placedTable) {
        await collectBlock(bot, 'crafting_table', 1);
    }

    //Equip any armor the bot may have crafted.
    //There is probablly a more efficient method than checking the entire inventory but this is all mineflayer-armor-manager provides. :P
    bot.armorManager.equipAll();

    return true;
}

export async function wait(bot, milliseconds) {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    let startTime = Date.now();

    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;

        let waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));

        let elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}

export async function smeltItem(bot, itemName, num = 1) {
    /**
     * Puts 1 coal in furnace and smelts the given item name, waits until the furnace runs out of fuel or input items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to smelt. Ores must contain "raw" like raw_iron.
     * @param {number} num, the number of items to smelt. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was smelted, false otherwise. Fail
     * @example
     * await skills.smeltItem(bot, "raw_iron");
     * await skills.smeltItem(bot, "beef");
     **/

    if (!mc.isSmeltable(itemName)) {
        log(bot, `无法冶炼 ${itemName}。提示：确保你在冶炼的是'生'物品。`);
        return false;
    }

    // auto-eat 插件等可能把要冶炼的物品留在副手(slot 45)，而熔炉的
    // putInput/putFuel 通过 bot.transfer 在熔炉窗口的玩家背包范围内查找物品，
    // 副手不在该范围内，会导致"找不到物品"而冶炼失败。先把副手清回主背包。
    const OFF_HAND_SLOT = 45;
    const offHand = bot.inventory.slots[OFF_HAND_SLOT];
    if (offHand && (offHand.name === itemName || mc.getItemId(itemName) === offHand.type)) {
        await bot.unequip('off-hand');
    }

    let placedFurnace = false;
    let furnaceBlock = undefined;
    const furnaceRange = 16;
    furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock) {
        // Try to place furnace
        let hasFurnace = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            let pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
            await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
            furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
            placedFurnace = true;
        }
    }
    if (!furnaceBlock) {
        log(bot, `附近没有熔炉，你也没有熔炉。`)
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        const reached = await goToNearestBlock(bot, 'furnace', 4, furnaceRange);
        furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
        if (!reached || !furnaceBlock || bot.entity.position.distanceTo(furnaceBlock.position) > 4.5) {
            log(bot, `无法到达熔炉，冶炼 ${itemName} 失败。`);
            if (placedFurnace) {
                try { await collectBlock(bot, 'furnace', 1); } catch (_) { }
            }
            return false;
        }
    }
    bot.modes.pause('unstuck');
    await bot.lookAt(furnaceBlock.position);

    console.log('smelting...');
    const furnace = await bot.openFurnace(furnaceBlock);
    // check if the furnace is already smelting something
    let input_item = furnace.inputItem();
    if (input_item && input_item.type !== mc.getItemId(itemName) && input_item.count > 0) {
        // TODO: check if furnace is currently burning fuel. furnace.fuel is always null, I think there is a bug.
        // This only checks if the furnace has an input item, but it may not be smelting it and should be cleared.
        log(bot, `熔炉正在冶炼 ${mc.getItemName(input_item.type)}。`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }
    // check if the bot has enough items to smelt
    let inv_counts = world.getInventoryCounts(bot);
    if (!inv_counts[itemName] || inv_counts[itemName] < num) {
        log(bot, `你没有足够的 ${itemName} 来冶炼。`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }

    // fuel the furnace
    if (!furnace.fuelItem()) {
        let fuel = mc.getSmeltingFuel(bot);
        if (!fuel) {
            log(bot, `你没有燃料来冶炼 ${itemName}，需要煤炭、木炭或木头。`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        log(bot, `使用 ${fuel.name} 作为燃料。`);

        const put_fuel = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));

        if (fuel.count < put_fuel) {
            log(bot, `你没有足够的 ${fuel.name} 来冶炼 ${num} 个 ${itemName}；需要 ${put_fuel}。`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        await furnace.putFuel(fuel.type, null, put_fuel);
        log(bot, `向熔炉添加了 ${put_fuel} 个 ${mc.getItemName(fuel.type)} 作为燃料。`);
        console.log(`Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`)
    }
    // put the items in the furnace
    await furnace.putInput(mc.getItemId(itemName), null, num);
    // wait for the items to smelt
    let total = 0;
    let smelted_item = null;
    await new Promise(resolve => setTimeout(resolve, 200));
    let last_collected = Date.now();
    while (total < num) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (furnace.outputItem()) {
            smelted_item = await furnace.takeOutput();
            if (smelted_item) {
                total += smelted_item.count;
                last_collected = Date.now();
            }
        }
        if (Date.now() - last_collected > 11000) {
            break; // if nothing has been collected in 11 seconds, stop
        }
        if (bot.interrupt_code) {
            break;
        }
    }
    // take all remaining in input/fuel slots
    if (furnace.inputItem()) {
        await furnace.takeInput();
    }
    if (furnace.fuelItem()) {
        await furnace.takeFuel();
    }

    await bot.closeWindow(furnace);

    if (placedFurnace) {
        await collectBlock(bot, 'furnace', 1);
    }
    if (total === 0) {
        log(bot, `冶炼 ${itemName} 失败。`);
        return false;
    }
    if (total < num) {
        log(bot, `只冶炼了 ${total} 个 ${mc.getItemName(smelted_item.type)}。`);
        return false;
    }
    log(bot, `成功冶炼了 ${itemName}，获得了 ${total} 个 ${mc.getItemName(smelted_item.type)}。`);
    return true;
}

export async function clearNearestFurnace(bot) {
    /**
     * Clears the nearest furnace of all items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the furnace was cleared, false otherwise.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    let furnaceBlock = world.getNearestBlock(bot, 'furnace', 32);
    if (!furnaceBlock) {
        log(bot, `附近没有熔炉可以清空。`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, 32);
    }

    console.log('clearing furnace...');
    const furnace = await bot.openFurnace(furnaceBlock);
    console.log('opened furnace...')
    // take the items out of the furnace
    let smelted_item, intput_item, fuel_item;
    if (furnace.outputItem())
        smelted_item = await furnace.takeOutput();
    if (furnace.inputItem())
        intput_item = await furnace.takeInput();
    if (furnace.fuelItem())
        fuel_item = await furnace.takeFuel();
    console.log(smelted_item, intput_item, fuel_item)
    let smelted_name = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
    let input_name = intput_item ? `${intput_item.count} ${intput_item.name}` : `0 input items`;
    let fuel_name = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
    log(bot, `清空了熔炉，获得了 ${smelted_name}、${input_name} 和 ${fuel_name}。`);
    return true;

}


// --- 铁砧辅助 ---
// 找到附近铁砧方块并导航过去；若附近没有但背包里有铁砧，则放置一个并使用。
// 返回打开后的 Anvil 句柄；失败返回 null。调用方负责关闭窗口。
async function openAnvilNearby(bot) {
    const anvilRange = 16;
    let anvilBlock = world.getNearestBlock(bot, 'anvil', anvilRange);
    let placedAnvil = false;
    if (!anvilBlock) {
        let hasAnvil = world.getInventoryCounts(bot)['anvil'] > 0;
        if (hasAnvil) {
            let pos = world.getNearestFreeSpace(bot, 1, anvilRange);
            await placeBlock(bot, 'anvil', pos.x, pos.y, pos.z);
            anvilBlock = world.getNearestBlock(bot, 'anvil', anvilRange);
            placedAnvil = true;
        }
    }
    if (!anvilBlock) {
        log(bot, `附近没有铁砧，你也没有铁砧。`);
        return null;
    }
    if (bot.entity.position.distanceTo(anvilBlock.position) > 4) {
        const reached = await goToNearestBlock(bot, 'anvil', 4, anvilRange);
        anvilBlock = world.getNearestBlock(bot, 'anvil', anvilRange);
        if (!reached || !anvilBlock || bot.entity.position.distanceTo(anvilBlock.position) > 4.5) {
            log(bot, `无法到达铁砧。`);
            if (placedAnvil) { try { await collectBlock(bot, 'anvil', 1); } catch (_) { } }
            return null;
        }
    }
    bot.modes.pause('unstuck');
    await bot.lookAt(anvilBlock.position);
    try {
        const anvil = await bot.openAnvil(anvilBlock);
        return { anvil, anvilBlock, placedAnvil };
    } catch (err) {
        bot.modes.unpause('unstuck');
        log(bot, `打开铁砧失败：${err}。`);
        if (placedAnvil) { try { await collectBlock(bot, 'anvil', 1); } catch (_) { } }
        return null;
    }
}

export async function combineItemsAtAnvil(bot, itemOneName, itemTwoName, newName = null) {
    /**
     * Combine two items at an anvil. Used to repair tools/armor (e.g. two damaged pickaxes combine into one with more durability) or to merge enchantments from a book/enchanted item onto another item. Requires an anvil nearby (or one in the inventory to place).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemOneName, the target item to repair/merge onto.
     * @param {string} itemTwoName, the sacrifice item (same type for repair, or enchanted_book to transfer enchantments).
     * @param {string} newName, optional new name to give the result item.
     * @returns {Promise<boolean>} true if the items were combined, false otherwise.
     * @example
     * await skills.combineItemsAtAnvil(bot, "diamond_pickaxe", "diamond_pickaxe");
     * await skills.combineItemsAtAnvil(bot, "diamond_sword", "enchanted_book");
     * await skills.combineItemsAtAnvil(bot, "diamond_pickaxe", "diamond_pickaxe", "Super Pick");
     **/
    const itemOne = bot.inventory.findInventoryItem(itemOneName);
    if (!itemOne) {
        log(bot, `你没有 ${itemOneName} 可以在铁砧上组合。`);
        return false;
    }
    const itemTwo = bot.inventory.findInventoryItem(itemTwoName);
    if (!itemTwo) {
        log(bot, `你没有 ${itemTwoName} 作为第二个物品。`);
        return false;
    }

    const opened = await openAnvilNearby(bot);
    if (!opened) return false;
    const { anvil, anvilBlock, placedAnvil } = opened;
    try {
        await anvil.combine(itemOne, itemTwo, newName ?? undefined);
        log(bot, `成功在铁砧 ${posStr(anvilBlock.position)} 上组合了 ${itemOneName} 和 ${itemTwoName}${newName ? `，并重命名为 "${newName}"` : ''}。`);
        return true;
    } catch (err) {
        log(bot, `在铁砧上组合 ${itemOneName} 和 ${itemTwoName} 失败：${err}。可能需要更多经验等级。`);
        return false;
    } finally {
        try { await bot.closeWindow(anvil); } catch (_) { }
        bot.modes.unpause('unstuck');
        if (placedAnvil) { try { await collectBlock(bot, 'anvil', 1); } catch (_) { } }
    }
}

export async function renameItemAtAnvil(bot, itemName, newName) {
    /**
     * Rename an item at an anvil. Costs experience levels.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to rename.
     * @param {string} newName, the new name to give the item.
     * @returns {Promise<boolean>} true if the item was renamed, false otherwise.
     * @example
     * await skills.renameItemAtAnvil(bot, "diamond_sword", "Excalibur");
     **/
    const item = bot.inventory.findInventoryItem(itemName);
    if (!item) {
        log(bot, `你没有 ${itemName} 可以重命名。`);
        return false;
    }
    if (!newName) {
        log(bot, `新名字不能为空。`);
        return false;
    }
    const opened = await openAnvilNearby(bot);
    if (!opened) return false;
    const { anvil, anvilBlock, placedAnvil } = opened;
    try {
        await anvil.rename(item, newName);
        log(bot, `成功在铁砧 ${posStr(anvilBlock.position)} 上把 ${itemName} 重命名为 "${newName}"。`);
        return true;
    } catch (err) {
        log(bot, `重命名 ${itemName} 失败：${err}。可能需要更多经验等级。`);
        return false;
    } finally {
        try { await bot.closeWindow(anvil); } catch (_) { }
        bot.modes.unpause('unstuck');
        if (placedAnvil) { try { await collectBlock(bot, 'anvil', 1); } catch (_) { } }
    }
}


export async function attackNearest(bot, mobType, kill = true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    bot.modes.pause('cowardice');
    if (mobType === 'drowned' || mobType === 'cod' || mobType === 'salmon' || mobType === 'tropical_fish' || mobType === 'squid')
        bot.modes.pause('self_preservation'); // so it can go underwater. TODO: have an drowning mode so we don't turn off all self_preservation
    const mob = world.getNearbyEntities(bot, 24).find(entity => entity.name === mobType);
    if (mob) {
        return await attackEntity(bot, mob, kill);
    }
    log(bot, '附近没有找到 ' + mobType + ' 可以攻击。');
    return false;
}

// auto-eat（mineflayer-auto-eat）会在任意 tick 触发，打架时它调用
// bot.activateItem 吃食物会抢断 mineflayer-pvp 的攻击节拍：pvp 用
// activateItem/deactivateItem 控盾，同时举盾又吃食物会让攻击瞬间手持
// 食物而非武器、漏掉攻击节拍。所以在 pvp 进行期间临时 disable，
// 结束后恢复。饥饿值不会因为这几秒暴涨，回来再吃即可。
function pauseAutoEat(bot) {
    if (bot.autoEat && !bot.autoEat.disabled) {
        bot.autoEat.disable();
        return true;
    }
    return false;
}
function resumeAutoEat(bot, wasEnabled) {
    if (wasEnabled && bot.autoEat && bot.autoEat.disabled) {
        bot.autoEat.enable();
    }
}

export async function attackEntity(bot, entity, kill = true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    let pos = entity.position;
    await equipHighestAttack(bot);
    const hasShield = await equipShield(bot);

    if (!kill) {
        const ate = pauseAutoEat(bot);
        try {
            if (bot.entity.position.distanceTo(pos) > 5) {
                console.log('moving to mob...')
                await goToPosition(bot, pos.x, pos.y, pos.z);
            }
            console.log('attacking mob...')
            if (hasShield) lowerShield(bot);
            await bot.attack(entity);
        } finally {
            resumeAutoEat(bot, ate);
        }
    }
    else {
        const ate = pauseAutoEat(bot);
        if (hasShield) raiseShield(bot);
        bot.pvp.attack(entity);
        try {
            while (world.getNearbyEntities(bot, 24).includes(entity)) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                if (bot.interrupt_code) {
                    bot.pvp.stop();
                    return false;
                }
            }
        } finally {
            if (hasShield) lowerShield(bot);
            resumeAutoEat(bot, ate);
        }
        log(bot, `成功击杀了 ${entity.name}。`);
        await pickupNearbyItems(bot);
        return true;
    }
}

// 在 range 内按威胁度选当前最该打的敌对实体。
// getNearbyEntities 已按距离升序，我们再对其中敌对实体按 threatScoreWithBot 排序，
// 取最高分者为下一目标。同分时 getNearbyEntities 的距离序保留——即"同样危险先打近的"。
// 返回 null 表示 range 内已无敌对实体。
function getMostThreateningHostile(bot, range) {
    const hostiles = world.getNearbyEntities(bot, range).filter(e => mc.isHostile(e));
    if (hostiles.length === 0) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const e of hostiles) {
        const s = mc.threatScoreWithBot(bot, e);
        if (s > bestScore) {
            bestScore = s;
            best = e;
        }
    }
    return best;
}

export async function defendSelf(bot, range = 9) {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    const hasShield = await equipShield(bot);
    const ate = pauseAutoEat(bot); // 自卫全程禁吃，避免抢断 pvp 攻击节拍
    let attacked = false;
    // 记录本轮自卫中"交过手"的敌人：进入循环时记下当前 target 名，
    // 循环退出后这些敌人大多已被消灭（少数可能跑出 range）。用于结尾
    // 输出"击杀了 zombie、skeleton"，让 AI 知道威胁已清除，不必再 !attack。
    const foughtNames = [];
    // 按威胁度选目标而非"最近"：一群怪里优先打当前最危险的（冲刺苦力怕 > 大史莱姆
    // > 贴脸怪 > 远程射手 > 普通怪），避免被贴脸苦力怕炸却去砍远处僵尸。
    // getMostThreateningHostile 在 range 内按 threatScoreWithBot 排序返回第一名。
    let enemy = getMostThreateningHostile(bot, range);
    if (hasShield && enemy) raiseShield(bot); // 进入战斗先举盾，覆盖到首次 attack 的空窗
    // 围攻锁定目标：围攻时威胁度排序会频繁换目标，而 bot.pvp.attack(新目标)
    // 内部 setGoal(GoalFollow(新目标)) 会把 bot 反复拽向怪堆、抵消我们的后撤 goal。
    // 故围攻期间锁定首个高威胁目标不换，直到它消失/死亡，再重选下一个。
    let lockedEnemy = null;
    let lockCount = 0;
    // 围攻状态滞后：meleeHostiles 在 2 上下抖动时（怪群走走停停），surrounded 会
    // 在 true/false 间跳变，bot 每跳就切换「手控后退」/「pathfinder 追杀」，
    // 追杀那一下 goal follow(name) 又把 bot 拽进怪堆——这就是「撤一会又送进怪堆」。
    // 用 unSurroundCounter 滞回：进入围攻立即生效；要连续 ≥3 轮都不围攻才认为真的脱困，
    // 否则保持围攻手控后退。
    let unSurroundCounter = 0;
    try {
        while (enemy) {
            // 记名去重：同一敌人每轮都记会重复，只记第一次出现
            if (!foughtNames.includes(enemy.name)) foughtNames.push(enemy.name);
            await equipHighestAttack(bot);

            // —— 围攻感知（带滞后） ——
            const meleeHostiles = world.getNearbyEntities(bot, 6)
                .filter(e => mc.isHostile(e) && e.name !== 'skeleton' && e.name !== 'stray');
            const instantlySurrounded = meleeHostiles.length >= 2;
            let surrounded;
            if (instantlySurrounded) {
                surrounded = true;
                unSurroundCounter = 0;
            } else if (unSurroundCounter > 0) {
                // 已处于围攻保持期，本轮未围仍算围（滞回）
                surrounded = true;
                unSurroundCounter--;
            } else {
                surrounded = false;
            }

            if (surrounded) {
                // 锁定目标：围攻里换目标会让 pvp.attack 内部 setGoal(前移) 反复触发，
                // 立刻覆盖掉我们设的后撤 goal，bot 就一直往怪堆凑。锁定一个目标不换，
                // pvp 不会重复 setGoal，我们的 GoalInvert 才能真正生效。
                if (!lockedEnemy || !world.getNearbyEntities(bot, range).includes(lockedEnemy)) {
                    lockedEnemy = enemy;
                    lockCount = 0;
                }
                // 已锁定目标还活着且没换目标时再坚持一段距离，避免：怪被砍退两步就退出射程
                // 又换更近的怪造成回旋。
                if (lockedEnemy) {
                    enemy = lockedEnemy;
                    lockCount++;
                }

                // 主动后撤：手控按 'back' 键倒退 + 每轮 lookAt(目标)，不交给 pathfinder。
                // 关键根因：pathfinder.setGoal(GoalInvert) 走人时每 tick 把朝向拧向「下一个
                // 路径点」（怪群后方），bot 背对怪群 → 盾牌只挡正面 180°、防不住身后侧脸，
                // 攻击也朝错方向。改成老玩家 backpedal：始终面向怪按 S 倒退，盾正对怪群，
                // pvp 出刀也朝怪，一举解决『视角看别处、盾防不住』。
                // 不清空 pathfinder 的 goal 也行，但保险起见先 stop，避免它残留 GoalFollow
                // 把 bot 往前拽、与 back 互相拉扯。
                try {
                    bot.pathfinder.stop();
                } catch (err) { }
                bot.setControlState('back', true);
                bot.setControlState('sprint', false);
                // 始终看着目标：比 pvp 的 lookAt 更频繁，覆盖任何剩余朝向扰动。
                // force=true 立刻应用，不等插值。
                try {
                    await bot.lookAt(enemy.position.offset(0, enemy.height / 2, 0), true);
                } catch (err) { }

                // 边撤边打：pvp 只砍锁定的一个目标，围攻时其余怪也会从两侧/身后挤进来
                // （至今贴到 ≤2.5），手动对它们也出刀。Minecraft 剑挥带横扫/裂刃判定，
                // 一次 swing 能波及身侧附近怪，压住挤上来的，配合后撤把它们打散。
                try {
                    const others = meleeHostiles.filter(e => e !== enemy &&
                        bot.entity.position.distanceTo(e.position) <= 3.5);
                    for (const o of others) {
                        bot.attack(o).catch(() => { });
                    }
                } catch (err) { /* attack 异常忽略，主目标 pvp 还在打 */ }

                // 围攻分支末尾：不要 bot.pvp.attack(enemy)！
                // 虽 然 pvp.attack 同目标首句 `if(target===this.target) return` 跳过，
                // 但每轮 aimRef `enemy` 经锁定可能引用变化就变成新目标，
                // 这时 pvp.attack 内部 setGoal(GoalFollow(新目标)) 又把 bot 往前拽，
                // 立刻抵消 back 倒退「切到怪堆」就是「撤一会又冲进去」的根因。
                // 改成第一条 round 调 pvp.attack 设置 this.target，且必须确保后续
                // 不再 setGoal 諒 `bot.pathfinder.stop()` 已清干净；attemptAttack 仍按
                // physicsTick 跑具熟于Attack 范围里出剑。我们将这一段塞进「首次设
                // target」的前提。
                if (!bot.pvp.target) {
                    try { bot.pvp.attack(enemy); } catch (_) { }
                }
            }
            else {
                lockedEnemy = null;
                // 单怪不再是围攻：松开 back 倒退键，恢复正常寻路追杀（forward）
                bot.setControlState('back', false);
                const dist = bot.entity.position.distanceTo(enemy.position);
                const rangedMobs = ['skeleton', 'stray', 'pillager', 'witch'];
                const flyingMobs = ['phantom', 'ghast', 'blaze', 'bee'];
                const isRanged = rangedMobs.includes(enemy.name);
                const isFlying = flyingMobs.includes(enemy.name);

                if (isRanged) {
                    // 远程射手会边射边退风筝 bot，不愿让 bot 贴近。原逻辑 dist>=4 才
                    // GoalFollow(3.5)：骷髅一直 7-10 格射箭，bot 一直凑不到进 attackRange
                    // 就在那挨射。改成 range=1 强制贴脸（路径寻找会尽量追到骷髅脚下），
                    // 且不再 ≤2 后撤——远程怪就是要主动凑近贴死。
                    if (dist >= 2.5) {
                        try {
                            const m = new pf.Movements(bot);
                            m.allowSprinting = true; // 追骷髅得能冲刺，否则被永远风筝
                            bot.pathfinder.setMovements(m);
                            await bot.pathfinder.goto(new pf.goals.GoalFollow(enemy, 2), true);
                        } catch (err) {/* might error if entity dies, ignore */ }
                    }
                    // 进到攻击范围就出刀，pvp.attack 处理
                }
                else if (isFlying) {
                    // 飞行怪在空中俯冲。GoalFollow 的 isEnd 用 3D 距离，bot 站到幻翼下方
                    // 的同 y 高度上跳起来挥剑，能在幻翼下冲时砍到。需配合可搭方块/可跳的
                    // movements，让 bot 主动往上够。够不到时至少别站桩挨撞→保持瞄准跟随。
                    if (dist >= 2.5) {
                        try {
                            const m = new pf.Movements(bot);
                            m.allowSprinting = true;
                            // 让 bot 朝空中怪 xz 跟随，y 由 pathfinder 自己爬坡/跳
                            bot.pathfinder.setMovements(m);
                            await bot.pathfinder.goto(new pf.goals.GoalFollow(enemy, 2), true);
                        } catch (err) {/* might error if entity dies, ignore */ }
                    }
                    // 朝空中的怪保持看向，便于俯冲那一刻及时出刀（pvp.attack 会自己 lookAt）
                    try {
                        await bot.lookAt(enemy.position.offset(0, enemy.height / 2, 0), true);
                    } catch (_) { }
                }
                else {
                    // 普通近战：维持原逻辑追到 3.5、≤2 再微退
                    if (dist >= 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
                        try {
                            bot.pathfinder.setMovements(new pf.Movements(bot));
                            await bot.pathfinder.goto(new pf.goals.GoalFollow(enemy, 3.5), true);
                        } catch (err) {/* might error if entity dies, ignore */ }
                    }
                    if (dist <= 2) {
                        try {
                            bot.pathfinder.setMovements(new pf.Movements(bot));
                            let inverted_goal = new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, 2));
                            await bot.pathfinder.goto(inverted_goal, true);
                        } catch (err) {/* might error if entity dies, ignore */ }
                    }
                }
                // 单怪分支：靠 pvp.attack 设 GoalFollow 出刀。
                try { bot.pvp.attack(enemy); } catch (_) { }
            }
            attacked = true;
            await new Promise(resolve => setTimeout(resolve, 500));
            // 围攻时已锁定 lockedEnemy，别按威胁度重选——重选会让 pvp.attack 换目标、
            // 内部重新 setGoal(GoalFollow) 把 bot 拽回怪堆，抵消后撤。锁定目标死/跑出
            // range 后（上方围攻分支已检测 includes(lockedEnemy) 失效就清空）才允许重选。
            if (surrounded && lockedEnemy && world.getNearbyEntities(bot, range).includes(lockedEnemy)) {
                enemy = lockedEnemy;
            } else {
                enemy = getMostThreateningHostile(bot, range);
            }
            if (bot.interrupt_code) {
                bot.pvp.stop();
                return false;
            }
        }
    } finally {
        // 清理围攻时按下的 back 倒退键，避免离开战斗后 bot 仍一直倒退
        bot.setControlState('back', false);
        if (hasShield) lowerShield(bot);
        bot.pvp.stop();
        resumeAutoEat(bot, ate);
    }
    if (attacked) {
        // 循环退出意味着 range 内已无敌对生物。foughtNames 里的敌人要么被杀、
        // 要么跑出 range（少见）。报告"清除"而非精确"击杀"，措辞更准确。
        log(bot, `成功自卫，清除了 ${foughtNames.join('、')}，附近已无敌人。`);
        try { await pickupNearbyItems(bot); } catch (_) { }
    } else
        log(bot, `附近没有敌人需要自卫。`);
    return attacked;
}




export async function collectBlock(bot, blockType, num = 1, exclude = null) {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @returns {Promise<boolean>} true if the block was collected, false if the block type was not found.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (num < 1) {
        log(bot, `要收集的方块数量无效: ${num}。`);
        return false;
    }
    let blocktypes = [blockType];
    if (blockType === 'coal' || blockType === 'diamond' || blockType === 'emerald' || blockType === 'iron' || blockType === 'gold' || blockType === 'lapis_lazuli' || blockType === 'redstone')
        blocktypes.push(blockType + '_ore');
    if (blockType.endsWith('ore'))
        blocktypes.push('deepslate_' + blockType);
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    const isLiquid = blockType === 'lava' || blockType === 'water';

    // 推断挖掉该类方块后实际进背包的物品名，用于以"背包增量"校准真实收集量。
    // 多数方块掉落自身；矿石掉落对应产物；石头掉圆石；草方块掉泥土。
    // 没有映射的退回 blockType（绝大多数方块掉落自身，足够准确）。
    const dropName = ({
        stone: 'cobblestone', grass_block: 'dirt',
        coal: 'coal', coal_ore: 'coal', deepslate_coal_ore: 'coal',
        diamond: 'diamond', diamond_ore: 'diamond', deepslate_diamond_ore: 'diamond',
        emerald: 'emerald', emerald_ore: 'emerald', deepslate_emerald_ore: 'emerald',
        iron: 'raw_iron', iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron',
        gold: 'raw_gold', gold_ore: 'raw_gold', deepslate_gold_ore: 'raw_gold',
        copper_ore: 'raw_copper', deepslate_copper_ore: 'raw_copper',
        lapis_lazuli: 'lapis_lazuli', lapis_ore: 'lapis_lazuli', deepslate_lapis_ore: 'lapis_lazuli',
        redstone: 'redstone', redstone_ore: 'redstone', deepslate_redstone_ore: 'redstone',
    })[blockType] ?? blockType;
    const invBefore = world.getInventoryCounts(bot)[dropName] ?? 0;

    let dug = 0; // 成功挖掉的方块数（不等于实际进背包的数量）
    let result = false;
    const failedPositions = []; // blocks that repeatedly failed, skip them
    let lastDugPos = null; // 上一个成功挖掉的位置，用于沿同一树干自下而上连挖

    const movements = new pf.Movements(bot);
    movements.dontMineUnderFallingBlock = false;
    movements.dontCreateFlow = true;

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks = ['obsidian'];

    // 暂停 unstuck：导航到下一个目标方块期间 targetDigBlock 为空，unstuck 会把
    // "原地不动"判为卡住，触发 digObstacle 去挖附近的卡路方块——这会抢断当前挖掘
    // （mineflayer dig 内部 if(bot.targetDigBlock) bot.stopDigging()），表现为
    // "挖到最后一刻突然看向其他地方挖一下"。collectBlock 有自己的失败重试，不需 unstuck。
    // 同时暂停 idle_staring，避免它每 tick 改朝向干扰挖掘（虽非 idle 理论不跑，双保险）。
    bot.modes.pause('unstuck');
    bot.modes.pause('idle_staring');
    try {

        for (let i = 0; i < num; i++) {
            // bot.findBlocks 用方块缓存，可能滞后（刚砍光的树仍被标成 oak_log），
            // 但实时 bot.blockAt 复验也会误判（边界/未加载区块瞬时读取不准），
            // 且把好方块误记入 failedPositions 后再也选不到，导致"找不到方块"。
            // 故选块阶段信缓存选出候选，真正的"已是空气"校验交给 collectBlock 插件
            // （bot.collectBlock.collect 内部 bot.dig 前会复查 blockAt.type）+ 失败换下一个。
            let blocks = world.getNearestBlocksWhere(bot, block => {
                // mineflayer findBlocks 在 palette 检测阶段会用 Block.fromStateId(stateId,0)
                // 创建的临时 Block 调用 predicate，这些块无 position、只有 type/name，
                // 用于判断"该区块段是否含目标类型"。若在此 return false，mineflayer 会
                // 跳过整个 section，导致真正的目标方块永远搜不到（"附近没有 X"）。
                // 故无 position 时只做类型判断，不做坐标相关的 exclude/failedPositions 过滤。
                if (!block) return false;
                if (!blocktypes.includes(block.name)) return false;
                if (!block.position) return true; // palette 阶段：类型匹配即可放行
                const bp = block.position;
                if (exclude) {
                    for (let position of exclude) {
                        if (!position) continue;
                        if (bp.x === position.x && bp.y === position.y && bp.z === position.z) {
                            return false;
                        }
                    }
                }
                if (failedPositions.some(p => p && p.x === bp.x && p.y === bp.y && p.z === bp.z)) {
                    return false;
                }
                if (isLiquid) {
                    return block.metadata === 0;
                }
                return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
            }, 64, 32);

            if (blocks.length === 0) {
                if (dug === 0)
                    log(bot, `附近没有 ${blockType} 可以收集。`);
                else
                    log(bot, `附近没有更多 ${blockType} 可以收集。`);
                break;
            }
            log(bot, `[collectBlock] 找到 ${blocks.length} 个 ${blockType} 候选`);

            // 多候选按"易达度"排序，避免总选到隔悬崖/隔山体的高位方块。
            // 评分要素：平面距离近、与 bot 高度差小（更易到达）、附近空气多（更易站到方块旁挖）。
            // 这只是粗排序，最终能不能到由 pathfinder 决定；改排序后 bot 会优先尝试
            // 平地上近、同高度的方块，而不是直线 3D 距离最近但隔空的高位方块。
            const botPos = bot.entity.position;
            blocks = blocks.map(b => {
                const dp = b.position.distanceSquared(botPos);
                const dy = Math.abs(b.position.y - botPos.y);
                // 是否"贴地"：下方是固体非树叶/非雪等可站立支撑。贴地的树干底部、
                // 矿石 bot 能直接走过去站着挖；悬空（下方空气）的是被砍剩的树干
                // 或隔空矿，够不着只能搭方块上去，应当避开，优先换旁边完整的新目标。
                let grounded = false;
                const below = bot.blockAt(b.position.offset(0, -1, 0));
                if (below && below.name !== 'air' && below.name !== 'cave_air' &&
                    below.name !== 'water' && below.name !== 'lava' &&
                    !below.name.includes('leaves') && !below.name.includes('snow') &&
                    below.name !== 'short_grass' && below.name !== 'tall_grass' &&
                    below.name !== 'fern') {
                    grounded = true;
                }
                // 贴地强优先、悬空强避开；同优先级内再按距离/高度差。
                // 不再用"周围空气多"加分：树叶丛中空气多但悬空，反而误导选树顶。
                let score = dp + dy * dy * 4;
                score += grounded ? -50 : 60;
                // 沿同一树干自下而上连挖：挖掉 y 后下一轮里 y+1 的方块虽然下方变空
                // （grounded=false 加 60）会显得"悬空难够"，但 bot 其实仍站在刚挖出的
                // 空位上抬头就能挖到。给它强负分让 bot 优先把同一棵树挖完，而不是
                // 跳到旁边别的树的顶部，留下本树中间一格悬空。
                if (lastDugPos) {
                    const dx = b.position.x - lastDugPos.x;
                    const dz = b.position.z - lastDugPos.z;
                    const dyy = b.position.y - lastDugPos.y;
                    // 同一列正上方（x/z 相同、y 高 1）：大概率是同一棵树干的下一格
                    if (dx === 0 && dz === 0 && dyy === 1) {
                        score -= 120;
                    }
                }
                return { b, score };
            }).sort((a, b) => a.score - b.score).map(x => x.b);

            const block = blocks[0];
            log(bot, `[collectBlock] 选中 ${block.name} @ ${block.position.x},${block.position.y},${block.position.z}，评分 ${blocks[0].score ?? '?'}`);
            // blocks 已经过实时复验（缓存与实际一致），这里直接使用，
            // 不再重复校验 type。equipForBlock 需要最新的 block 状态。
            await bot.tool.equipForBlock(block);
            if (isLiquid) {
                const bucket = bot.inventory.findInventoryItem('bucket');
                if (!bucket) {
                    log(bot, `没有桶来采集 ${blockType}。`);
                    return false;
                }
                await bot.equip(bucket, 'hand');
            }
            const itemId = bot.heldItem ? bot.heldItem.type : null
            if (bot.game.gameMode !== 'creative' && !block.canHarvest(itemId)) {
                log(bot, `没有合适的工具来采集 ${blockType}。`);
                return false;
            }
            // 镐子耐久预警：手持工具快爆时停下，告诉 AI 让它自己决定
            // （合成新镐子/换备用/撤退），避免挖到一半工具消失后卡在井下上不来。
            // mineflayer item：durabilityUsed 已用耐久，maxDurability 总耐久。
            if (bot.heldItem && bot.game.gameMode !== 'creative') {
                const it = bot.heldItem;
                if (it.maxDurability > 0 && it.durabilityUsed >= it.maxDurability - 3) {
                    const left = it.maxDurability - it.durabilityUsed;
                    log(bot, `警告：手持 ${it.name} 仅剩 ${left} 点耐久，快爆了！已停止挖矿。请合成/换备用镐子，或用 !goToSurface 先回地面。`);
                    return false;
                }
            }
            try {
                let success = false;
                if (isLiquid) {
                    success = await useToolOnBlock(bot, 'bucket', block);
                }
                else if (mc.mustCollectManually(blockType)) {
                    await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                    await bot.dig(block);
                    await pickupNearbyItems(bot);
                    success = true;
                }
                else {
                    // 用 mineflayer-collectblock 插件（原版做法）：内部 GoalLookAtBlock
                    // 寻路（isEnd 用 raycast 验证 bot 站到能看见方块面的位置）→ bot.dig →
                    // 监听 itemDrop 自动拾取掉落物。一气呵成，不在外面逐块 pickup 造成折返。
                    try {
                        await bot.collectBlock.collect(block);
                    } catch (collectErr) {
                        log(bot, `[collectBlock] collect 失败：${collectErr}`);
                        failedPositions.push(block.position);
                        continue;
                    }
                    success = true;
                }
                if (success) {
                    dug++;
                    // 记录刚挖掉的位置：下一轮选块时优先选其正上方，沿同一树干
                    // 自下而上挖完整棵树，避免挖掉底部后跳走、留下中间格悬空。
                    lastDugPos = block.position;
                }
                // 不在 collectBlock 循环里 autoLight：挖一块就放一次火把，
                // 砍树时 bot 不断站进刚挖出的原木空位（脚下 air），每次都触发
                // shouldPlaceTorch → 放在脚下失败/反复放 → "火把鬼畜"。
                // 照明交给独立的 torch_placing 模式按自己节奏处理，砍树/挖矿
                // 中途专心作业即可。
            }
            catch (err) {
                if (err.name === 'NoChests') {
                    log(bot, `收集 ${blockType} 失败：背包已满，没有地方存放。`);
                    break;
                }
                else {
                    log(bot, `收集 ${blockType} 失败：${err}。`);
                    if (String(err).includes('aborted') || String(err).includes('PathStopped') ||
                        String(err).includes('Block not in view')) {
                        failedPositions.push(block.position);
                    }
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                }
            }

            if (bot.interrupt_code)
                break;
        }

        // 循环结束后统一拾取掉落物：循环中不再逐块 pickupNearbyItems，避免挖短
        // digTime 方块（土/石头）时每块都转身追物品导致折返乱飘。多数掉落物挖出后
        // 已被自动吸入背包；这里再补拾一次遗漏的。
        if (dug > 0) {
            try { await pickupNearbyItems(bot); } catch (_) { }
        }

        // 用背包增量校准真实收集量：挖掉的方块可能掉进岩浆/被水冲走/没捡到，
        // dug 不等于实际进背包的数量。以背包增量为准，避免虚报"收集了 N 个"。
        const invAfter = world.getInventoryCounts(bot)[dropName] ?? 0;
        const reallyGained = Math.max(0, invAfter - invBefore);
        if (reallyGained > 0) {
            result = true;
            if (reallyGained < num)
                log(bot, `只收集到 ${reallyGained} 个 ${blockType}（目标 ${num} 个），挖掉了 ${dug} 个方块，部分掉落物丢失或未捡到。`);
            else
                log(bot, `成功收集了 ${reallyGained} 个 ${blockType}。`);
        } else {
            log(bot, `收集 ${blockType} 失败：挖掉了 ${dug} 个方块，但背包里 ${dropName} 数量没有增加（掉落物可能掉进岩浆/被水冲走/没捡到）。`);
        }

    } finally {
        bot.modes.unpause('unstuck');
        bot.modes.unpause('idle_staring');
    }
    return result;
}

export async function pickupNearbyItems(bot) {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
     **/
    const distance = 8;
    const getNearestItem = bot => bot.nearestEntity(entity => entity.name === 'item' && bot.entity.position.distanceTo(entity.position) < distance);

    // 用背包快照校准真实捡起数量：GoalFollow(1) 到达后物品常常还没被吸入
    // （Minecraft 拾取需要实体几乎重叠），旧的"实体消失即 +1"计数会把"站在物品
    // 旁边、200ms 内没吸进来"误判成没捡到并提前 break，于是报告"捡起了 0 个"，
    // 而实际上几秒后物品才被自动吸入。以背包增量为准最准确。
    const invBefore = world.getInventoryCounts(bot);
    const invSumBefore = Object.values(invBefore).reduce((a, b) => a + b, 0);

    let nearestItem = getNearestItem(bot);
    // 附近没有 item 实体时直接返回：多数掉落物挖出后会被自动吸入背包，
    // 此时调用方再来 pickupNearbyItems 会抓不到任何实体。原本此处会打印
    // "没有捡到任何物品"的误导日志（其实物品早已进背包），现在静默返回。
    if (!nearestItem) {
        return true;
    }
    let stuckCount = 0;
    while (nearestItem) {
        let movements = new pf.Movements(bot);
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        try {
            await goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 1));
        } catch (err) {
            if (String(err).includes('PathStopped') || String(err).includes('interrupted')) {
                break; // interrupted by a new action, stop gracefully
            }
            throw err;
        }
        // 到达后再凑近并多等一会，给服务端把物品吸入背包的时间
        try {
            bot.pathfinder.setMovements(new pf.Movements(bot));
            await goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 0.3));
        } catch (err) {
            if (!(String(err).includes('PathStopped') || String(err).includes('interrupted'))) {
                // 物品可能已被吸走导致 goal 失败，忽略继续
            }
        }
        await new Promise(resolve => setTimeout(resolve, 600));
        let prev = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            // 同一个物品还在：可能卡在边缘或被挡住，重试几次后跳过它
            if (++stuckCount >= 3) {
                break;
            }
            continue;
        }
        stuckCount = 0;
    }

    const invAfter = world.getInventoryCounts(bot);
    const invSumAfter = Object.values(invAfter).reduce((a, b) => a + b, 0);
    const reallyGained = Math.max(0, invSumAfter - invSumBefore);
    if (reallyGained > 0) {
        const details = Object.entries(invAfter)
            .filter(([k, v]) => (invBefore[k] ?? 0) < v)
            .map(([k, v]) => `${k} +${v - (invBefore[k] ?? 0)}`)
            .join('，');
        log(bot, `捡起了 ${reallyGained} 个物品${details ? `（${details}）` : ''}。`);
    }
    // 没捡到也不报错：物品可能被自动吸入（背包增量已体现）、或卡住没吸进来
    // （collectBlock 末尾会用整次收集的背包增量统一校准，无需在此重复提示）。
    return true;
}


export async function breakBlockAt(bot, x, y, z) {
    /**
     * Break the block at the given position. Will use the bot's equipped item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true if the block was broken, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.x);
     **/
    if (x == null || y == null || z == null) throw new Error('Invalid position to break block at.');
    let block = bot.blockAt(Vec3(x, y, z));
    if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        if (bot.modes.isOn('cheat')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' air';
            bot.chat(msg);
            log(bot, `使用 /setblock 破坏了 ${x}, ${y}, ${z} 处的方块。`);
            return true;
        }

        if (bot.entity.position.distanceTo(block.position) > 4.5) {
            let pos = block.position;
            let movements = new pf.Movements(bot);
            movements.canPlaceOn = false;
            movements.allow1by1towers = false;
            bot.pathfinder.setMovements(movements);
            await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
        }
        if (bot.game.gameMode !== 'creative') {
            await bot.tool.equipForBlock(block);
            const itemId = bot.heldItem ? bot.heldItem.type : null
            if (!block.canHarvest(itemId)) {
                log(bot, `没有合适的工具来破坏 ${block.name}。`);
                return false;
            }
        }
        await bot.dig(block, true);
        log(bot, `破坏了 ${block.name}，位置 x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}。`);
    }
    else {
        log(bot, `跳过 x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} 处的方块，因为它是 ${block.name}。`);
        return false;
    }
    return true;
}


export async function placeBlock(bot, blockType, x, y, z, placeOn = 'bottom', dontCheat = false) {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string} placeOn, the preferred side of the block to place on. Can be 'top', 'bottom', 'north', 'south', 'east', 'west', or 'side'. Defaults to bottom. Will place on first available side if not possible.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true if the block was placed, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.x);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.x, 'side');
     **/
    const target_dest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));

    if (blockType === 'air') {
        log(bot, `正在放置空气（移除方块）到 ${target_dest}。`);
        return await breakBlockAt(bot, x, y, z);
    }

    if (bot.modes.isOn('cheat') && !dontCheat) {
        if (bot.restrict_to_inventory) {
            let block = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                log(bot, `无法放置 ${blockType}，你被限制在当前背包内。`);
                return false;
            }
        }

        // invert the facing direction
        let face = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
        let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' ' + blockType;
        bot.chat(msg);
        if (blockType.includes('door'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
        bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y + 1) + ' ' + Math.floor(z) + ' ' + blockType + '[half=upper]');
        if (blockType.includes('bed'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
        bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z - 1) + ' ' + blockType + '[part=head]');
        log(bot, `使用 /setblock 在 ${target_dest} 放置了 ${blockType}。`);
        return true;
    }

    let item_name = blockType;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    let block_item = bot.inventory.findInventoryItem(item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        await bot.creative.setInventorySlot(36, mc.makeItem(item_name, 1)); // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        log(bot, `没有 ${item_name} 可以放置。`);
        return false;
    }

    const targetBlock = bot.blockAt(target_dest);
    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        log(bot, `${blockType} 已经在 ${targetBlock.position} 处了。`);
        return false;
    }
    const empty_blocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} 挡住了 ${targetBlock.position} 处的位置。`);
        const removed = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `无法在 ${targetBlock.position} 放置 ${blockType}：有方块挡住了。`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for block to break
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock = null;
    let faceVec = null;
    const dir_map = {
        'top': Vec3(0, 1, 0),
        'bottom': Vec3(0, -1, 0),
        'north': Vec3(0, 0, -1),
        'south': Vec3(0, 0, 1),
        'east': Vec3(1, 0, 0),
        'west': Vec3(-1, 0, 0),
    }
    let dirs = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `未知的 placeOn 值 "${placeOn}"。默认使用 bottom。`);
    }
    dirs.push(...Object.values(dir_map).filter(d => !dirs.includes(d)));

    for (let d of dirs) {
        const block = bot.blockAt(target_dest.plus(d));
        if (!empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new Vec3(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        log(bot, `无法在 ${targetBlock.position} 放置 ${blockType}：没有可放置的支撑面。`);
        return false;
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(Vec3(0, 1, 0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail',
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await bot.pathfinder.goto(inverted_goal);
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        let pos = targetBlock.position;
        let movements = new pf.Movements(bot);
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            await useToolOnBlock(bot, item_name, buildOffBlock);
        }
        else {
            await bot.equip(block_item, 'hand');
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
            await bot.placeBlock(buildOffBlock, faceVec);
            log(bot, `在 ${target_dest} 放置了 ${blockType}。`);
            await new Promise(resolve => setTimeout(resolve, 200));
            return true;
        }
    } catch (err) {
        log(bot, `在 ${target_dest} 放置 ${blockType} 失败。`);
        return false;
    }
}

export async function equip(bot, itemName) {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true if the item was equipped, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    if (itemName === 'hand') {
        await bot.unequip('hand');
        log(bot, `已卸下手持物品。`);
        return true;
    }
    let item = bot.inventory.slots.find(slot => slot && slot.name === itemName);
    if (!item) {
        if (bot.game.gameMode === "creative") {
            await bot.creative.setInventorySlot(36, mc.makeItem(itemName, 1));
            item = bot.inventory.findInventoryItem(itemName);
        }
        else {
            log(bot, `你没有 ${itemName} 可以装备。`);
            return false;
        }
    }
    if (itemName.includes('leggings')) {
        await bot.equip(item, 'legs');
    }
    else if (itemName.includes('boots')) {
        await bot.equip(item, 'feet');
    }
    else if (itemName.includes('helmet')) {
        await bot.equip(item, 'head');
    }
    else if (itemName.includes('chestplate') || itemName.includes('elytra')) {
        await bot.equip(item, 'torso');
    }
    else if (itemName.includes('shield')) {
        await bot.equip(item, 'off-hand');
    }
    else {
        await bot.equip(item, 'hand');
    }
    log(bot, `已装备 ${itemName}。`);
    return true;
}

export async function discard(bot, itemName, num = -1) {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    // 副手(slot 45)里的物品不在 findInventoryItem 的搜索范围(9~44)内，
    // 会导致盾牌/副手食物等既丢不出也给不了玩家。先把副手同名物品卸回主背包。
    const OFF_HAND_SLOT = 45;
    const offHand = bot.inventory.slots[OFF_HAND_SLOT];
    if (offHand && (offHand.name === itemName || mc.getItemId(itemName) === offHand.type)) {
        try { await bot.unequip('off-hand'); }
        catch (err) { log(bot, `无法把 ${itemName} 从副手取回：${err}。`); }
    }
    // 主手同理：findInventoryItem 能找到主手物品，但 bot.toss 对当前手持物品
    // 有时丢出数量/动画异常，先卸回主背包更稳妥。
    const heldItem = bot.heldItem;
    if (heldItem && (heldItem.name === itemName || mc.getItemId(itemName) === heldItem.type)) {
        try { await bot.unequip('hand'); }
        catch (_) { }
    }

    let discarded = 0;
    while (true) {
        let item = bot.inventory.findInventoryItem(itemName);
        if (!item) {
            break;
        }
        let to_discard = num === -1 ? item.count : Math.min(num - discarded, item.count);
        await bot.toss(item.type, null, to_discard);
        discarded += to_discard;
        if (num !== -1 && discarded >= num) {
            break;
        }
    }
    if (discarded === 0) {
        log(bot, `你没有 ${itemName} 可以丢弃。`);
        return false;
    }
    log(bot, `丢弃了 ${discarded} 个 ${itemName}。`);
    return true;
}

// 用可选坐标锁定一个具体箱子。传入 x/y/z 时按坐标精确匹配最近的同名箱子块；
// 不传时退回"最近箱子"旧行为。返回 { chest, positionStr } 供调用方输出，
// 让 AI 知道刚才操作的是哪个箱子。找不到返回 null。
async function resolveChest(bot, x, y, z, range = 32) {
    if (x != null && y != null && z != null) {
        const target = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
        const blocks = world.getNearestBlocks(bot, 'chest', range, 10000);
        let best = null, bestDist = Infinity;
        for (const b of blocks) {
            const d = b.position.distanceSquared(target);
            if (d < bestDist) { bestDist = d; best = b; }
        }
        if (!best) {
            log(bot, `坐标 ${target} 附近 ${range} 格内没有箱子。`);
            return null;
        }
        if (bestDist > 4) {
            log(bot, `坐标 ${target} 处没有箱子，最近的箱子在 ${best.position}（相距 ${Math.sqrt(bestDist).toFixed(1)} 格）。`);
            return null;
        }
        return best;
    }
    return world.getNearestBlock(bot, 'chest', range);
}

// 供记忆命令复用的导出别名，避免重复实现。
export async function _resolveChestForMemory(bot, x, y, z, range = 32) {
    return resolveChest(bot, x, y, z, range);
}

function posStr(pos) {
    return `(${pos.x}, ${pos.y}, ${pos.z})`;
}

// --- 双联箱配对判定 ---
// Minecraft 大型箱子由两个相邻方块组成，两半必须满足：
//   1) type 一个是 'left' 一个是 'right'（不能是 'single'）；
//   2) facing（朝向）完全相同；
//   3) 两半沿"垂直于 facing 的轴"相邻（facing=north/south 时沿 x 轴，facing=east/west 时沿 z 轴）；
//   4) left/right 与偏移方向严格对应（见 CHEST_PAIR_OFFSET）。
// 旧实现只判 type 互补 + 相邻，没校验 facing/方向，会把"同朝向并排的多排双联箱"中
// 不同箱子的两半误配成一对（例：z=-239 的石料箱和 z=-237 的食物箱都被误配到 z=-238
// 的同一块），导致记忆里两个箱子共用一半坐标，互相覆盖名字。
// CHEST_PAIR_OFFSET：给定某一半的 facing 和 type，其另一半应处的相对偏移。
// 依据原版 ChestBlock.getConnectedDirection（参见 CoreProtect ChestTool.java 复刻）：
//   type=left  的另一半在 facing.rotateY() 方向（顺时针 90°，北→东→南→西）；
//   type=right 的另一半在 facing.rotateYCCW() 方向（逆时针 90°，北→西→南→东）。
// 换算成方块偏移：
//   north: left→东(+x), right→西(-x)
//   south: left→西(-x), right→东(+x)
//   east:  left→南(+z), right→北(-z)
//   west:  left→北(-z), right→南(+z)
const CHEST_PAIR_OFFSET = {
    north: { left: [1, 0, 0], right: [-1, 0, 0] },
    south: { left: [-1, 0, 0], right: [1, 0, 0] },
    east: { left: [0, 0, 1], right: [0, 0, -1] },
    west: { left: [0, 0, -1], right: [0, 0, 1] },
};

// 判断 blockB 是否是 blockA 的双联箱另一半。两者均需为 chest 方块且带有 _properties。
// 任一属性读不到返回 false（保守不合并，避免误并）。
export function isChestOtherHalf(blockA, blockB) {
    if (!blockA || !blockB || blockA.name !== 'chest' || blockB.name !== 'chest') return false;
    let pa, pb;
    try { pa = blockA._properties; pb = blockB._properties; } catch (_) { return false; }
    if (!pa || !pb) return false;
    const ta = pa.type, tb = pb.type, fa = pa.facing, fb = pa.facing;
    if (!ta || !tb || ta === 'single' || tb === 'single') return false;
    if (ta === tb) return false; // 必须 left/right 互补
    if (!fa || !fb || fa !== fb) return false; // 朝向必须一致
    const expect = CHEST_PAIR_OFFSET[fa]?.[ta];
    if (!expect) return false;
    const dx = blockB.position.x - blockA.position.x;
    const dy = blockB.position.y - blockA.position.y;
    const dz = blockB.position.z - blockA.position.z;
    return dx === expect[0] && dy === expect[1] && dz === expect[2];
}

export async function viewNearbyChests(bot, range = 32) {
    /**
     * List all chests within range with their contents. Each chest is identified by its coordinates so the agent can target it later with putInChest/takeFromChest/viewChest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the search radius in blocks. Defaults to 32.
     * @returns {Promise<boolean>} true if at least one chest was found, false otherwise.
     * @example
     * await skills.viewNearbyChests(bot);
     * await skills.viewNearbyChests(bot, 16);
     **/
    let chests = world.getNearestBlocks(bot, 'chest', range, 10000);
    if (chests.length === 0) {
        log(bot, `附近 ${range} 格内没有箱子。`);
        return false;
    }
    // 按到 bot 的距离排序，最近在前
    chests.sort((a, b) => bot.entity.position.distanceSquared(a.position) - bot.entity.position.distanceSquared(b.position));

    // 合并双联箱子：Minecraft 的大型箱子是两个相邻方块共用一个 54 格容器，
    // findBlocks 会返回两个位置、各自打开内容完全相同。
    // 判定规则（严格，避免把并排两排独立箱子误合并）：
    //   - type 属性可读：left 只配 right，right 只配 left，single 不配对。
    //     （并排两排双联箱时，外排 left 和里排 left 也相邻，但 left+left 不是双联箱，
    //      旧实现"非 single + 相邻即合并"会把它们误并，导致里排箱子消失。）
    //   - type 读不到：fallback 到"打开看内容是否完全相同"。纯相邻判定太宽，
    //     z 方向并排的两排单箱也会被误并。内容比对最可靠但慢，只在 type 不可用时用。
    const seen = new Set();
    const containers = [];
    const key = p => `${p.x},${p.y},${p.z}`;
    const isAdjacent = (p1, p2) => Math.abs(p1.x - p2.x) + Math.abs(p1.y - p2.y) + Math.abs(p1.z - p2.z) === 1;
    const chestType = b => {
        try { return b._properties?.type; } catch (_) { return undefined; }
    };
    // 内容指纹：打开箱子取物品列表签名。用于 type 不可读时的双联箱判定。
    const contentSig = async (bot, pos) => {
        try {
            const c = await bot.openContainer(bot.blockAt(pos));
            const items = c.containerItems();
            await c.close();
            const counts = {};
            for (const it of items) counts[it.name] = (counts[it.name] || 0) + it.count;
            return Object.entries(counts).sort().map(([n, c]) => `${n}:${c}`).join(',');
        } catch (_) { return null; }
    };

    for (const chest of chests) {
        if (seen.has(key(chest.position))) continue;
        const positions = [chest.position];
        seen.add(key(chest.position));
        const t = chestType(chest);
        const canPairByType = t && t !== 'single'; // left 或 right
        for (const other of chests) {
            if (seen.has(key(other.position))) continue;
            const ot = chestType(other);
            if (!isAdjacent(chest.position, other.position)) continue;
            let match = false;
            if (canPairByType) {
                // 严格配对：用 isChestOtherHalf 校验 facing/方向/互补 type，
                // 不能只看 type 互补，否则并排多排双联箱会跨箱误并
                // （旧实现把 z=-239 石料箱与 z=-237 食物箱都误配到 z=-238 同一块）。
                match = isChestOtherHalf(chest, other) || isChestOtherHalf(other, chest);
            } else if (!t && !ot) {
                // type 都读不到：标记待定，先不合并，后面用内容比对
                match = false; // 这里先不合并，下面 fallback 处理
            }
            // single + 任何，或 left+left 等：不合并
            if (match) {
                positions.push(other.position);
                seen.add(key(other.position));
                break;
            }
        }
        // type 读不到且没通过 type 合并：尝试用内容比对找双联箱另一半
        // （只在当前箱子还没配对时做，避免对每个单箱都开箱，太慢）
        if (positions.length === 1 && !t) {
            for (const other of chests) {
                if (seen.has(key(other.position))) continue;
                if (!isAdjacent(chest.position, other.position)) continue;
                const ot2 = chestType(other);
                if (ot2 && ot2 !== 'single') continue; // 对方有 type 且非 single，交给 type 逻辑
                // 内容比对
                const [s1, s2] = await Promise.all([
                    contentSig(bot, chest.position),
                    contentSig(bot, other.position),
                ]);
                if (s1 !== null && s1 === s2) {
                    positions.push(other.position);
                    seen.add(key(other.position));
                    break;
                }
            }
        }
        containers.push(positions);
    }

    // 两阶段：先全部开箱收集内容，再一次性紧凑输出。
    // 旧实现边走边开边 log，箱多时累计输出超 1000 字符被
    // getBotOutputSummary 砍中段，AI 看不到完整列表就反复调用。
    // 走路用静默 pathfinder（不调 goToPosition，避免"找到了非破坏性路径/已到达"
    // 等导航日志 19 个箱子刷出 ~38 行废话，挤掉箱子列表）。
    const quietGoto = async (x, y, z) => {
        const goal = new pf.goals.GoalNear(x, y, z, 2);
        const move = new pf.Movements(bot);
        move.canDig = false;
        bot.pathfinder.setMovements(move);
        await bot.pathfinder.goto(goal);
    };
    const results = [];
    for (const positions of containers) {
        let nearestPos = positions[0];
        for (const p of positions) {
            if (bot.entity.position.distanceTo(p) < bot.entity.position.distanceTo(nearestPos)) nearestPos = p;
        }
        // 已在交互距离内（~4.5格）就不走，避免不必要导航
        if (bot.entity.position.distanceTo(nearestPos) > 4) {
            try {
                await quietGoto(nearestPos.x, nearestPos.y, nearestPos.z);
            } catch (_) {
                // 走不到位但可能已在交互距离内，下面仍尝试开箱
            }
        }
        let items;
        try {
            const container = await bot.openContainer(bot.blockAt(nearestPos));
            items = container.containerItems();
            await container.close();
        } catch (err) {
            const dist = bot.entity.position.distanceTo(nearestPos);
            results.push({ positions, status: dist > 5 ? 'unreachable' : 'fail', dist });
            continue;
        }
        // 把物品列表一起传给记忆钩子：对占位箱子做 embedding 自动归类，生成建议用途
        await bot._recordChestMemory?.(positions, items);
        results.push({ positions, status: 'ok', items });
    }

    // 紧凑输出：坐标用单一最短形式（双联箱只列主坐标），物品最多列 3 种。
    // 对照记忆标注已知箱子名，让 AI 一眼看出"哪几个还没命名"。
    const mb = bot._memoryBank;
    const nameAt = (pos) => {
        if (!mb) return null;
        const n = mb.findChestByPos(pos.x, pos.y, pos.z);
        return n && !n.startsWith('箱子(') ? n : null;
    };
    // 取占位箱子的 embedding 建议用途（玩家未命名时显示，供确认）
    const suggestedAt = (pos) => {
        if (!mb) return null;
        const n = mb.findChestByPos(pos.x, pos.y, pos.z);
        if (!n || !n.startsWith('箱子(')) return null;
        const c = mb.recallChest(n);
        return c?.suggestedPurpose || null;
    };
    const lines = [`附近 ${range} 格内共 ${containers.length} 个箱子：`];
    for (const r of results) {
        const p0 = r.positions[0];
        // 双联箱只列一个坐标（离 bot 最近的组成方块），避免 AI 在两个坐标间纠结
        let dispPos = p0;
        for (const p of r.positions) {
            if (bot.entity.position.distanceTo(p) < bot.entity.position.distanceTo(dispPos)) dispPos = p;
        }
        const coord = `${dispPos.x},${dispPos.y},${dispPos.z}`;
        // 双联箱用任一组成方块坐标查记忆，AI 之前可能记的是另一半
        let remembered = null;
        for (const p of r.positions) {
            const n = nameAt(p);
            if (n) { remembered = n; break; }
        }
        let suggested = null;
        if (!remembered) {
            for (const p of r.positions) {
                const s = suggestedAt(p);
                if (s) { suggested = s; break; }
            }
        }
        const tag = remembered ? `[${remembered}]` : (suggested ? `[未命名/建议:${suggested}]` : '[未命名]');
        if (r.status === 'unreachable') {
            lines.push(`- (${coord}) ${tag} 无法到达（${r.dist.toFixed(1)}格）`);
        } else if (r.status === 'fail') {
            lines.push(`- (${coord}) ${tag} 打开失败`);
        } else if (!r.items.length) {
            lines.push(`- (${coord}) ${tag} 空`);
        } else {
            const counts = {};
            for (const it of r.items) counts[it.name] = (counts[it.name] || 0) + it.count;
            const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
            const shown = entries.slice(0, 3).map(([n, c]) => `${c} ${n}`).join(',');
            const rest = entries.length > 3 ? ` +${entries.length - 3}种` : '';
            lines.push(`- (${coord}) ${tag} ${shown}${rest}`);
        }
    }
    // 一次性输出，控制在 1000 字符内（getBotOutputSummary 截断阈值）。
    // 若超长则分批 log，确保每批完整可见。
    let buf = '';
    for (const line of lines) {
        if ((buf + line + '\n').length > 900) {
            log(bot, buf.trimEnd());
            buf = '';
        }
        buf += line + '\n';
    }
    if (buf.trim()) log(bot, buf.trimEnd());
    const unnamed = results.filter(r => r.status === 'ok' && !nameAt(r.positions[0])).length;
    if (unnamed > 0) {
        log(bot, `提示：${unnamed} 个箱子还没命名，用 !rememberChest("名字","用途",x,y,z) 记一下用途（有"建议用途"的可参考命名）。`);
    }
    return true;
}

export async function putInChest(bot, itemName, num = -1, x = null, y = null, z = null) {
    /**
     * Put the given item in a chest. By default the nearest chest; pass x/y/z to target a specific chest (e.g. from viewNearbyChests).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, the number of items to put in the chest. Defaults to -1, which puts all items.
     * @param {number} x, optional x coordinate of the target chest.
     * @param {number} y, optional y coordinate of the target chest.
     * @param {number} z, optional z coordinate of the target chest.
     * @returns {Promise<boolean>} true if the item was put in the chest, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     * await skills.putInChest(bot, "oak_log", 64, 120, 70, -200);
     **/
    let chest = await resolveChest(bot, x, y, z);
    if (!chest) {
        if (x == null) log(bot, `附近没有箱子。`);
        return false;
    }
    let item = bot.inventory.findInventoryItem(itemName);
    if (!item) {
        log(bot, `你没有 ${itemName} 可以放进箱子。`);
        return false;
    }
    let to_put = num === -1 ? item.count : Math.min(num, item.count);
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);

    const chestContainer = await bot.openContainer(chest);
    try {
        await chestContainer.deposit(item.type, null, to_put);
        bot._recordChestMemory?.(chest.position);
        log(bot, `成功将 ${to_put} 个 ${itemName} 放入箱子 ${posStr(chest.position)}。`);
        return true;
    } catch (err) {
        log(bot, `放入箱子 ${posStr(chest.position)} 失败: ${err.message}`);
        return false;
    } finally {
        // 保证无论成功还是存满报错，箱子界面都会被优雅关闭
        try { await chestContainer.close(); } catch (_) { }
    }
}

export async function takeFromChest(bot, itemName, num = -1, x = null, y = null, z = null) {
    /**
     * Take the given item from a chest, potentially from multiple slots. By default the nearest chest; pass x/y/z to target a specific chest (e.g. from viewNearbyChests).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, the number of items to take from the chest. Defaults to -1, which takes all items.
     * @param {number} x, optional x coordinate of the target chest.
     * @param {number} y, optional y coordinate of the target chest.
     * @param {number} z, optional z coordinate of the target chest.
     * @returns {Promise<boolean>} true if the item was taken from the chest, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * await skills.takeFromChest(bot, "oak_log", 32, 120, 70, -200);
     * **/
    let chest = await resolveChest(bot, x, y, z);
    if (!chest) {
        if (x == null) log(bot, `附近没有找到箱子。`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);

    // Find all matching items in the chest
    let matchingItems = chestContainer.containerItems().filter(item => item.name === itemName);
    if (matchingItems.length === 0) {
        log(bot, `箱子 ${posStr(chest.position)} 里没有找到 ${itemName}。`);
        await chestContainer.close();
        return false;
    }

    let totalAvailable = matchingItems.reduce((sum, item) => sum + item.count, 0);
    let remaining = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
    let totalTaken = 0;

    // Take items from each slot until we've taken enough or run out
    for (const item of matchingItems) {
        if (remaining <= 0) break;

        let toTakeFromSlot = Math.min(remaining, item.count);
        await chestContainer.withdraw(item.type, null, toTakeFromSlot);

        totalTaken += toTakeFromSlot;
        remaining -= toTakeFromSlot;
    }

    bot._recordChestMemory?.(chest.position);
    await chestContainer.close();
    log(bot, `成功从箱子 ${posStr(chest.position)} 中取出了 ${totalTaken} 个 ${itemName}。`);
    return totalTaken > 0;
}

export async function viewChest(bot, x = null, y = null, z = null) {
    /**
     * View the contents of a chest. By default the nearest chest; pass x/y/z to target a specific chest (e.g. from viewNearbyChests).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, optional x coordinate of the target chest.
     * @param {number} y, optional y coordinate of the target chest.
     * @param {number} z, optional z coordinate of the target chest.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * await skills.viewChest(bot, 120, 70, -200);
     * **/
    let chest = await resolveChest(bot, x, y, z);
    if (!chest) {
        if (x == null) log(bot, `附近没有找到箱子。`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    let items = chestContainer.containerItems();
    bot._recordChestMemory?.(chest.position);
    if (items.length === 0) {
        log(bot, `箱子 ${posStr(chest.position)} 是空的。`);
    }
    else {
        // 同名物品可能分散在多个槽位，合并计数后再输出，
        // 避免输出过长被 getBotOutputSummary 截断导致中间物品（如铁锭）被隐藏。
        const counts = {};
        for (let item of items) {
            counts[item.name] = (counts[item.name] || 0) + item.count;
        }
        log(bot, `箱子 ${posStr(chest.position)} 内容：`);
        for (const name of Object.keys(counts)) {
            log(bot, `${counts[name]} 个 ${name}`);
        }
    }
    await chestContainer.close();
    return true;
}

export async function consume(bot, itemName = "") {
    /**
     * Eat/drink the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink.
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.eat(bot, "apple");
     **/
    let item, name;
    if (itemName) {
        item = bot.inventory.findInventoryItem(itemName);
        name = itemName;
    }
    if (!item) {
        log(bot, `你没有 ${name} 可以吃。`);
        return false;
    }
    // auto-eat 插件会把食物留在副手(slot 45)，而 findInventoryItem 只在主背包
    // 范围(9~44)内查找，副手里的食物查不到导致 consume 失败。先把副手清回主背包。
    const OFF_HAND_SLOT = 45;
    const offHand = bot.inventory.slots[OFF_HAND_SLOT];
    if (offHand && offHand.name === item.name) {
        await bot.unequip('off-hand');
        // unequip 后物品回到主背包，重新查找
        item = bot.inventory.findInventoryItem(itemName);
        if (!item) {
            log(bot, `无法把 ${name} 从副手取回。`);
            return false;
        }
    }
    await bot.equip(item, 'hand');
    await bot.consume();
    log(bot, `已食用 ${item.name}。`);
    return true;
}


export async function fish(bot, timeoutMs = 60000) {
    /**
     * Fish with a fishing rod. Equips the rod from hotbar slot 0, casts, watches the bobber sink, reels in, and verifies the catch from inventory. Logs every step to bot.output so the agent can see what happened.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} timeoutMs, max milliseconds to wait for a bite (default 60000).
     * @returns {Promise<boolean>} true if a fish was caught, false otherwise.
     * @example
     * await skills.fish(bot);
     * await skills.fish(bot, 30000);
     **/
    let rod = bot.inventory.items().find(it => it.name.includes('fishing_rod'));
    if (!rod) {
        log(bot, "背包里没有鱼竿，没法钓鱼。");
        return false;
    }

    // 扫描附近所有水方块，找一个最佳钓鱼点：
    // 站在岸上（脚下是固体方块），到水面之间视线无遮挡
    let waterBlocks = world.getNearestBlocks(bot, 'water', 32, 200);
    if (!waterBlocks || waterBlocks.length === 0) {
        log(bot, "附近 32 格内没有水源，没法钓鱼。");
        return false;
    }

    // 检查从岸边看向水面，中间是否有固体方块遮挡视线
    function lineOfSightClear(fromX, fromY, fromZ, toX, toY, toZ) {
        let steps = Math.ceil(Math.max(Math.abs(toX - fromX), Math.abs(toZ - fromZ)));
        for (let i = 1; i < steps; i++) {
            let t = i / steps;
            let bx = Math.floor(fromX + (toX - fromX) * t);
            let by = Math.floor(fromY + (toY - fromY) * t + 1); // 视线高度（眼睛在脚下+1）
            let bz = Math.floor(fromZ + (toZ - fromZ) * t);
            let b = bot.blockAt(new Vec3(bx, by, bz));
            if (b && b.name !== 'air' && b.name !== 'water') return false;
        }
        return true;
    }

    let bestSpot = null;
    let bestScore = -1;
    let openWaterCount = 0; // 上方敞开（能放浮标）的水方块数量
    for (let w of waterBlocks) {
        // 水方块正上方必须是空气或水，否则浮标会被上面的方块挡住，
        // 落在方块上而不是水里（表现为"对着方块扔"）。
        let aboveWater = bot.blockAt(w.position.offset(0, 1, 0));
        // 水面正上方必须是空气（即上方敞开），不要求天空光照——大洞窟里的
        // 湖上方是洞窟空间（空气），能通过。只有正上方被草/石头盖住的封闭
        // 洞窟水域，以及上方还是水的水下层一律跳过：浮标是物理实体，落不进
        // 被方块盖住的水里，只会砸在盖子方块上（肉眼看不到的水就是这种情况）。
        if (!aboveWater || aboveWater.name !== 'air') continue;
        openWaterCount++;
        // 水方块四个水平方向找岸，同层和上层都查（圆石可能比水面高）
        for (let [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            for (let dy of [0, 1]) {
                let shoreX = w.position.x + dx;
                let shoreBlockY = w.position.y + dy;
                let shoreZ = w.position.z + dz;
                let shoreBlock = bot.blockAt(new Vec3(shoreX, shoreBlockY, shoreZ));
                let shoreAbove = bot.blockAt(new Vec3(shoreX, shoreBlockY + 1, shoreZ));
                // 岸必须是固体，上方是空气（能站）
                if (!shoreBlock || !shoreAbove) continue;
                if (shoreBlock.name === 'water' || shoreBlock.name === 'air') continue;
                if (shoreAbove.name !== 'air') continue;
                // 头部也必须是空气，否则在狭窄洞口站不直、挥不开竿
                let shoreHead = bot.blockAt(new Vec3(shoreX, shoreBlockY + 2, shoreZ));
                if (!shoreHead || shoreHead.name !== 'air') continue;
                // 站位 = 岸方块顶（脚踩在方块上面）
                let standY = shoreBlockY + 1;
                // 检查从站位到水面之间视线是否被遮挡
                if (!lineOfSightClear(shoreX, standY, shoreZ, w.position.x, w.position.y, w.position.z)) continue;
                // 站位开阔度：统计站位水平四邻在脚层(standY)和头层(standY+1)的
                // 空气数量。狭窄洞口周围都是墙，openness 低；开阔岸边 openness 高。
                let openness = 0;
                for (let [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    let f = bot.blockAt(new Vec3(shoreX + ox, standY, shoreZ + oz));
                    let h = bot.blockAt(new Vec3(shoreX + ox, standY + 1, shoreZ + oz));
                    if (f && f.name === 'air') openness++;
                    if (h && h.name === 'air') openness++;
                }
                // 朝水方向的连续敞开水面长度（抛竿方向能抛多远），最多记 8 格
                let waterLen = 1;
                for (let i = 1; i <= 8; i++) {
                    let cx = w.position.x - dx * i;
                    let cz = w.position.z - dz * i;
                    let col = bot.blockAt(new Vec3(cx, w.position.y, cz));
                    let above = bot.blockAt(new Vec3(cx, w.position.y + 1, cz));
                    if (!col || col.name !== 'water') break;
                    if (above && above.name !== 'air' && above.name !== 'water') break;
                    waterLen++;
                }
                // 评分：近的优先，但纳入开阔度和水面长度，避免钻进狭窄洞口
                let dist = Math.sqrt((shoreX - bot.entity.position.x) ** 2 + (shoreZ - bot.entity.position.z) ** 2);
                let score = (100 - dist) + openness * 3 + waterLen * 2;
                if (score > bestScore) {
                    bestScore = score;
                    bestSpot = { shoreX, shoreY: standY, shoreZ, water: w, dx, dz };
                }
            }
        }
    }

    if (!bestSpot) {
        log(bot, "找到了水但周围没有合适的岸可以站，没法钓鱼。");
        return false;
    }
    // 水域级评估：上方敞开的水方块太少，说明整片水域基本被覆盖，只有零星
    // 狭窄洞口露出来（人都不好进、更不好抛竿）。这种地方不适合钓鱼，直接放弃。
    // 阈值取 6：一个 2×3 的小水洼刚好够，低于此视为不值得钓。
    if (openWaterCount < 6) {
        log(bot, `这片水域上方敞开的水面太小（只有 ${openWaterCount} 格），地方太狭窄不适合钓鱼。`);
        return false;
    }

    log(bot, `找到最佳钓鱼点：站在 (${bestSpot.shoreX}, ${bestSpot.shoreY}, ${bestSpot.shoreZ})，面向水面 (${bestSpot.water.position.x}, ${bestSpot.water.position.y}, ${bestSpot.water.position.z})。`);
    await goToPosition(bot, bestSpot.shoreX, bestSpot.shoreY, bestSpot.shoreZ, 0);
    // 如果没站上去（高度不够），手动跳上去
    if (bot.entity.position.y < bestSpot.shoreY - 0.5) {
        log(bot, "岸有点高，跳上去。");
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        await wait(bot, 1000);
        bot.clearControlStates();
        await wait(bot, 500);
    }
    await bot.equip(rod, 'hand');
    await wait(bot, 500);

    // 钓鱼需要原地静等鱼上钩（最长 timeoutMs，远超 unstuck 的 20s 阈值），
    // 否则会被 unstuck 模式判定为卡住并中断。站定后暂停 unstuck，结束时恢复。
    bot.modes.pause('unstuck');
    try {

        // 记录钓鱼开始前的背包快照，并用 playerCollect 事件实时捕获本次钓获的
        // 物品（包括非鱼类：附魔书、墨囊、鞍、命名牌、线等），避免结尾只靠
        // "扫背包有没有鱼"推断而漏掉/误判。
        let invBefore = {};
        for (let it of bot.inventory.items()) invBefore[it.name] = (invBefore[it.name] || 0) + it.count;
        let catchLog = []; // 本次钓获的物品名列表（按次序）
        let catchHandler = (collector, collected) => {
            if (collector && collector.username === bot.username && collected) {
                // 掉落物实体的真名优先用 metadata.name，其次 droppedItem.name
                let name = collected.metadata?.name || collected.droppedItem?.name || null;
                if (name) catchLog.push(name);
            }
        };
        bot.on('playerCollect', catchHandler);

        // 朝水塘内部远处看（往水的反方向延伸），抛得更远；平视水面高度，加点随机偏移避免每次落点一样
        // 从选中的水方块往池塘内部逐格扫描，找到最远的上方敞开的水方块作为
        // 瞄准点。遇到固体方块（池塘对岸/边界）就停，避免瞄准点落在陆地上导致
        // 浮标飞过去砸在方块上（小池塘/有顶盖的水域尤其容易踩到）。
        let aimWater = bestSpot.water.position;
        let waterReach = 0; // 朝池塘内部能延伸多少格（不含起点那块）
        for (let i = 1; i <= 8; i++) {
            let cx = bestSpot.water.position.x - bestSpot.dx * i;
            let cz = bestSpot.water.position.z - bestSpot.dz * i;
            let cy = bestSpot.water.position.y;
            let col = bot.blockAt(new Vec3(cx, cy, cz));
            let above = bot.blockAt(new Vec3(cx, cy + 1, cz));
            // 必须是水，且上方敞开（空气或水），否则到了池塘边界，停止延伸
            if (!col || col.name !== 'water') break;
            if (above && above.name !== 'air' && above.name !== 'water') break;
            aimWater = new Vec3(cx, cy, cz);
            waterReach = i;
        }
        // 偏移幅度按水面延伸长度自适应：延伸越远越敢偏，但留 1 格安全余量不贴边；
        // 偏移只往池塘内部方向（dx/dz 的反方向）随机，不往岸方向偏，避免甩到岸上。
        // waterReach=0（紧挨岸）时偏移为 0，正好瞄起点那块水。
        let maxOffset = Math.max(0, waterReach - 1);
        let inwardDx = -bestSpot.dx; // 朝池塘内部的方向
        let inwardDz = -bestSpot.dz;
        let waterTarget = aimWater;
        function aimAtWater() {
            // 仅沿池塘内部方向偏移 0~maxOffset，避免偏到岸上
            let t = Math.random() * maxOffset;
            let ox = inwardDx * t;
            let oz = inwardDz * t;
            // 再加一点垂直于内部方向的微小扰动（±0.3），让落点不每次都一条直线
            let perpX = -inwardDz;
            let perpZ = inwardDx;
            let p = (Math.random() - 0.5) * 0.6;
            bot.lookAt(waterTarget.offset(ox + perpX * p, 0, oz + perpZ * p));
        }
        await aimAtWater();
        await wait(bot, 300);

        const MAX_CASTS = 5;
        let caught = false;
        for (let cast = 0; cast < MAX_CASTS; cast++) {
            // 被自卫/逃跑等中断模式打断时，立刻收竿退出，让打断模式接管。
            // wait() 虽在内部检查 interrupt_code，但返回后循环仍会继续，故此处显式判断。
            if (bot.interrupt_code) {
                // 收起鱼竿（如果在等鱼），避免抛出状态残留
                try { bot.activateItem(); } catch (_) { }
                log(bot, "钓鱼被打断了（可能需要自卫或脱困）。");
                break;
            }
            // 确保没站在水里；掉了水就停止本轮钓鱼，提示由 AI 主动用 !goToShore 上岸
            let feetBlock = bot.blockAt(bot.entity.position);
            if (feetBlock && feetBlock.name === 'water') {
                log(bot, "哎呀掉水里了！请用 !goToShore 让我爬回岸上。");
                return false;
            }

            bot.activateItem();
            log(bot, `第 ${cast + 1} 次抛竿，等待浮标落水...`);
            await wait(bot, 2500);

            // 找浮标，验证是否真在水里
            let bobber = null;
            for (const id in bot.entities) {
                const e = bot.entities[id];
                if (e.name === 'fishing_bobber' || e.name === 'bobber') { bobber = e; break; }
            }
            if (!bobber || !bobber.position) {
                log(bot, "没找到浮标，收竿重试。");
                bot.activateItem();
                await wait(bot, 1500);
                await aimAtWater();
                continue;
            }
            // 检查浮标下方是不是水
            let bobberBlock = bot.blockAt(bobber.position);
            let bobberBelow = bot.blockAt(bobber.position.offset(0, -0.5, 0));
            let inWater = (bobberBlock && bobberBlock.name === 'water') || (bobberBelow && bobberBelow.name === 'water');
            if (!inWater) {
                log(bot, `浮标落在陆地上 (${bobber.position.x}, ${bobber.position.y}, ${bobber.position.z})，换角度重试。`);
                bot.activateItem();
                await wait(bot, 1500);
                // 重新瞄准远处水面，带随机偏移
                await aimAtWater();
                continue;
            }

            log(bot, `浮标落水了，基准高度 y=${bobber.position.y.toFixed(2)}，等鱼上钩。`);
            let baseY = bobber.position.y;
            const castDeadline = Date.now() + timeoutMs;
            while (Date.now() < castDeadline) {
                // 重新获取浮标
                let cur = null;
                for (const id in bot.entities) {
                    const e = bot.entities[id];
                    if (e.name === 'fishing_bobber' || e.name === 'bobber') { cur = e; break; }
                }
                if (cur && cur.position && cur.position.y < baseY - 0.4) {
                    caught = true;
                    log(bot, "浮标下沉！鱼上钩啦！");
                    break;
                }
                // 浮标消失了（被收走/超时），跳出内层循环重抛
                if (!cur) {
                    log(bot, "浮标消失了，重新抛竿。");
                    break;
                }
                // 被自卫/逃跑等模式打断，立刻收竿退出
                if (bot.interrupt_code) {
                    try { bot.activateItem(); } catch (_) { }
                    log(bot, "等鱼时被打断了（可能需要自卫或脱困）。");
                    break;
                }
                await wait(bot, 200);
            }
            bot.activateItem();
            await wait(bot, 2000);
            if (caught) break;
        }

        log(bot, caught ? "收竿，有鱼上钩！" : `试了 ${MAX_CASTS} 次都没钓到。`);
        await wait(bot, 1000);

        // 移除本次钓鱼的 playerCollect 监听器
        bot.removeListener('playerCollect', catchHandler);

        // 对比背包增量，确认本次实际钓到了什么（事件可能丢，背包增量兜底）
        let gained = {};
        for (let it of bot.inventory.items()) {
            let before = invBefore[it.name] || 0;
            if (it.count > before) gained[it.name] = it.count - before;
        }
        // 合并事件捕获和背包增量，得到本次钓获的完整清单
        let caughtItems = Object.keys(gained);
        if (caughtItems.length === 0 && catchLog.length > 0) {
            caughtItems = [...new Set(catchLog)];
        }
        if (caughtItems.length > 0) {
            let summary = caughtItems.map(n => `${gained[n] || 1} 个 ${n}`).join('、');
            log(bot, `本次钓鱼收获：${summary}。`);
            return true;
        }
        log(bot, "这次没钓到任何东西。");
        return false;

    } finally {
        bot.modes.unpause('unstuck');
    }
}


export async function goToShore(bot) {
    /**
     * Find the nearest shore (a solid, standable block adjacent to water) and navigate onto it.
     * If the bot is currently in water it will climb out toward the closest shore; otherwise it
     * walks to the nearest shore spot. Intended to be triggered manually by the agent.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bot reached a shore spot, false otherwise.
     * @example
     * await skills.goToShore(bot);
     **/
    let feetBlock = bot.blockAt(bot.entity.position);
    let inWater = feetBlock && feetBlock.name === 'water';

    let waterBlocks = world.getNearestBlocks(bot, 'water', 32, 200);
    if (!waterBlocks || waterBlocks.length === 0) {
        log(bot, "附近 32 格内没有水源，找不到岸。");
        return false;
    }

    let bestSpot = null;
    let bestScore = -1;
    for (let w of waterBlocks) {
        for (let [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            for (let dy of [0, 1]) {
                let shoreX = w.position.x + dx;
                let shoreBlockY = w.position.y + dy;
                let shoreZ = w.position.z + dz;
                let shoreBlock = bot.blockAt(new Vec3(shoreX, shoreBlockY, shoreZ));
                let shoreAbove = bot.blockAt(new Vec3(shoreX, shoreBlockY + 1, shoreZ));
                if (!shoreBlock || !shoreAbove) continue;
                if (shoreBlock.name === 'water' || shoreBlock.name === 'air') continue;
                if (shoreAbove.name !== 'air') continue;
                let standY = shoreBlockY + 1;
                let dist = Math.sqrt((shoreX - bot.entity.position.x) ** 2 + (shoreZ - bot.entity.position.z) ** 2);
                let score = 100 - dist;
                if (score > bestScore) {
                    bestScore = score;
                    bestSpot = { shoreX, shoreY: standY, shoreZ };
                }
            }
        }
    }

    if (!bestSpot) {
        log(bot, "找到了水但周围没有合适的岸可以站。");
        return false;
    }

    log(bot, `最近的岸在 (${bestSpot.shoreX}, ${bestSpot.shoreY}, ${bestSpot.shoreZ})，正在上岸。`);

    if (inWater) {
        // 沿当前→岸方向单位向量，用于探测前方/上方阻挡方块
        let climbDx = bestSpot.shoreX - bot.entity.position.x;
        let climbDz = bestSpot.shoreZ - bot.entity.position.z;
        let len = Math.hypot(climbDx, climbDz) || 1;
        let fx = Math.round(climbDx / len);
        let fz = Math.round(climbDz / len);
        let yaw = Math.atan2(-climbDx, -climbDz);
        await bot.look(yaw, 0, false);

        // 窒息探测：挖掉头顶及前方阻挡上岸的固体方块，防止被淹死
        async function clearObstacles() {
            const pos = bot.entity.position;
            const head = bot.blockAt(pos.offset(0, 1, 0));
            if (head && head.name !== 'air' && head.name !== 'water') {
                try { await bot.tool.equipForBlock(head); } catch (_) { }
                try { await bot.dig(head, true); log(bot, `挖掉头顶的 ${head.name} 以便呼吸。`); } catch (e) { }
            }
            // 前方一格（同层和上一层）的阻挡方块
            for (let dy of [0, 1]) {
                let b = bot.blockAt(pos.offset(fx, dy, fz));
                if (b && b.name !== 'air' && b.name !== 'water') {
                    try { await bot.tool.equipForBlock(b); } catch (_) { }
                    try { await bot.dig(b, true); log(bot, `挖掉前方 ${b.name} 清出上岸通道。`); } catch (e) { }
                }
            }
        }

        for (let attempt = 0; attempt < 5; attempt++) {
            await clearObstacles();
            bot.setControlState('forward', true);
            bot.setControlState('jump', true);
            bot.setControlState('sprint', true);
            await wait(bot, 1500);
            bot.clearControlStates();
            await wait(bot, 400);
            let now = bot.blockAt(bot.entity.position);
            if (!now || now.name !== 'water') break;
            // 重新计算朝向（可能位置已变）
            let ndx = bestSpot.shoreX - bot.entity.position.x;
            let ndz = bestSpot.shoreZ - bot.entity.position.z;
            if (Math.hypot(ndx, ndz) > 0.1) {
                await bot.look(Math.atan2(-ndx, -ndz), 0, false);
                len = Math.hypot(ndx, ndz) || 1;
                fx = Math.round(ndx / len);
                fz = Math.round(ndz / len);
            }
        }
        let now = bot.blockAt(bot.entity.position);
        if (now && now.name === 'water') {
            log(bot, "爬了一会儿还在水里，尝试路径规划到岸边。");
            try { await goToPosition(bot, bestSpot.shoreX, bestSpot.shoreY, bestSpot.shoreZ, 0); } catch (_) { }
        }
    } else {
        try { await goToPosition(bot, bestSpot.shoreX, bestSpot.shoreY, bestSpot.shoreZ, 0); } catch (_) { }
        if (bot.entity.position.y < bestSpot.shoreY - 0.5) {
            bot.setControlState('forward', true);
            bot.setControlState('jump', true);
            await wait(bot, 1000);
            bot.clearControlStates();
            await wait(bot, 500);
        }
    }

    let final = bot.blockAt(bot.entity.position);
    if (final && final.name === 'water') {
        log(bot, "上岸失败，还在水里。");
        return false;
    }
    log(bot, "成功上岸！");
    return true;
}


export async function giveToPlayer(bot, itemType, username, num = 1) {
    if (bot.username === username) {
        log(bot, `不能给自己物品。`);
        return false;
    }

    let player = bot.players[username]?.entity;
    if (!player) {
        log(bot, `找不到玩家 ${username}。`);
        return false;
    }

    await goToPlayer(bot, username, 3);

    // 高度差纠正
    if (bot.entity.position.y < player.position.y - 1) {
        await goToPlayer(bot, username, 1);
    }

    // 暂停自动拾取，防止扔出后立刻被自己吸回背包
    const itemCollectWasOn = bot.modes.isOn('item_collecting');
    if (itemCollectWasOn) bot.modes.pause('item_collecting');

    let success = false;

    let collectHandler = null;

    try {
        // 朝玩家胸口/头部看，丢出的抛物线更自然，而不是往玩家脚丢
        await bot.lookAt(player.position.offset(0, 1.2, 0));

        let given = false;
        collectHandler = (collector, collected) => {
            if (collector.username === username) {
                log(bot, `${username} 收到了 ${itemType}。`);
                given = true;
            }
        };
        // 用 bot.on 持续监听，防止被别的拾取事件误消耗
        bot.on('playerCollect', collectHandler);

        if (await discard(bot, itemType, num)) {
            let start = Date.now();
            // 稍加长到 5000ms，防止网络稍有延迟误判失败
            while (!given && !bot.interrupt_code) {
                await new Promise(resolve => setTimeout(resolve, 300));
                if (given) {
                    success = true;
                    break;
                }
                if (Date.now() - start > 5000) {
                    break;
                }
            }
        }

        if (!success) {
            log(bot, `给 ${username} ${itemType} 失败，对方未收到或超时。`);
        }
    } finally {
        if (collectHandler) {
            bot.removeListener('playerCollect', collectHandler);
        }
        // 恢复自动拾取模式
        if (itemCollectWasOn) {
            try { bot.modes.unpause('item_collecting'); } catch (_) { }
        }
    }

    return success;
}

export async function goToGoal(bot, goal) {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     **/

    const nonDestructiveMovements = new pf.Movements(bot);
    const dontBreakBlocks = ['glass', 'glass_pane'];
    for (let block of dontBreakBlocks) {
        nonDestructiveMovements.blocksCantBreak.add(mc.getBlockId(block));
    }
    nonDestructiveMovements.canDig = false; // non-destructive path should never dig through blocks
    nonDestructiveMovements.placeCost = 2;

    const destructiveMovements = new pf.Movements(bot);
    // 破坏性 fallback 路径也要保护玩家建筑：把常见建筑方块加入禁止破坏列表，
    // 这样即使非破坏性路径没规划出来，bot 也不会直接抄近道挖穿房顶/墙，
    // 而是绕门或自然地形的缺口进入。仍可挖自然地形（泥土/石头/沙子/矿石等）脱困。
    // 门/活板门/栅栏门是 interactable，pathfinder 会开它们而不挖，故不在此列。
    for (const name of protectedBuildingBlocks) {
        const id = mc.getBlockId(name);
        if (id != null) destructiveMovements.blocksCantBreak.add(id);
    }

    let final_movements = destructiveMovements;

    // 非破坏性路径规划：给 3000ms（原来 1000ms 太短，稍复杂的绕门/绕地形路径
    // 规划不完就判失败，直接 fallback 到破坏性路径抄近道挖穿房顶）。
    const pathfind_timeout = 3000;
    if (await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout).status === 'success') {
        final_movements = nonDestructiveMovements;
        log(bot, `找到了非破坏性路径。`);
    }
    else if (await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout).status === 'success') {
        log(bot, `找到了破坏性路径（已保护玩家建筑）。`);
    }
    else {
        log(bot, `未找到路径，但尝试使用破坏性移动继续导航。`);
    }

    bot.pathfinder.setMovements(final_movements);
    // 门完全交给 pathfinder 的 canOpenDoors（默认 true）：A* 规划时把关着的门
    // 当 useOne 节点加进路径，monitorMovement 走到那格时自动 activateBlock 开门，
    // 双开门两扇都会开。无需任何外部接管/兜底——接管逻辑会和 pathfinder 抢控制权
    // 造成蹭门、goto 中断循环。
    await bot.pathfinder.goto(goal);
    return true;
}

export async function goToPosition(bot, x, y, z, min_distance = 2) {
    /**
     * Navigate to the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to. If null, the bot's current x coordinate will be used.
     * @param {number} y, the y coordinate to navigate to. If null, the bot's current y coordinate will be used.
     * @param {number} z, the z coordinate to navigate to. If null, the bot's current z coordinate will be used.
     * @param {number} distance, the distance to keep from the position. Defaults to 2.
     * @returns {Promise<boolean>} true if the position was reached, false otherwise.
     * @example
     * let position = world.world.getNearestBlock(bot, "oak_log", 64).position;
     * await skills.goToPosition(bot, position.x, position.y, position.x + 20);
     **/
    if (x == null || y == null || z == null) {
        log(bot, `缺少坐标，给定 x:${x} y:${y} z:${z}`);
        return false;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `已传送至 ${x}, ${y}, ${z}。`);
        return true;
    }

    const unbreakableBlockIds = new Set();
    const checkDigProgress = () => {
        if (bot.targetDigBlock) {
            const targetBlock = bot.targetDigBlock;
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (bot.game.gameMode !== 'creative' && !targetBlock.canHarvest(itemId)) {
                unbreakableBlockIds.add(targetBlock.type);
                log(bot, `路径规划停止：当前工具无法破坏 ${targetBlock.name}，将绕开同类方块。`);
                // make pathfinder avoid this block type on future recomputes
                try {
                    const moves = bot.pathfinder.movements;
                    if (moves) moves.blocksCantBreak.add(targetBlock.type);
                } catch (_) { }
                bot.pathfinder.stop();
                bot.stopDigging();
            }
        }
    };

    const progressInterval = setInterval(checkDigProgress, 1000);

    try {
        await goToGoal(bot, new pf.goals.GoalNear(x, y, z, min_distance));
        clearInterval(progressInterval);
        const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
        if (distance <= min_distance + 1) {
            log(bot, `已到达 ${x}, ${y}, ${z}。`);
            return true;
        }
        else {
            log(bot, `无法到达 ${x}, ${y}, ${z}，你还有 ${Math.round(distance)} 格远。`);
            return false;
        }
    } catch (err) {
        log(bot, `路径规划停止：${err.message}。`);
        clearInterval(progressInterval);
        return false;
    }
}

export async function goToNearestBlock(bot, blockType, min_distance = 2, range = 64) {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 64, 2);
     * **/
    const MAX_RANGE = 512;
    if (range > MAX_RANGE) {
        log(bot, `最大搜索范围限制在 ${MAX_RANGE}。`);
        range = MAX_RANGE;
    }
    let block = null;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType && block.metadata === 0, range, 1);
        if (blocks.length === 0) {
            log(bot, `在 ${range} 格内没有找到任何 ${blockType} 源方块，正在寻找不可收集的流动方块...`);
            blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType, range, 1);
        }
        block = blocks[0];
    }
    else {
        block = await world.getNearestBlockAsync(bot, blockType, range);
    }
    if (!block) {
        log(bot, `在 ${range} 格内没有找到任何 ${blockType}。`);
        return false;
    }
    // 统计附近同类型方块数量，让 bot 知道矿脉规模（否则只报"找到1个"导致挖矿给数量1）
    // 用找到方块周围的小范围统计（32 格足够估算矿脉），不走大范围 findBlocks 避免再次卡死事件循环。
    let count = 1;
    try {
        const all = world.getNearestBlocksWhere(bot, b => {
            if (!b) return false;
            if (b.name === blockType) return true;
            if (!b.position) return false;
            return b.position.x === block.position.x && b.position.y === block.position.y && b.position.z === block.position.z;
        }, 32, 128);
        count = all.length > 0 ? all.length : 1;
    } catch (_) {}
    log(bot, `在 ${block.position} 找到了 ${blockType}（附近约 ${count} 个），正在导航...`);
    const reached = await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
    return reached;
}

export async function goToNearestEntity(bot, entityType, min_distance = 2, range = 64) {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    let entity = world.getNearestEntityWhere(bot, entity => entity.name === entityType, range);
    if (!entity) {
        log(bot, `在 ${range} 格内没有找到任何 ${entityType}。`);
        return false;
    }
    let distance = bot.entity.position.distanceTo(entity.position);
    log(bot, `在 ${distance} 格外找到了 ${entityType}。`);
    await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
    return true;
}

export async function goToPlayer(bot, username, distance = 3) {
    /**
     * Navigate to the given player.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, the goal distance to the player.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    if (bot.username === username) {
        log(bot, `你已经在 ${username} 身边了。`);
        return true;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + username);
        log(bot, `已传送至 ${username}。`);
        return true;
    }

    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    bot.modes.pause('unstuck');
    bot.modes.pause('elbow_room');
    let player = bot.players[username]?.entity;
    if (!player) {
        log(bot, `找不到玩家 ${username}（可能离线或未加载）。`);
        bot.modes.unpause('unstuck');
        bot.modes.unpause('elbow_room');
        return false;
    }

    distance = Math.max(distance, 0.5);
    const goal = new pf.goals.GoalFollow(player, distance);

    try {
        await goToGoal(bot, goal, true);
        log(bot, `已到达 ${username} 身边。`);
    } finally {
        bot.modes.unpause('unstuck');
        bot.modes.unpause('elbow_room');
    }
}


export async function followPlayer(bot, username, distance = 4) {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     **/
    let player = bot.players[username]?.entity;
    if (!player)
        return false;

    const move = new pf.Movements(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);

    bot.pathfinder.setGoal(new pf.goals.GoalFollow(player, distance), true);
    log(bot, `你现在正在跟随玩家 ${username}。`);


    while (!bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // in cheat mode, if the distance is too far, teleport to the player
        const distance_from_player = bot.entity.position.distanceTo(player.position);

        const teleport_distance = 100;
        const ignore_modes_distance = 30;
        const nearby_distance = distance + 2;

        if (distance_from_player > teleport_distance && bot.modes.isOn('cheat')) {
            // teleport with cheat mode
            await goToPlayer(bot, username);
        }
        else if (distance_from_player > ignore_modes_distance) {
            // these modes slow down the bot, and we want to catch up
            bot.modes.pause('item_collecting');
            bot.modes.pause('hunting');
            bot.modes.pause('torch_placing');
        }
        else if (distance_from_player <= ignore_modes_distance) {
            bot.modes.unpause('item_collecting');
            bot.modes.unpause('hunting');
            bot.modes.unpause('torch_placing');
        }

        if (distance_from_player <= nearby_distance) {
            bot.modes.pause('unstuck');
            bot.modes.pause('elbow_room');
        }
        else {
            bot.modes.unpause('unstuck');
            bot.modes.unpause('elbow_room');
        }
    }
    return true;
}


export async function moveAway(bot, distance) {
    /**
     * Move away from current position in any direction.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.moveAway(bot, 8);
     **/
    const pos = bot.entity.position;
    let goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));

    if (bot.modes.isOn('cheat')) {
        const move = new pf.Movements(bot);
        const path = await bot.pathfinder.getPathTo(move, inverted_goal, 10000);
        let last_move = path.path[path.path.length - 1];
        if (last_move) {
            let x = Math.floor(last_move.x);
            let y = Math.floor(last_move.y);
            let z = Math.floor(last_move.z);
            bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
            return true;
        }
    }

    await goToGoal(bot, inverted_goal);
    let new_pos = bot.entity.position;
    log(bot, `从 ${pos.floored()} 移动到了 ${new_pos.floored()}。`);
    return true;
}

export async function moveAwayFromEntity(bot, entity, distance = 16) {
    /**
     * Move away from the given entity.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to move away from.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     **/
    let goal = new pf.goals.GoalFollow(entity, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));
    await bot.pathfinder.goto(inverted_goal);
    return true;
}

export async function avoidEnemies(bot, distance = 16) {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     **/
    bot.modes.pause('self_preservation'); // prevents damage-on-low-health from interrupting the bot
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
    while (enemy) {
        const follow = new pf.goals.GoalFollow(enemy, distance + 1); // move a little further away
        const inverted_goal = new pf.goals.GoalInvert(follow);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        bot.pathfinder.setGoal(inverted_goal, true);
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
        if (bot.interrupt_code) {
            break;
        }
        if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) {
            await attackEntity(bot, enemy, false);
        }
    }
    bot.pathfinder.stop();
    log(bot, `远离敌人 ${distance} 格。`);
    return true;
}

export async function stay(bot, seconds = 30) {
    /**
     * Stay in the current position until interrupted. Disables all modes.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     **/
    bot.modes.pause('self_preservation');
    bot.modes.pause('unstuck');
    bot.modes.pause('cowardice');
    bot.modes.pause('self_defense');
    bot.modes.pause('hunting');
    bot.modes.pause('torch_placing');
    bot.modes.pause('item_collecting');
    let start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds * 1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `停留了 ${(Date.now() - start) / 1000} 秒。`);
    return true;
}

export async function useDoor(bot, door_pos = null) {
    /**
     * Use the door at the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    if (!door_pos) {
        for (let door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
            'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
            const nearestDoor = world.getNearestBlock(bot, door_type, 16);
            if (nearestDoor) {
                door_pos = nearestDoor.position;
                break;
            }
        }
    } else {
        door_pos = Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `附近没有找到门。`);
        return false;
    }

    bot.pathfinder.setGoal(new pf.goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
    const startTime = Date.now();
    while (bot.pathfinder.isMoving() && Date.now() - startTime < 1500) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    bot.pathfinder.stop();

    const door_block = bot.blockAt(door_pos);
    if (!door_block) {
        log(bot, `门 ${door_pos} 不存在。`);
        return false;
    }

    await bot.lookAt(door_pos.offset(0.5, 1, 0.5));
    if (!door_block._properties?.open) {
        await bot.activateBlock(door_block);
        await new Promise((resolve) => setTimeout(resolve, 150));
    }

    bot.setControlState("forward", true);
    bot.setControlState("sprint", true);
    await new Promise((resolve) => setTimeout(resolve, 350));
    bot.clearControlStates();

    log(bot, `使用了 ${door_pos} 处的门。`);
    return true;
}

export async function goToBed(bot) {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    const beds = bot.findBlocks({
        matching: (block) => {
            return block.name.includes('bed');
        },
        maxDistance: 32,
        count: 1
    });
    if (beds.length === 0) {
        log(bot, `附近没有找到床可以睡觉。`);
        return false;
    }
    let loc = beds[0];
    await goToPosition(bot, loc.x, loc.y, loc.z);
    const bed = bot.blockAt(loc);
    await bot.sleep(bed);
    log(bot, `你上床了。`);
    bot.modes.pause('unstuck');
    while (bot.isSleeping) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `你醒了。`);
    return true;
}

export async function tillAndSow(bot, x, y, z, seedType = null) {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} plantType, the type of plant to plant. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if the ground was tilled, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.x, "wheat");
     **/
    let pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    let block = bot.blockAt(pos);
    log(bot, `正在 x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} 种植 ${seedType}。`);

    if (bot.modes.isOn('cheat')) {
        let to_remove = ['_seed', '_seeds'];
        for (let remove of to_remove) {
            if (seedType.endsWith(remove)) {
                seedType = seedType.replace(remove, '');
            }
        }
        placeBlock(bot, 'farmland', x, y, z);
        placeBlock(bot, seedType, x, y + 1, z);
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `无法耕 ${block.name}，必须是草方块或泥土。`);
        return false;
    }
    let above = bot.blockAt(new Vec3(x, y + 1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `土地已经被 ${above.name} 耕种过了。`);
            return true;
        }
        let broken = await breakBlockAt(bot, x, y + 1, z);
        if (!broken) {
            log(bot, `无法破坏上方方块来耕地。`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    if (block.name !== 'farmland') {
        let hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
        let to_equip = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            log(bot, `没有锄头，无法耕地。`);
            return false;
        }
        await bot.activateBlock(block);
        log(bot, `已耕 x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} 处的土地。`);
    }

    if (seedType) {
        if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
            seedType += 's'; // fixes common mistake
        let equipped_seeds = await equip(bot, seedType);
        if (!equipped_seeds) {
            log(bot, `没有 ${seedType} 可以种植。`);
            return false;
        }

        await bot.activateBlock(block);
        log(bot, `在 x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} 种植了 ${seedType}。`);
    }
    return true;
}

export async function activateNearestBlock(bot, type) {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    let block = world.getNearestBlock(bot, type, 16);
    if (!block) {
        log(bot, `附近没有找到 ${type} 可以激活。`);
        return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    await bot.activateBlock(block);
    log(bot, `在 x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)} 激活了 ${type}。`);
    return true;
}

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot, id) {
    id = id + "";
    const entity = bot.entities[id];

    if (!entity) {
        log(bot, `找不到 id 为 ${id} 的村民`);
        let entities = world.getNearbyEntities(bot, 16);
        let villager_list = "Available villagers:\n";
        for (let entity of entities) {
            if (entity.name === 'villager') {
                if (entity.metadata && entity.metadata[16] === 1) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (villager_list === "Available villagers:\n") {
            log(bot, "附近没有找到村民。");
            return null;
        }
        log(bot, villager_list);
        return null;
    }

    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        log(bot, '该实体不是村民');
        return null;
    }

    if (entity.metadata && entity.metadata[16] === 1) {
        log(bot, '这是幼年村民或没有职业的村民，两者都无法交易');
        return null;
    }

    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `村民在 ${distance.toFixed(1)} 格外，正在靠近...`);
        try {
            bot.modes.pause('unstuck');
            const goal = new pf.goals.GoalFollow(entity, 2);
            await goToGoal(bot, goal);


            log(bot, '成功到达村民身边');
        } catch (err) {
            log(bot, '无法到达村民身边 - 寻路错误或村民移动了');
            console.log(err);
            return null;
        } finally {
            bot.modes.unpause('unstuck');
        }
    }

    return entity;
}

/**
 * Show available trades for a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to show trades for
 * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
 * @example
 * await skills.showVillagerTrades(bot, "123");
 */
export async function showVillagerTrades(bot, id) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }

    try {
        const villager = await bot.openVillager(villagerEntity);

        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }

        log(bot, `村民有 ${villager.trades.length} 个可用交易：`);
        stringifyTrades(bot, villager.trades).forEach((trade, i) => {
            const tradeInfo = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });

        villager.close();
        return true;
    } catch (err) {
        log(bot, '无法打开村民交易界面 - 可能在睡觉、是幼年村民或没有职业');
        console.log('Villager trading error:', err.message);
        return false;
    }
}

/**
 * Trade with a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to trade with
 * @param {number} index - the index (1-based) of the trade to execute
 * @param {number} count - how many times to execute the trade (optional)
 * @returns {Promise<boolean>} true if trade was successful, false otherwise
 * @example
 * await skills.tradeWithVillager(bot, "123", "1", "2");
 */
export async function tradeWithVillager(bot, id, index, count) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }

    try {
        const villager = await bot.openVillager(villagerEntity);

        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }

        const tradeIndex = parseInt(index) - 1; // Convert to 0-based index
        const trade = villager.trades[tradeIndex];

        if (!trade) {
            log(bot, `找不到交易 ${index}。这个村民有 ${villager.trades.length} 个可用交易。`);
            villager.close();
            return false;
        }

        if (trade.disabled) {
            log(bot, `交易 ${index} 当前已禁用`);
            villager.close();
            return false;
        }

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2) + ' ' : '';
        log(bot, `正在交易 ${stringifyItem(bot, trade.inputItem1)} ${item_2}换取 ${stringifyItem(bot, trade.outputItem)}...`);

        const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount = count;
        const actualCount = Math.min(requestedCount, maxPossibleTrades);

        if (actualCount <= 0) {
            log(bot, `交易 ${index} 已达到最大使用次数`);
            villager.close();
            return false;
        }

        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `没有足够的资源来执行交易 ${index} ${actualCount} 次`);
            villager.close();
            return false;
        }

        log(bot, `正在执行交易 ${index} ${actualCount} 次...`);

        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `成功交易了 ${actualCount} 次`);
            villager.close();
            return true;
        } catch (tradeErr) {
            log(bot, '执行交易时发生错误');
            console.log('Trade execution error:', tradeErr.message);
            villager.close();
            return false;
        }
    } catch (err) {
        log(bot, '无法打开村民交易界面');
        console.log('Villager interface error:', err.message);
        return false;
    }
}

function hasResources(window, trade, count) {
    const first = enough(trade.inputItem1, count);
    const second = !trade.inputItem2 || enough(trade.inputItem2, count);
    return first && second;

    function enough(item, count) {
        let c = 0;
        window.forEach((element) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot, trades) {
    return trades.map((trade) => {
        let text = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot, item) {
    if (!item) return 'nothing';
    let text = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench = item.nbt.value.ench;
        const StoredEnchantments = item.nbt.value.StoredEnchantments;
        const Potion = item.nbt.value.Potion;
        const display = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e) => {
                const lvl = e.lvl.value;
                const id = e.id.value;
                return bot.registry.enchantments[id].displayName + ' ' + lvl;
            }).join(' ')}`;
        }
    }
    return text;
}

export async function digDown(bot, distance = 10) {
    /**
     * Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, distance to dig down.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/

    let start_block_pos = bot.blockAt(bot.entity.position).position;
    for (let i = 1; i <= distance; i++) {
        const targetBlock = bot.blockAt(start_block_pos.offset(0, -i, 0));
        let belowBlock = bot.blockAt(start_block_pos.offset(0, -i - 1, 0));

        if (!targetBlock || !belowBlock) {
            log(bot, `向下挖了 ${i - 1} 格，但到达了世界尽头。`);
            return true;
        }

        // Check for lava, water
        if (targetBlock.name === 'lava' || targetBlock.name === 'water' ||
            belowBlock.name === 'lava' || belowBlock.name === 'water') {
            log(bot, `向下挖了 ${i - 1} 格，但遇到了 ${belowBlock ? belowBlock.name : '(熔岩/水)'}`)
            return false;
        }

        const MAX_FALL_BLOCKS = 2;
        let num_fall_blocks = 0;
        for (let j = 0; j <= MAX_FALL_BLOCKS; j++) {
            if (!belowBlock || (belowBlock.name !== 'air' && belowBlock.name !== 'cave_air')) {
                break;
            }
            num_fall_blocks++;
            belowBlock = bot.blockAt(belowBlock.position.offset(0, -1, 0));
        }
        if (num_fall_blocks > MAX_FALL_BLOCKS) {
            log(bot, `向下挖了 ${i - 1} 格，但下方是空的。`);
            return false;
        }

        if (targetBlock.name === 'air' || targetBlock.name === 'cave_air') {
            log(bot, '跳过空气方块');
            console.log(targetBlock.position);
            continue;
        }

        let dug = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
        if (!dug) {
            log(bot, '无法挖掘位置处的方块:' + targetBlock.position);
            return false;
        }
    }
    log(bot, `向下挖了 ${distance} 格。`);
    return true;
}

export async function goToSurface(bot) {
    /**
     * Navigate to the surface (highest non-air block at current x,z).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     **/
    const pos = bot.entity.position;
    let surfaceY = null;
    for (let y = 360; y > -64; y--) { // probably not the best way to find the surface but it works
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') {
            continue;
        }
        surfaceY = y + 1; // 站到该方块上方
        break;
    }
    if (surfaceY == null) {
        log(bot, `找不到当前位置上方的地表。`);
        return false;
    }
    // 用 GoalY 而非 GoalNear(当前x,z,0)：从深坑回地表时，正上方那一列常被
    // 2 格高墙挡住跳不上去，但周围有 1 格台阶可以逐级跳出。GoalNear 锁死到
    // 当前 x,z 一列，pathfinder 只会死磕正前方的 2 高墙（跳不上去、挖也够
    // 不到顶），耗到 unstuck 触发也不解决，最终卡死。GoalY 只要求到达该 y
    // 层、不限 x/z，pathfinder 就能转向周围 1 格台阶逐级攀爬脱困。
    await goToGoal(bot, new pf.goals.GoalY(surfaceY));
    const distY = Math.abs(bot.entity.position.y - surfaceY);
    if (distY < 2) {
        log(bot, `已到达 y=${surfaceY} 的地表。`);
        return true;
    }
    log(bot, `未能到达 y=${surfaceY} 的地表，当前 y=${bot.entity.position.y.toFixed(1)}。`);
    return false;
}

export async function useToolOn(bot, toolName, targetName) {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     */
    if (!bot.inventory.slots.find(slot => slot && slot.name === toolName) && !bot.game.gameMode === 'creative') {
        log(bot, `你没有 ${toolName} 可以使用。`);
        return false;
    }

    targetName = targetName.toLowerCase();
    if (targetName === 'nothing') {
        const equipped = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await bot.activateItem();
        log(bot, `使用了 ${toolName}。`);
    } else if (world.isEntityType(targetName)) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === targetName, 64);
        if (!entity) {
            log(bot, `附近没有找到 ${targetName}。`);
            return false;
        }
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z);
        if (toolName === 'hand') {
            await bot.unequip('hand');
        }
        else {
            const equipped = await equip(bot, toolName);
            if (!equipped) return false;
        }
        await bot.useOn(entity);
        log(bot, `对 ${targetName} 使用了 ${toolName}。`);
    } else {
        let block = null;
        if (targetName === 'water' || targetName === 'lava') {
            // we want to get liquid source blocks, not flowing blocks
            // so search for blocks with metadata 0 (not flowing)
            let blocks = world.getNearestBlocksWhere(bot, block => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                log(bot, `附近没有找到 ${targetName} 源。`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `附近没有找到 ${targetName}。`);
            return false;
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
}

export async function useToolOnBlock(bot, toolName, block) {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

    const distance = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = () => {
        const blockInView = bot.blockAtCursor(5);
        const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView &&
            !blockInView.position.equals(block.position) &&
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    }
    const blockInView = bot.blockAtCursor(5);
    if (viewBlocked()) {
        log(bot, `方块 ${blockInView.name} 挡住了路，正在靠近...`);
        // choose random block next to target block, go to it
        const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
        await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        if (viewBlocked()) {
            const blockInView = bot.blockAtCursor(5);
            log(bot, `方块 ${blockInView.name} 挡住了路，不使用 ${toolName}。`);
            return false;
        }
    }

    const equipped = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `无法装备 ${toolName}。`);
        return false;
    }
    if (toolName.includes('bucket')) {
        await bot.activateItem();
    }
    else {
        await bot.activateBlock(block);
    }
    log(bot, `对 ${block.name} 使用了 ${toolName}。`);
    return true;
}
