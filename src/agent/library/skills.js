import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../settings.js";

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;

export function log(bot, message) {
    bot.output += message + '\n';
}

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) {return false;}
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

export async function craftRecipe(bot, itemName, num=1) {
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
        if(!recipes || recipes.length === 0) break placeTable; //Don't bother going to the table if we don't have the required resources.

        // Look for crafting table
        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null){

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
        await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
    }

    const recipe = recipes[0];
    console.log('crafting...');
    //Check that the agent has sufficient items to use the recipe `num` times.
    const inventory = world.getInventoryCounts(bot); //Items in the agents inventory
    const requiredIngredients = mc.ingredientsFromPrismarineRecipe(recipe); //Items required to use the recipe once.
    const craftLimit = mc.calculateLimitingResource(inventory, requiredIngredients);
    
    await bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable);
        if(craftLimit.num<num) log(bot, `${craftLimit.limitingResource} 不够合成 ${num} 个，只合成了 ${craftLimit.num} 个。你现在有 ${world.getInventoryCounts(bot)[itemName]} 个 ${itemName}。`);
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

export async function smeltItem(bot, itemName, num=1) {
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

    let placedFurnace = false;
    let furnaceBlock = undefined;
    const furnaceRange = 16;
    furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock){
        // Try to place furnace
        let hasFurnace = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            let pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
            await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
            furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
            placedFurnace = true;
        }
    }
    if (!furnaceBlock){
        log(bot, `附近没有熔炉，你也没有熔炉。`)
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, furnaceRange);
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


export async function attackNearest(bot, mobType, kill=true) {
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

export async function attackEntity(bot, entity, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    let pos = entity.position;
    await equipHighestAttack(bot)

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...')
            await goToPosition(bot, pos.x, pos.y, pos.z);
        }
        console.log('attacking mob...')
        await bot.attack(entity);
    }
    else {
        bot.pvp.attack(entity);
        while (world.getNearbyEntities(bot, 24).includes(entity)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (bot.interrupt_code) {
                bot.pvp.stop();
                return false;
            }
        }
        log(bot, `成功击杀了 ${entity.name}。`);
        await pickupNearbyItems(bot);
        return true;
    }
}

export async function defendSelf(bot, range=9) {
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
    let attacked = false;
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
    while (enemy) {
        await equipHighestAttack(bot);
        if (bot.entity.position.distanceTo(enemy.position) >= 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                await bot.pathfinder.goto(new pf.goals.GoalFollow(enemy, 3.5), true);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        if (bot.entity.position.distanceTo(enemy.position) <= 2) {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                let inverted_goal = new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, 2));
                await bot.pathfinder.goto(inverted_goal, true);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        bot.pvp.attack(enemy);
        attacked = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
        if (bot.interrupt_code) {
            bot.pvp.stop();
            return false;
        }
    }
    bot.pvp.stop();
    if (attacked)
        log(bot, `成功自卫。`);
    else
        log(bot, `附近没有敌人需要自卫。`);
    return attacked;
}



