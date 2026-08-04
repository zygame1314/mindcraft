import * as skills from './library/skills.js';
import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import settings from './settings.js'
import convoManager from './conversation.js';

async function say(agent, message) {
    agent.bot.modes.behavior_log += message + '\n';
    if (agent.shut_up || !settings.narrate_behavior) return;
    agent.openChat(message);
}

// a mode is a function that is called every tick to respond immediately to the world
// it has the following fields:
// on: whether 'update' is called every tick
// active: whether an action has been triggered by the mode and hasn't yet finished
// paused: whether the mode is paused by another action that overrides the behavior (eg followplayer implements its own self defense)
// update: the function that is called every tick (if on is true)
// when a mode is active, it will trigger an action to be performed but won't wait for it to return output

// the order of this list matters! first modes will be prioritized
// while update functions are async, they should *not* be awaited longer than ~100ms as it will block the update loop
// to perform longer actions, use the execute function which won't block the update loop
const modes_list = [
    {
        name: 'self_preservation',
        description: 'Respond to drowning, burning, and damage at low health. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        fall_blocks: ['sand', 'gravel', 'concrete_powder'], // includes matching substrings like 'sandstone' and 'red_sand'
        update: async function (agent) {
            const bot = agent.bot;
            let block = bot.blockAt(bot.entity.position);
            let blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            if (!block) block = {name: 'air'}; // hacky fix when blocks are not loaded
            if (!blockAbove) blockAbove = {name: 'air'};
            if (blockAbove.name === 'water') {
                // does not call execute so does not interrupt other actions
                if (!bot.pathfinder.goal) {
                    bot.setControlState('jump', true);
                }
            }
            else if (this.fall_blocks.some(name => blockAbove.name.includes(name))) {
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 2);
                });
            }
            else if (block.name === 'lava' || block.name === 'fire' ||
                blockAbove.name === 'lava' || blockAbove.name === 'fire') {
                say(agent, '我着火啦！');
                // if you have a water bucket, use it
                let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                if (waterBucket) {
                    execute(this, agent, async () => {
                        let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                        if (success) say(agent, '放了点水，啊~舒服多了！');
                    });
                }
                else {
                    execute(this, agent, async () => {
                        let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                        if (waterBucket) {
                            let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                            if (success) say(agent, '放了点水，啊~舒服多了！');
                            return;
                        }
                        let nearestWater = world.getNearestBlock(bot, 'water', 20);
                        if (nearestWater) {
                            const pos = nearestWater.position;
                            let success = await skills.goToPosition(bot, pos.x, pos.y, pos.z, 0.2);
                            if (success) say(agent, '找到水了，啊~舒服多了！');
                            return;
                        }
                        await skills.moveAway(bot, 5);
                    });
                }
            }
            else if (Date.now() - bot.lastDamageTime < 3000 && (bot.health < 5 || bot.lastDamageTaken >= bot.health)) {
                say(agent, '我要死啦！');
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 20);
                });
            }
            else if (agent.isIdle()) {
                bot.clearControlStates(); // clear jump if not in danger or doing anything else
            }
        }
    },
    {
        name: 'hunger',
        description: '饥饿值过低时主动吃食物；背包没食物则提示AI寻找。',
        interrupts: ['all'],
        on: true,
        active: false,
        cooldown: 30,       // 两次"提示AI"之间的最小间隔（秒），避免刷屏
        grace: 30,          // bot 登录后多少秒内不触发（给初始化/首条消息留时间）
        last_prompt: 0,     // 0 表示尚未提示过；首次提示需先过 grace
        first_tick: 0,      // 首次 update 的时间戳，用于计算 grace
        eating: false,      // 是否正在执行主动进食（防重入）
        // 与 agent.js 中 auto-eat 的 bannedFood 保持一致
        bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken'],
        update: async function (agent) {
            const bot = agent.bot;
            // 创造/旁观模式不会饿，无需处理
            if (bot.game.gameMode === 'creative' || bot.game.gameMode === 'spectator') return;
            // 记录首次 tick 时间，用于启动宽限期
            if (this.first_tick === 0) this.first_tick = Date.now();
            // 正在主动进食中，不重复触发
            if (this.eating) return;

            // ===== 单一职责：只看饥饿值，不看血量 =====
            // 回血由 auto-eat（startAt:18，food<18 自动吃）+ MC 自动回血机制覆盖，
            // 不由本模式负责。这样中毒/溺水/着火/卡沙子等"只扣血不扣饥饿"的危险
            // 不会触发本模式去吃食物（吃不了/白费），无需为每种危险打补丁。
            // 本模式只在饥饿值危急（food<=6，快要饿死）时才介入。
            const starving = bot.food <= 6;
            if (!starving) return;

            // 背包里是否有"非禁用"的可食用物品（item.food>0 表示可食用）
            const edibleItems = bot.inventory.items().filter(
                item => item.food > 0 && !this.bannedFood.includes(item.name)
            );
            if (edibleItems.length === 0) {
                // 背包没食物：提示 AI 找食物
                const now = Date.now();
                // 启动宽限期内不触发，避免抢断初始化/首条消息
                if (now - this.first_tick < this.grace * 1000) return;
                // 冷却期内不重复提示
                if (this.last_prompt !== 0 && now - this.last_prompt < this.cooldown * 1000) return;
                this.last_prompt = now;
                say(agent, '我快饿死了，背包里没有食物！');
                // 不 await：handleMessage 会驱动一次 LLM 规划（耗时数十秒），若在这里
                // await 会阻塞 modes.update 主循环，导致 self_preservation/self_defense
                // 等救命模式在这期间无法响应（着火/溺水没人管）。改为后台触发，冷却
                // 已置位可防重复；handleMessage 的异常用 catch 兜住避免 unhandled rejection。
                agent.handleMessage('system',
                    `(自动消息)你的饥饿值已降至 ${Math.round(bot.food)}/20，而背包里没有任何可食用的食物，auto-eat 无法帮你恢复。请尽快规划获取食物：猎杀附近动物、采集作物、钓鱼或向其他玩家索要食物，拿到食物后用 !consume 食用。`)
                    .catch(e => console.warn(`hunger mode handleMessage error: ${e}`));
                return;
            }

            // 背包有食物：主动吃到不饿死（>=7）。
            // 只解决"饿死"，不追求回血（回血交给 auto-eat+MC 机制）。
            this.eating = true;
            const target = 7;
            execute(this, agent, async () => {
                say(agent, '饿死了，吃点东西！');
                // 循环吃到达标或食物耗尽。每次吃一件，避免一次只回固定点数不够。
                let safety = 0;
                while (bot.food < target && safety < 20) {
                    safety++;
                    // 重新查找：吃完一件后背包食物可能变化
                    const item = bot.inventory.items().find(
                        it => it.food > 0 && !this.bannedFood.includes(it.name)
                    );
                    if (!item) break;
                    try {
                        await skills.consume(bot, item.name);
                    } catch (e) {
                        console.warn(`hunger mode consume error: ${e}`);
                        break;
                    }
                    // 给服务端一点时间同步饥饿值
                    await new Promise(r => setTimeout(r, 400));
                }
            }).then(() => { this.eating = false; })
              .catch(() => { this.eating = false; });
        }
    },
    {
        name: 'unstuck',
        description: 'Attempt to get unstuck when in the same place for a while. Interrupts some actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        prev_location: null,
        distance: 2,
        stuck_time: 0,
        last_time: Date.now(),
        max_stuck_time: 20,
        prev_dig_block: null,
        update: async function (agent) {
            if (agent.isIdle()) { 
                this.prev_location = null;
                this.stuck_time = 0;
                return; // don't get stuck when idle
            }
            const bot = agent.bot;
            const cur_dig_block = bot.targetDigBlock;
            if (cur_dig_block && !this.prev_dig_block) {
                this.prev_dig_block = cur_dig_block;
            }
            // Standing still while actively digging a block is normal, not stuck.
            // Only accumulate stuck_time when the bot is NOT digging but still not moving.
            if (cur_dig_block) {
                this.stuck_time = 0;
                this.prev_location = bot.entity.position.clone();
                this.last_time = Date.now();
                return;
            }
            // 攀爬梯子/藤蔓时，bot 经常"原地小幅抖动上下"（在梯子上反复贴墙微调），
            // 这是 pathfinder 正常执行攀爬 move 的表现，不是卡住。
            // 只要 pathfinder goal 还在（寻路未结束/未中断），就视为正常寻路中，
            // 重置 stuck_time，避免 unstuck 误判打断攀爬、去挖附近方块。
            // 之前只检测"脚部"方块，漏掉了梯子/藤蔓的"边缘"场景：
            //   - 入口：脚踩在梯子下方的固体方块上、面前是梯子（脚不在梯子里），
            //     pathfinder 在原地微调对位准备贴墙，旧逻辑误判为卡住 → moveAway
            //     把 bot 推离梯子，而 goal 仍在又把它拉回 → 反复横跳"鬼畜"。
            //   - 出口：脚刚踏上顶部方块、脚下/身旁仍是梯子，同理。
            // 改为检测脚、头、脚下及水平四邻，任一为攀爬物即视为"正在与梯子/藤蔓交互"。
            // 真卡住（goal 已失效）时，下方 effectiveMax=8 的快速脱困仍会兜底。
            const climbableNames = ['ladder', 'vine', 'weeping_vines', 'weeping_vines_plant', 'twisting_vines', 'twisting_vines_plant', 'cave_vines', 'cave_vines_plant'];
            const _p = bot.entity.position;
            const _isClimbable = b => b && climbableNames.includes(b.name);
            const _around = [
                bot.blockAt(_p),                    // 脚
                bot.blockAt(_p.offset(0, 1, 0)),    // 头
                bot.blockAt(_p.offset(0, -1, 0)),   // 脚下（出口/往下爬）
                bot.blockAt(_p.offset(1, 0, 0)),    // 水平四邻（入口/贴墙对位）
                bot.blockAt(_p.offset(-1, 0, 0)),
                bot.blockAt(_p.offset(0, 0, 1)),
                bot.blockAt(_p.offset(0, 0, -1)),
            ];
            const inClimbable = _around.some(_isClimbable);
            // 贴梯子/藤蔓时不再无条件重置 stuck_time。
            // 旧逻辑：inClimbable && goal 存在就 return → 向下梯子时 bot 卡在边缘
            // 微调不前进，stuck_time 永远 0，永不脱困（"蹭在边缘不提示卡住"）。
            // 改为：贴攀爬物时仍累计 stuck_time，只是给更长的容忍时间（攀爬本身慢），
            // 超过 climb_max 才算真卡住。goal 存在时也照累计，因为 goal 在≠在前进。
            const climb_max = 15; // 攀爬容忍秒数：比平地 20 略短，避免边缘微调耗太久
            if (this.prev_location && this.prev_location.distanceTo(bot.entity.position) < this.distance) {
                this.stuck_time += (Date.now() - this.last_time) / 1000;
            }
            else {
                this.prev_location = bot.entity.position.clone();
                this.stuck_time = 0;
                this.prev_dig_block = null;
            }
            // 贴攀爬物且还没卡够 climb_max：记一下位置，正常寻路中，不触发脱困。
            if (inClimbable && this.stuck_time <= climb_max) {
                this.last_time = Date.now();
                return;
            }
            const max_stuck_time = cur_dig_block?.name === 'obsidian' ? this.max_stuck_time * 2 : this.max_stuck_time;
            // 脚下/身处在藤蔓类方块上时，更快判定为卡住（红树林沼泽常见）
            // 注意：上方已在 pathfinder.goal 存在时提前 return，这里只剩"goal 已失效但
            // 仍卡在藤蔓里"的情况——那才是真卡住，快速脱困。
            const vineNames = climbableNames;
            const inVine = inClimbable;
            const effectiveMax = inVine ? Math.min(max_stuck_time, 8) : max_stuck_time;
            if (this.stuck_time > effectiveMax) {
                say(agent, '我卡住啦！');
                this.stuck_time = 0;
                execute(this, agent, async () => {
                    const crashTimeout = setTimeout(() => { agent.cleanKill("卡住了且无法脱困") }, 10000);
                    // 贴梯子/藤蔓卡住分两种情况，脱困动作相反：
                    //   1. 向上爬到顶想出来（"上来又退下挂边缘"）：bot 在梯子顶，pathfinder 的
                    //      getMoveClimbTop 用 jump 到 y+2 踏顶面，但 jump 把 bot 弹离梯子碰撞
                    //      → 回落挂边缘 → 又爬上来 → 循环。实测只 forward 朝顶面方向就能走上
                    //      去，不要 jump。脱困：朝离开梯子方向 forward（踏上顶面），sneak 防跌落。
                    //   2. 向下入口边缘（"零位移反复跳"）：bot 想进梯子但贴不上。
                    //      脱困应朝梯子方向 forward+sneak 让它真正贴上去滑下来。
                    //   用 pathfinder goal 的 y 判断方向：goal 在上方→向上出梯，下方→向下进梯。
                    //   没有可读 goal 时 fallback：脚下是固体且头/旁是梯子→向上；否则向下。
                    if (inClimbable) {
                        const me = bot.entity.position.clone();
                        try {
                            let goingUp = null;
                            const goal = bot.pathfinder?.goal;
                            if (goal && typeof goal.y === 'number') {
                                goingUp = goal.y > me.y + 0.5;
                            }
                            if (goingUp === null) {
                                const feet = bot.blockAt(_p);
                                const below = bot.blockAt(_p.offset(0, -1, 0));
                                const feetSolid = feet && feet.physical && !climbableNames.includes(feet.name);
                                const belowSolid = below && below.physical && !climbableNames.includes(below.name);
                                goingUp = feetSolid || belowSolid; // 脚下能站稳 + 贴着梯子 = 在顶要出来
                            }
                            // 找水平方向目标点：向上时朝"脚下固体方块延伸方向"（顶面），
                            // 向下时朝最近梯子方块。都取最近攀爬方块作方向基准再按方向修正。
                            let target = null, bestD = Infinity;
                            for (const b of _around) {
                                if (!b || !climbableNames.includes(b.name)) continue;
                                const d = me.distanceSquared(b.position);
                                if (d < bestD) { bestD = d; target = b.position; }
                            }
                            if (target) {
                                const dir = target.minus(me);
                                // 向上出梯要手动接管控制：pathfinder 的 monitorMovement 每
                                // physicsTick 会用 goal 覆盖 yaw/control，和我们的 setControlState
                                // 抢，导致刚走上去又被它拉回梯子。stop 让它停止覆盖。
                                if (goingUp) {
                                    try { bot.pathfinder.stop(); } catch (_) { }
                                }
                                bot.setControlState('forward', true);
                                bot.setControlState('sprint', false);
                                if (goingUp) {
                                    // 向上出梯：只 forward 朝离开梯子方向走上顶面（不要 jump，
                                    // jump 会把 bot 弹离梯子挂边缘）。sneak 防踏上顶面前从梯子侧跌落。
                                    bot.setControlState('sneak', true);
                                    // 看向梯子反方向（离开梯子踏上顶面）
                                    const awayYaw = Math.atan2(-dir.x, -dir.z) + Math.PI;
                                    await bot.look(awayYaw, 0, false);
                                } else {
                                    // 向下进梯：朝梯子方向贴上去滑下来
                                    bot.setControlState('sneak', true);
                                    if (Math.abs(dir.x) > Math.abs(dir.z)) {
                                        bot.setControlState(dir.x > 0 ? 'right' : 'left', true);
                                    } else {
                                        bot.setControlState(dir.z > 0 ? 'back' : 'forward', true);
                                    }
                                }
                                await new Promise(r => setTimeout(r, 1500));
                                bot.clearControlStates();
                            }
                        } catch (_) { }
                        // 若还在原地，再走 moveAway
                        if (me.distanceSquared(bot.entity.position) < 1) {
                            await skills.moveAway(bot, 5);
                        }
                    } else {
                        await skills.moveAway(bot, 5);
                    }
                    clearTimeout(crashTimeout);
                    say(agent, '我脱困啦！');
                });
            }
            this.last_time = Date.now();
        },
        unpause: function () {
            this.prev_location = null;
            this.stuck_time = 0;
            this.prev_dig_block = null;
        }
    },
    {
        name: 'cowardice',
        description: 'Run away from enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 16);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `啊啊！有${enemy.name.replace("_", " ")}！`);
                execute(this, agent, async () => {
                    await skills.avoidEnemies(agent.bot, 24);
                });
            }
        }
    },
    {
        name: 'self_defense',
        description: 'Attack nearby enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            // 远程射手（骷髅/流浪者）会在 16 格开外射箭，近战 8 格感知太晚——bot
            // 被边射边退风筝到死也没反应。放宽射手感知到 16 格，让 defendSelf 积极
            // 接敌而不是站着挨箭。
            const rangedMobs = ['skeleton', 'stray', 'pillager', 'witch'];
            // 飞行怪（幻翼/烈焰人/恶魂/蜜蜂）：原逻辑 distanceTo>3 直接 return，等于
            // 幻翼盘旋俯冲全程不防、撞脸 3 格内才触发。放宽到 16 格，让它早点进战斗。
            // 仍兜底 >3 跳过会无限刷屏的旧逻辑只有在我们真没法回手时（既无弓又够不到）
            // 才让 defendSelf 内部去解决。
            const flyingMobs = ['phantom', 'ghast', 'blaze', 'bee'];
            const isRangedOrFlying = e => rangedMobs.includes(e.name) || flyingMobs.includes(e.name);

            const enemy = world.getNearestEntityWhere(agent.bot,
                entity => mc.isHostile(entity) && isRangedOrFlying(entity), 16) ||
                world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 8);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                const dist = agent.bot.entity.position.distanceTo(enemy.position);
                if (flyingMobs.includes(enemy.name) && dist > 3) {
                    // 不再「>3 就放任」，但要避免近战打不到空中怪 → 无限刷屏。
                    // 交给 defendSelf 在内部判断够不够得着：够得着就上，够不着就闪开避弹，
                    // 而非反复「成功自卫」空转。这里仍 return 是为了让别的 mode（如主动
                    // 走上）有机会发生，不把 bot 完全锁在「打不到的幻翼」上。
                    // 取舍：宁可让它短时间不反应，也别去打空气。但把阈值从 3 放到 6，
                    // 让贴近俯冲那一刻能及时触发。
                    // 仍走 defendSelf 的方案改成：让 defendSelf 感知到空中怪且够得着就处理。
                    say(agent, `${enemy.name}在附近，密切注意！`);
                    execute(this, agent, async () => {
                        await skills.defendSelf(agent.bot, 16);
                    });
                    return;
                }
                say(agent, `正在和${enemy.name}打架！`);
                execute(this, agent, async () => {
                    await skills.defendSelf(agent.bot, rangedMobs.includes(enemy.name) ? 16 : 8);
                });
            }
        }
    },
    {
        name: 'hunting',
        description: 'Hunt nearby animals when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        update: async function (agent) {
            const huntable = world.getNearestEntityWhere(agent.bot, entity => mc.isHuntable(entity), 8);
            if (huntable && await world.isClearPath(agent.bot, huntable)) {
                execute(this, agent, async () => {
                    say(agent, `正在猎杀${huntable.name}！`);
                    await skills.attackEntity(agent.bot, huntable);
                });
            }
        }
    },
    {
        name: 'item_collecting',
        description: 'Collect nearby items when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,

        wait: 2, // number of seconds to wait after noticing an item to pick it up
        prev_item: null,
        noticed_at: -1,
        update: async function (agent) {
            let item = world.getNearestEntityWhere(agent.bot, entity => entity.name === 'item', 8);
            let empty_inv_slots = agent.bot.inventory.emptySlotCount();
            if (item && item !== this.prev_item && await world.isClearPath(agent.bot, item) && empty_inv_slots > 1) {
                if (this.noticed_at === -1) {
                    this.noticed_at = Date.now();
                }
                if (Date.now() - this.noticed_at > this.wait * 1000) {
                    say(agent, `捡起物品！`);
                    this.prev_item = item;
                    execute(this, agent, async () => {
                        await skills.pickupNearbyItems(agent.bot);
                    });
                    this.noticed_at = -1;
                }
            }
            else {
                this.noticed_at = -1;
            }
        }
    },
    {
        name: 'torch_placing',
        description: 'Place torches when idle and there are no torches nearby.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        cooldown: 5,
        last_place: Date.now(),
        update: function (agent) {
            if (world.shouldPlaceTorch(agent.bot)) {
                if (Date.now() - this.last_place < this.cooldown * 1000) return;
                execute(this, agent, async () => {
                    const pos = agent.bot.entity.position;
                    await skills.placeBlock(agent.bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
                });
                this.last_place = Date.now();
            }
        }
    },
    {
        name: 'elbow_room',
        description: 'Move away from nearby players when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        distance: 0.5,
        update: async function (agent) {
            const player = world.getNearestEntityWhere(agent.bot, entity => entity.type === 'player', this.distance);
            if (player) {
                execute(this, agent, async () => {
                    // wait a random amount of time to avoid identical movements with other bots
                    const wait_time = Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, wait_time));
                    if (player.position.distanceTo(agent.bot.entity.position) < this.distance) {
                        await skills.moveAwayFromEntity(agent.bot, player, this.distance);
                    }
                });
            }
        }
    },
    {
        name: 'idle_staring',
        description: 'Animation to look around at entities when idle.',
        interrupts: [],
        on: true,
        active: false,

        staring: false,
        last_entity: null,
        next_change: 0,
        update: function (agent) {
            const entity = agent.bot.nearestEntity();
            let entity_in_view = entity && entity.position.distanceTo(agent.bot.entity.position) < 10 && entity.name !== 'enderman';
            if (entity_in_view && entity !== this.last_entity) {
                this.staring = true;
                this.last_entity = entity;
                this.next_change = Date.now() + Math.random() * 1000 + 4000;
            }
            if (entity_in_view && this.staring) {
                let isbaby = entity.type !== 'player' && entity.metadata[16];
                let height = isbaby ? entity.height/2 : entity.height;
                agent.bot.lookAt(entity.position.offset(0, height, 0));
            }
            if (!entity_in_view)
                this.last_entity = null;
            if (Date.now() > this.next_change) {
                // look in random direction
                this.staring = Math.random() < 0.3;
                if (!this.staring) {
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() * Math.PI/2) - Math.PI/4;
                    agent.bot.look(yaw, pitch, false);
                }
                this.next_change = Date.now() + Math.random() * 10000 + 2000;
            }
        }
    },
    {
        name: 'cheat',
        description: 'Use cheats to instantly place blocks and teleport.',
        interrupts: [],
        on: false,
        active: false,
        update: function (agent) { /* do nothing */ }
    }
];

