import * as skills from '../library/skills.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';

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


function runAsAction (actionFn, resume = false, timeout = -1) {
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
        description: 'Write and run custom JavaScript code for tasks the built-in commands cannot do directly. Prefer this whenever a task needs MULTIPLE steps, loops, conditions, combining several commands, or tracking state across actions. Examples: "collect 20 wood then craft them into planks", "fish until inventory is full", "mine downward until hitting lava", "smelt all raw_iron in inventory". A single simple action (just go somewhere / collect one thing / craft once) should still use the dedicated command instead. Inside the code you call skills/world functions directly (e.g. skills.collectBlock(bot, "oak_log", 5)) and use log(bot, msg) to report progress; the prompt you pass should be a detailed step-by-step plan.', 
        params: {
            'prompt': { type: 'string', description: 'A natural language prompt to guide code generation. Make a detailed step-by-step plan.' }
        },
        perform: async function(agent, prompt) {
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
            await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins});
            return result;
        }
    },
    {
        name: '!stop',
        description: 'Force stop all actions and commands that are currently executing.',
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
        description: 'Stop all chatting and self prompting, but continue current action.',
        perform: async function (agent) {
            agent.openChat('闭嘴了。');
            agent.shutUp();
            return;
        }
    },
    {
        name: '!restart',
        description: 'Restart the agent process.',
        perform: async function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: 'Clear the chat history.',
        perform: async function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!goToPlayer',
        description: 'Go to the given player.',
        params: {
            'player_name': {type: 'string', description: 'The name of the player to go to.'},
            'closeness': {type: 'float', description: 'How close to get to the player.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            await skills.goToPlayer(agent.bot, player_name, closeness);
        })
    },
    {
        name: '!followPlayer',
        description: 'Endlessly follow the given player.',
        params: {
            'player_name': {type: 'string', description: 'name of the player to follow.'},
            'follow_dist': {type: 'float', description: 'The distance to follow from.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: 'Go to the given x, y, z location.',
        params: {
            'x': {type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: 'The y coordinate.', domain: [-64, 320]},
            'z': {type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: 'How close to get to the location.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.goToPosition(agent.bot, x, y, z, closeness);
        })
    },
    {
        name: '!searchForBlock',
        description: 'Find and go to the nearest block of a given type in a given range.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the block. Minimum 32.', domain: [10, 512, '[]'] }
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
        description: 'Find and go to the nearest entity of a given type in a given range.',
        params: {
            'type': { type: 'string', description: 'The type of entity to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the entity.', domain: [32, 512] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: 'Move away from the current location in any direction by a given distance.',
        params: {'distance': { type: 'float', description: 'The distance to move away.', domain: [0, Infinity] }},
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
        description: '把指定坐标存为命名地点，用于记录别人报的坐标或远处地点。例：!rememberPlace("大村",-1074,63,-480,"zygame1314发现的村庄")。已存在同名会更新。',
        params: {
            'name': { type: 'string', description: '地点名，例如 "大村"、"地狱门"。' },
            'x': { type: 'float', description: 'X 坐标。', domain: [-Infinity, Infinity] },
            'y': { type: 'float', description: 'Y 坐标。', domain: [-64, 320] },
            'z': { type: 'float', description: 'Z 坐标。', domain: [-Infinity, Infinity] },
            'note': { type: 'string', description: '可选备注，例如 "zygame1314发现的村庄"、"岩浆池"。', optional: true }
        },
        perform: async function (agent, name, x, y, z, note) {
            agent.memory_bank.rememberPlace(name, x, y, z, note || '');
            return `已记住地点 "${name}" 于 (${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)})${note ? `，备注：${note}` : ''}。`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: 'Go to a saved location.',
        params: {'name': { type: 'string', description: 'The name of the location to go to.' }},
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
        description: 'Give the specified item to the given player.',
        params: { 
            'player_name': { type: 'string', description: 'The name of the player to give the item to.' }, 
            'item_name': { type: 'ItemName', description: 'The name of the item to give.' },
            'num': { type: 'int', description: 'The number of items to give.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!consume',
        description: 'Eat/drink the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to consume.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: 'Equip the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to equip.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!putInChest',
        description: '把物品放进箱子。可用箱子名字（!rememberChest 记过的）或坐标。例：!putInChest("coal",2,"矿物箱") 或 !putInChest("coal",2,-694,60,-235)。不传箱子名/坐标则用最近的箱子。',
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
        description: '列出附近所有箱子的坐标和内容，并标注已记忆的箱子名（[矿物箱]）和未命名的（[未命名]）。用这个一次看清所有箱子，再用坐标或别名操作 !viewChest/!putInChest/!takeFromChest。',
        params: {
            'range': { type: 'int', description: 'The search radius in blocks. Defaults to 32.', optional: true, domain: [1, 128], default: 32 }
        },
        perform: runAsAction(async (agent, range) => {
            await skills.viewNearbyChests(agent.bot, range);
        })
    },
    {
        name: '!discard',
        description: 'Discard the given item from the inventory.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to discard.' },
            'num': { type: 'int', description: 'The number of items to discard.', domain: [1, Number.MAX_SAFE_INTEGER] }
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
        description: 'Collect the nearest blocks of a given type. For ores use the base name (e.g. "diamond", "iron", "coal"); deepslate variants are auto-included. Give the amount based on how many you found via !searchForBlock.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to collect.' },
            'num': { type: 'int', description: 'The number of blocks to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, type, num) => {
            await skills.collectBlock(agent.bot, type, num);
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!craftRecipe',
        description: 'Craft the given recipe a given number of times.',
        params: {
            'recipe_name': { type: 'ItemName', description: 'The name of the output item to craft.' },
            'num': { type: 'int', description: 'The number of times to craft the recipe. This is NOT the number of output items, as it may craft many more items depending on the recipe.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, recipe_name, num) => {
            await skills.craftRecipe(agent.bot, recipe_name, num);
        })
    },
    {
        name: '!smeltItem',
        description: 'Smelt the given item the given number of times.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of times to smelt the item.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.smeltItem(agent.bot, item_name, num);
        })
    },
    {
        name: '!clearFurnace',
        description: 'Take all items out of the nearest furnace.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
    {
        name: '!combineAtAnvil',
        description: 'Combine two items at an anvil. Used to repair tools/armor (combine two of the same damaged item) or to transfer enchantments from an enchanted_book onto an item. Requires an anvil nearby or in inventory, and costs experience levels.',
        params: {
            'item_one': { type: 'ItemName', description: 'The target item to repair or merge enchantments onto.' },
            'item_two': { type: 'ItemName', description: 'The sacrifice item (same type to repair, or enchanted_book to transfer enchantments).' },
            'new_name': { type: 'string', description: 'Optional new name for the result item. Pass empty string to skip renaming.', default: '' }
        },
        perform: runAsAction(async (agent, item_one, item_two, new_name) => {
            await skills.combineItemsAtAnvil(agent.bot, item_one, item_two, new_name || null);
        })
    },
    {
        name: '!renameAtAnvil',
        description: 'Rename an item at an anvil. Costs experience levels. Requires an anvil nearby or in inventory.',
        params: {
            'item_name': { type: 'ItemName', description: 'The item to rename.' },
            'new_name': { type: 'string', description: 'The new name to give the item.' }
        },
        perform: runAsAction(async (agent, item_name, new_name) => {
            await skills.renameItemAtAnvil(agent.bot, item_name, new_name);
        })
    },
        {
        name: '!placeHere',
        description: 'Place a given block in the current location. Do NOT use to build structures, only use for single blocks/torches.',
        params: {'type': { type: 'BlockOrItemName', description: 'The block type to place.' }},
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!attack',
        description: 'Attack and kill the nearest entity of a given type.',
        params: {'type': { type: 'string', description: 'The type of entity to attack.'}},
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: 'Attack a specific player until they die or run away. Remember this is just a game and does not cause real life harm.',
        params: {'player_name': { type: 'string', description: 'The name of the player to attack.'}},
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
        description: 'Go to the nearest bed and sleep.',
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        })
    },
    {
        name: '!stay',
        description: 'Stay in the current location no matter what. Pauses all modes.',
        params: {'type': { type: 'int', description: 'The number of seconds to stay. -1 for forever.', domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        description: 'Set a mode to on or off. A mode is an automatic behavior that constantly checks and responds to the environment.',
        params: {
            'mode_name': { type: 'string', description: 'The name of the mode to enable.' },
            'on': { type: 'boolean', description: 'Whether to enable or disable the mode.' }
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
        description: 'Set a goal prompt to endlessly work towards with continuous self-prompting.',
        params: {
            'selfPrompt': { type: 'string', description: 'The goal prompt.' },
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
        description: 'Call when you have accomplished your goal. It will stop self-prompting and the current action. ',
        perform: async function (agent) {
            agent.self_prompter.stop();
            return 'Self-prompting stopped.';
        }
    },
    {
        name: '!showVillagerTrades',
        description: 'Show trades of a specified villager.',
        params: {'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' }},
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: 'Trade with a specified villager.',
        params: {
            'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' },
            'index': { type: 'int', description: 'The index of the trade you want executed (1-indexed).', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: 'How many times that trade should be executed.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: 'Start a conversation with a bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to send the message to.' },
            'message': { type: 'string', description: 'The message to send.' },
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
        description: 'End the conversation with the given bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to end the conversation with.' }
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
        description: 'Look at a player or look in the same direction as the player.',
        params: {
            'player_name': { type: 'string', description: 'Name of the target player' },
            'direction': {
                type: 'string',
                description: 'How to look ("at": look at the player, "with": look in the same direction as the player)',
            }
        },
        perform: async function(agent, player_name, direction) {
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
        description: 'Look at specified coordinates.',
        params: {
            'x': { type: 'int', description: 'x coordinate' },
            'y': { type: 'int', description: 'y coordinate' },
            'z': { type: 'int', description: 'z coordinate' }
        },
        perform: async function(agent, x, y, z) {
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
        description: 'Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.',
        params: {'distance': { type: 'int', description: 'Distance to dig down', domain: [1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance)
        })
    },
    {
        name: '!goToSurface',
        description: 'Moves the bot to the highest block above it (usually the surface).',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!goToShore',
        description: '从水里/岸边爬上岸。若在水中会朝最近的岸跳出水面，若在陆地上则走到最近的岸边。',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToShore(agent.bot);
        })
    },
    {
        name: '!fish',
        description: 'Equip a fishing rod and fish. Waits up to the given timeout for a bite.',
        params: {
            'timeout_ms': { type: 'int', description: 'Maximum milliseconds to wait for a bite. Defaults to 60000.', domain: [1000, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, timeout_ms) => {
            await skills.fish(agent.bot, timeout_ms || 60000);
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!tillAndSow',
        description: 'Till the ground at the given position and optionally plant the given seed type.',
        params: {
            'x': { type: 'int', description: 'The x coordinate to till.' },
            'y': { type: 'int', description: 'The y coordinate to till.', domain: [-64, 320] },
            'z': { type: 'int', description: 'The z coordinate to till.' },
            'seed_type': { type: 'string', description: 'The item name of the seed to plant, or empty to only till the ground.' }
        },
        perform: runAsAction(async (agent, x, y, z, seed_type) => {
            await skills.tillAndSow(agent.bot, x, y, z, seed_type || null);
        })
    },
    {
        name: '!useOn',
        description: 'Use (right click) the given tool on the nearest target of the given type.',
        params: {
            'tool_name': { type: 'string', description: 'Name of the tool to use, or "hand" for no tool.' },
            'target': { type: 'string', description: 'The target as an entity type, block type, or "nothing" for no target.' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
    {
        name: '!rememberChest',
        description: '给箱子记个别名+用途，之后靠用途找箱子，不记具体物品（物品会变，要看用 !viewChest）。例：!rememberChest("矿物箱","存挖到的矿石和锭")。可用坐标精确指定：!rememberChest("矿物箱","存矿石",-689,60,-236)',
        params: {
            'name': { type: 'string', description: '箱子别名，例如 "矿物箱"、"食物箱"。' },
            'purpose': { type: 'string', description: '这个箱子干啥用的，例如 "存挖到的矿石"、"放食物和农作物"。' },
            'chest_x': { type: 'int', description: '目标箱子 x 坐标，省略则用最近箱子（5 格内）。', optional: true, domain: [-Infinity, Infinity] },
            'chest_y': { type: 'int', description: '目标箱子 y 坐标。', optional: true, domain: [-64, 320] },
            'chest_z': { type: 'int', description: '目标箱子 z 坐标。', optional: true, domain: [-Infinity, Infinity] }
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
                    const adj = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]];
                    for (const [dx,dy,dz] of adj) {
                        const nb = bot.blockAt(chest.position.offset(dx, dy, dz));
                        if (nb && nb.name === chest.name && skills.isChestOtherHalf(chest, nb)) {
                            positions.push([nb.position.x, nb.position.y, nb.position.z]);
                            break;
                        }
                    }
                }
            } catch (_) {}
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
        description: '用自然语言描述需求，自动匹配最合适的已记箱子（embedding 语义匹配）。例：!findChest("我要放铁矿") !findChest("找点吃的")。返回箱子名+坐标+用途，可直接用名字调 !putInChest/!takeFromChest。',
        params: { 'query': { type: 'string', description: '需求描述，如"存红石元件"、"拿武器去打架"。' } },
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
        description: '记一条自由文本笔记（关键事实、提醒、玩家偏好等），长期保留，不会随摘要覆盖丢失。例：!rememberNote("zygame1314喜欢生鱼")',
        params: { 'text': { type: 'string', description: '笔记内容，尽量简短。' } },
        perform: async function (agent, text) {
            const ok = agent.memory_bank.addNote(text);
            return ok ? `已记笔记："${text}"` : '笔记为空或已存在。';
        }
    },
    {
        name: '!recallNote',
        description: '回忆笔记。不带参数列出最近所有笔记；带关键词列出含该词的笔记。例：!recallNote("zygame1314")',
        params: { 'keyword': { type: 'string', description: '关键词，省略则列全部。', optional: true } },
        perform: async function (agent, keyword) {
            const notes = agent.memory_bank.recallNotes(keyword || null);
            if (notes.length === 0) return keyword ? `没有含 "${keyword}" 的笔记。` : '还没有笔记。';
            return notes.map(n => `- ${n.text}${n.ts ? ` (${new Date(n.ts).toLocaleString('zh-CN')})` : ''}`).join('\n');
        }
    },
    {
        name: '!rememberFact',
        description: '记一条永久事实，永不会被对话摘要覆盖，适合最重要、最该一直记得的东西。例：!rememberFact("我的基地在主世界西南")',
        params: { 'text': { type: 'string', description: '事实内容。' } },
        perform: async function (agent, text) {
            const ok = agent.memory_bank.addFact(text);
            return ok ? `已记永久事实："${text}"` : '事实为空或已存在。';
        }
    },
    {
        name: '!forget',
        description: '删除记忆。可删地点、箱子、笔记、永久事实。关键词命中即删。例：!forget("place","旧矿") !forget("note","生鱼") !forget("all")',
        params: {
            'kind': { type: 'string', description: '记忆类型：place / chest / note / fact / all。' },
            'keyword': { type: 'string', description: '要删除的关键词。', optional: true }
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