export async function collectBlock(bot, blockType, num=1, exclude=null) {
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
        blocktypes.push(blockType+'_ore');
    if (blockType.endsWith('ore'))
        blocktypes.push('deepslate_'+blockType);
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    const isLiquid = blockType === 'lava' || blockType === 'water';

    let collected = 0;

    const movements = new pf.Movements(bot);
    movements.dontMineUnderFallingBlock = false;
    movements.dontCreateFlow = true;

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks = ['obsidian'];

    for (let i=0; i<num; i++) {
        let blocks = world.getNearestBlocksWhere(bot, block => {
            if (!blocktypes.includes(block.name)) {
                return false;
            }
            if (exclude) {
                for (let position of exclude) {
                    if (block.position.x === position.x && block.position.y === position.y && block.position.z === position.z) {
                        return false;
                    }
                }
            }
            if (isLiquid) {
                // collect only source blocks
                return block.metadata === 0;
            }
            
            return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
        }, 64, 1);

        if (blocks.length === 0) {
            if (collected === 0)
                log(bot, `附近没有 ${blockType} 可以收集。`);
            else
                log(bot, `附近没有更多 ${blockType} 可以收集。`);
            break;
        }
        const block = blocks[0];
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
                await bot.collectBlock.collect(block);
                success = true;
            }
            if (success)
                collected++;
            await autoLight(bot);
        }
        catch (err) {
            if (err.name === 'NoChests') {
                log(bot, `收集 ${blockType} 失败：背包已满，没有地方存放。`);
                break;
            }
            else {
                log(bot, `收集 ${blockType} 失败：${err}。`);
                continue;
            }
        }
        
        if (bot.interrupt_code)
            break;  
    }
        log(bot, `收集了 ${collected} 个 ${blockType}。`);
    return collected > 0;
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
    let nearestItem = getNearestItem(bot);
    let pickedUp = 0;
    while (nearestItem) {
        let movements = new pf.Movements(bot);
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 1));
        await new Promise(resolve => setTimeout(resolve, 200));
        let prev = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            break;
        }
        pickedUp++;
    }
        log(bot, `捡起了 ${pickedUp} 个物品。`);
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


export async function placeBlock(bot, blockType, x, y, z, placeOn='bottom', dontCheat=false) {
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
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y+1) + ' ' + Math.floor(z) + ' ' + blockType + '[half=upper]');
        if (blockType.includes('bed'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z-1) + ' ' + blockType + '[part=head]');
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
    const pos_above = pos.plus(Vec3(0,1,0));
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