async function execute(mode, agent, func, timeout=-1) {
    if (agent.self_prompter.isActive())
        agent.self_prompter.stopLoop();
    let interrupted_action = agent.actions.currentActionLabel;
    mode.active = true;
    let code_return = await agent.actions.runAction(`mode:${mode.name}`, async () => {
        await func();
    }, { timeout });
    mode.active = false;
    console.log(`Mode ${mode.name} finished executing, code_return: ${code_return.message}`);

    let should_reprompt = 
        interrupted_action && // it interrupted a previous action
        !agent.actions.resume_func && // there is no resume function
        !agent.self_prompter.isActive() && // self prompting is not on
        !code_return.interrupted; // this mode action was not interrupted by something else

    if (should_reprompt) {
        // auto prompt to respond to the interruption
        let role = convoManager.inConversation() ? agent.last_sender : 'system';
        let logs = agent.bot.modes.flushBehaviorLog();
        agent.handleMessage(role, `(自动消息)你刚才的动作 '${interrupted_action}' 被 ${mode.name} 打断了。
        你的行为日志: ${logs}\n请据此作出回应。`);
    }
}

let _agent = null;
const modes_map = {};
for (let mode of modes_list) {
    modes_map[mode.name] = mode;
}

class ModeController {
    /*
    SECURITY WARNING:
    ModesController must be reference isolated. Do not store references to external objects like `agent`.
    This object is accessible by LLM generated code, so any stored references are also accessible.
    This can be used to expose sensitive information by malicious prompters.
    */
    constructor() {
        this.behavior_log = '';
    }