export async function discard(bot, itemName, num=-1) {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
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

export async function putInChest(bot, itemName, num=-1) {
    /**
     * Put the given item in the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, the number of items to put in the chest. Defaults to -1, which puts all items.
     * @returns {Promise<boolean>} true if the item was put in the chest, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
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
    await chestContainer.deposit(item.type, null, to_put);
    await chestContainer.close();
        log(bot, `成功将 ${to_put} 个 ${itemName} 放入箱子。`);
    return true;
}

export async function takeFromChest(bot, itemName, num=-1) {
    /**
     * Take the given item from the nearest chest, potentially from multiple slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, the number of items to take from the chest. Defaults to -1, which takes all items.
     * @returns {Promise<boolean>} true if the item was taken from the chest, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `附近没有找到箱子。`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    
    // Find all matching items in the chest
    let matchingItems = chestContainer.containerItems().filter(item => item.name === itemName);
    if (matchingItems.length === 0) {
        log(bot, `箱子里没有找到 ${itemName}。`);
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
    
    await chestContainer.close();
        log(bot, `成功从箱子中取出了 ${totalTaken} 个 ${itemName}。`);
    return totalTaken > 0;
}

export async function viewChest(bot) {
    /**
     * View the contents of the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `附近没有找到箱子。`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    let items = chestContainer.containerItems();
    if (items.length === 0) {
        log(bot, `箱子是空的。`);
    }
    else {
        log(bot, `箱子内容：`);
        for (let item of items) {
            log(bot, `${item.count} 个 ${item.name}`);
        }
    }
    await chestContainer.close();
    return true;
}

export async function consume(bot, itemName="") {
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
    // auto-eat 插件会把食物留在副手，导致 consume 失败；先清空副手再装备到主手
    try {
        const offHand = bot.inventory.slots[bot.inventory.getEquipmentSlot('off-hand')];
        if (offHand && offHand.name === item.name) {
            await bot.unequip('off-hand');
        }
    } catch (_) {}
    await bot.equip(item, 'hand');
    await bot.consume();
        log(bot, `已食用 ${item.name}。`);
    return true;
}


export async function fish(bot, timeoutMs=60000) {
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
        let steps = Math.ceil(Math.max(Math.abs(toX-fromX), Math.abs(toZ-fromZ)));
        for (let i = 1; i < steps; i++) {
            let t = i / steps;
            let bx = Math.floor(fromX + (toX-fromX)*t);
            let by = Math.floor(fromY + (toY-fromY)*t + 1); // 视线高度（眼睛在脚下+1）
            let bz = Math.floor(fromZ + (toZ-fromZ)*t);
            let b = bot.blockAt(new Vec3(bx, by, bz));
            if (b && b.name !== 'air' && b.name !== 'water') return false;
        }
        return true;
    }

    let bestSpot = null;
    let bestScore = -1;
    for (let w of waterBlocks) {
        // 水方块四个水平方向找岸，同层和上层都查（圆石可能比水面高）
        for (let [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
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
                // 站位 = 岸方块顶（脚踩在方块上面）
                let standY = shoreBlockY + 1;
                // 检查从站位到水面之间视线是否被遮挡
                if (!lineOfSightClear(shoreX, standY, shoreZ, w.position.x, w.position.y, w.position.z)) continue;
                // 评分：离当前位置越近越好
                let dist = Math.sqrt((shoreX - bot.entity.position.x)**2 + (shoreZ - bot.entity.position.z)**2);
                let score = 100 - dist;
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

    // 朝水塘内部远处看（往水的反方向延伸），抛得更远；平视水面高度，加点随机偏移避免每次落点一样
    let farWaterX = bestSpot.water.position.x - bestSpot.dx * 5;
    let farWaterZ = bestSpot.water.position.z - bestSpot.dz * 5;
    let waterTarget = new Vec3(farWaterX, bestSpot.water.position.y, farWaterZ);
    function aimAtWater() {
        let randX = (Math.random() - 0.5) * 3;
        let randZ = (Math.random() - 0.5) * 3;
        bot.lookAt(waterTarget.offset(randX, 0, randZ));
    }
    await aimAtWater();
    await wait(bot, 300);

    const MAX_CASTS = 5;
    let caught = false;
    for (let cast = 0; cast < MAX_CASTS; cast++) {
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
            await wait(bot, 200);
        }
        bot.activateItem();
        await wait(bot, 2000);
        if (caught) break;
    }

    log(bot, caught ? "收竿，有鱼上钩！" : `试了 ${MAX_CASTS} 次都没钓到。`);
    await wait(bot, 1000);

    const fishNames = ['cod', 'salmon', 'pufferfish', 'tropical_fish'];
    let fishItem = bot.inventory.items().find(it => fishNames.includes(it.name));
    if (fishItem) {
        log(bot, `背包里有 ${fishItem.count} 个 ${fishItem.name}，钓鱼成功！`);
        return true;
    }
    log(bot, "背包里没找到鱼，可能没钓到。");
    return false;
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
        for (let [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
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
                let dist = Math.sqrt((shoreX - bot.entity.position.x)**2 + (shoreZ - bot.entity.position.z)**2);
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
                try { await bot.tool.equipForBlock(head); } catch (_) {}
                try { await bot.dig(head, true); log(bot, `挖掉头顶的 ${head.name} 以便呼吸。`); } catch (e) {}
            }
            // 前方一格（同层和上一层）的阻挡方块
            for (let dy of [0, 1]) {
                let b = bot.blockAt(pos.offset(fx, dy, fz));
                if (b && b.name !== 'air' && b.name !== 'water') {
                    try { await bot.tool.equipForBlock(b); } catch (_) {}
                    try { await bot.dig(b, true); log(bot, `挖掉前方 ${b.name} 清出上岸通道。`); } catch (e) {}
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
            try { await goToPosition(bot, bestSpot.shoreX, bestSpot.shoreY, bestSpot.shoreZ, 0); } catch (_) {}
        }
    } else {
        try { await goToPosition(bot, bestSpot.shoreX, bestSpot.shoreY, bestSpot.shoreZ, 0); } catch (_) {}
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


export async function giveToPlayer(bot, itemType, username, num=1) {
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
            try { bot.modes.unpause('item_collecting'); } catch (_) {}
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
    nonDestructiveMovements.allow1by1towers = true;
    nonDestructiveMovements.placeCost = 1;
    nonDestructiveMovements.digCost = 100;

    const destructiveMovements = new pf.Movements(bot);
    destructiveMovements.allow1by1towers = true;
    destructiveMovements.placeCost = 2;
    destructiveMovements.digCost = 20;


    const pathfind_timeout = 1000;
    if (await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout).status === 'success') {
        final_movements = nonDestructiveMovements;
        log(bot, `找到了非破坏性路径。`);
    }
    else if (await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout).status === 'success') {
        log(bot, `找到了破坏性路径。`);
    }
    else {
        log(bot, `未找到路径，但尝试使用破坏性移动继续导航。`);
    }

    const doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setMovements(final_movements);
    try {
        await bot.pathfinder.goto(goal);
        clearInterval(doorCheckInterval);
        return true;
    } catch (err) {
        clearInterval(doorCheckInterval);
        // we need to catch so we can clean up the door check interval, then rethrow the error
        throw err;
    }
}

let _doorInterval = null;
function startDoorInterval(bot) {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    if (_doorInterval) {
        clearInterval(_doorInterval);
    }
    let prev_pos = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;
    let isResolving = false;

    async function digObstacle(bot) {
        const pos = bot.entity.position;
        const yaw = bot.entity.yaw;
        const fx = Math.round(-Math.sin(yaw));
        const fz = Math.round(Math.cos(yaw));
        const passable = ['air', 'cave_air', 'water', 'lava', 'bedrock'];
        const dirs = [
            [fx, 0, fz], [fx, 1, fz], [fx, 2, fz],
            [0, 1, 0], [0, 2, 0],
            [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
        ];
        // 收集候选阻挡方块
        let candidates = [];
        for (const [dx, dy, dz] of dirs) {
            const block = bot.blockAt(pos.offset(dx, dy, dz));
            if (!block || passable.includes(block.name)) continue;
            candidates.push(block);
        }
        // 智能排序：优先当前工具能挖且最软的，挖不动的排后面
        const isCreative = bot.game.gameMode === 'creative';
        const canDig = (b, id) => isCreative || b.canHarvest(id);
        const hardnessOf = b => (typeof b.hardness === 'number' && b.hardness >= 0) ? b.hardness : 99;
        candidates.sort((a, b) => {
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            const aCan = canDig(a, itemId);
            const bCan = canDig(b, itemId);
            if (aCan !== bCan) return aCan ? -1 : 1;
            return hardnessOf(a) - hardnessOf(b);
        });
        for (const block of candidates) {
            try {
                await bot.tool.equipForBlock(block);
                const itemId = bot.heldItem ? bot.heldItem.type : null;
                if (!canDig(block, itemId)) continue; // 换了工具还是挖不动，跳过
                await bot.dig(block, true);
                log(bot, `挖掉卡路的 ${block.name} 以脱困。`);
                return true;
            } catch (_) {}
        }
        return false;
    }

    const doorCheckInterval = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }
        
        if (stuck_time > 1200 && !isResolving) {
            isResolving = true;
            stuck_time = 0;
            // shuffle positions so we're not always opening the same door
            const positions = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1), 
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ]
            let elevated_positions = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet
            
            let currentIndex = positions.length;
            while (currentIndex != 0) {
                let randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }
            
            let openedDoor = false;
            for (let position of positions) {
                let block = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor'))) 
                {
                    bot.activateBlock(block);
                    openedDoor = true;
                    break;
                }
            }
            // 没有门可开就挖掉前方/头顶阻挡的方块（狭窄洞穴卡住）
            if (!openedDoor) {
                digObstacle(bot).finally(() => { isResolving = false; });
            } else {
                isResolving = false;
            }
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    _doorInterval = doorCheckInterval;
    return doorCheckInterval;
}

export async function goToPosition(bot, x, y, z, min_distance=2) {
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
    
    const checkDigProgress = () => {
        if (bot.targetDigBlock) {
            const targetBlock = bot.targetDigBlock;
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (bot.game.gameMode !== 'creative' && !targetBlock.canHarvest(itemId)) {
                log(bot, `路径规划停止：当前工具无法破坏 ${targetBlock.name}。`);
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
        if (distance <= min_distance+1) {
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

export async function goToNearestBlock(bot, blockType,  min_distance=2, range=64) {
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
        block = world.getNearestBlock(bot, blockType, range);
    }
    if (!block) {
        log(bot, `在 ${range} 格内没有找到任何 ${blockType}。`);
        return false;
    }
        log(bot, `在 ${block.position} 找到了 ${blockType}。正在导航...`);
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
    return true;
}

export async function goToNearestEntity(bot, entityType, min_distance=2, range=64) {
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

export async function goToPlayer(bot, username, distance=3) {
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
    let player = bot.players[username].entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }

    distance = Math.max(distance, 0.5);
    const goal = new pf.goals.GoalFollow(player, distance);

    await goToGoal(bot, goal, true);

        log(bot, `已到达 ${username} 身边。`);
}


export async function followPlayer(bot, username, distance=4) {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     **/
    let player = bot.players[username].entity
    if (!player)
        return false;

    const move = new pf.Movements(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    let doorCheckInterval = startDoorInterval(bot);

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
            clearInterval(doorCheckInterval);
            doorCheckInterval = null;
            bot.modes.pause('unstuck');
            bot.modes.pause('elbow_room');
        }
        else {
            if (!doorCheckInterval) {
                doorCheckInterval = startDoorInterval(bot);
            }
            bot.modes.unpause('unstuck');
            bot.modes.unpause('elbow_room');
        }
    }
    clearInterval(doorCheckInterval);
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
        let last_move = path.path[path.path.length-1];
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

export async function moveAwayFromEntity(bot, entity, distance=16) {
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

export async function avoidEnemies(bot, distance=16) {
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
        const follow = new pf.goals.GoalFollow(enemy, distance+1); // move a little further away
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

export async function stay(bot, seconds=30) {
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
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
        log(bot, `停留了 ${(Date.now() - start)/1000} 秒。`);
    return true;
}

export async function useDoor(bot, door_pos=null) {
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
            door_pos = world.getNearestBlock(bot, door_type, 16).position;
            if (door_pos) break;
        }
    } else {
        door_pos = Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `附近没有找到门。`);
        return false;
    }

    bot.pathfinder.setGoal(new pf.goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    while (bot.pathfinder.isMoving()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    
    let door_block = bot.blockAt(door_pos);
    await bot.lookAt(door_pos);
    if (!door_block._properties.open)
        await bot.activateBlock(door_block);
    
    bot.setControlState("forward", true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    bot.setControlState("forward", false);
    await bot.activateBlock(door_block);

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

export async function tillAndSow(bot, x, y, z, seedType=null) {
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
        placeBlock(bot, seedType, x, y+1, z);
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `无法耕 ${block.name}，必须是草方块或泥土。`);
        return false;
    }
    let above = bot.blockAt(new Vec3(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `土地已经被 ${above.name} 耕种过了。`);
            return true;
        }
        let broken = await breakBlockAt(bot, x, y+1, z);
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
    id = id+"";
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

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
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
        let belowBlock = bot.blockAt(start_block_pos.offset(0, -i-1, 0));

        if (!targetBlock || !belowBlock) {
            log(bot, `向下挖了 ${i-1} 格，但到达了世界尽头。`);
            return true;
        }

        // Check for lava, water
        if (targetBlock.name === 'lava' || targetBlock.name === 'water' || 
            belowBlock.name === 'lava' || belowBlock.name === 'water') {
            log(bot, `向下挖了 ${i-1} 格，但遇到了 ${belowBlock ? belowBlock.name : '(熔岩/水)'}`)
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
            log(bot, `向下挖了 ${i-1} 格，但下方是空的。`);
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
    for (let y = 360; y > -64; y--) { // probably not the best way to find the surface but it works
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') {
            continue;
        }
        await goToPosition(bot, block.position.x, block.position.y + 1, block.position.z, 0); // this will probably work most of the time but a custom mining and towering up implementation could be added if needed
        log(bot, `正在前往 y=${y+1} 的地表。`);
        return true;
    }
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