    exists(mode_name) {
        return modes_map[mode_name] != null;
    }

    setOn(mode_name, on) {
        modes_map[mode_name].on = on;
    }

    isOn(mode_name) {
        return modes_map[mode_name].on;
    }

    isPaused(mode_name) {
        return !!modes_map[mode_name].paused;
    }

    getModeNames() {
        return modes_list.map(m => m.name);
    }

    pause(mode_name) {
        modes_map[mode_name].paused = true;
    }

    unpause(mode_name) {
        const mode = modes_map[mode_name];
        //if  unpause func is defined and mode is currently paused
        if (mode.unpause && mode.paused) {
            mode.unpause();
        }
        mode.paused = false;
    }

    unPauseAll() {
        for (let mode of modes_list) {
            if (mode.paused) console.log(`Unpausing mode ${mode.name}`);
            this.unpause(mode.name);
        }
    }

    getMiniDocs() { // no descriptions
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on})`;
        }
        return res;
    }

    getDocs() {
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on}): ${mode.description}`;
        }
        return res;
    }

    async update() {
        if (_agent.isIdle()) {
            this.unPauseAll();
        }
        for (let mode of modes_list) {
            let interruptible = mode.interrupts.some(i => i === 'all') || mode.interrupts.some(i => i === _agent.actions.currentActionLabel);
            if (mode.on && !mode.paused && !mode.active && (_agent.isIdle() || interruptible)) {
                await mode.update(_agent);
            }
            if (mode.active) break;
        }
    }

    flushBehaviorLog() {
        const log = this.behavior_log;
        this.behavior_log = '';
        return log;
    }

    getJson() {
        let res = {};
        for (let mode of modes_list) {
            res[mode.name] = mode.on;
        }
        return res;
    }

    loadJson(json) {
        for (let mode of modes_list) {
            if (json[mode.name] != undefined) {
                mode.on = json[mode.name];
            }
        }
    }
}

export function initModes(agent) {
    _agent = agent;
    // the mode controller is added to the bot object so it is accessible from anywhere the bot is used
    agent.bot.modes = new ModeController();
    if (agent.task) {
        agent.bot.restrict_to_inventory = agent.task.restrict_to_inventory;
    }
    let modes_json = agent.prompter.getInitModes();
    if (modes_json) {
        agent.bot.modes.loadJson(modes_json);
    }
}
