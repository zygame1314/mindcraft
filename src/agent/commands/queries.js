import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { getCommandDocs } from './index.js';
import convoManager from '../conversation.js';
import { checkLevelBlueprint, checkBlueprint } from '../tasks/construction_tasks.js';
import { load } from 'cheerio';

const pad = (str) => {
    return '\n' + str + '\n';
}

// queries are commands that just return strings and don't affect anything in the world
export const queryList = [
    {
        name: "!stats",
        description: "Get your bot's location, health, hunger, and time of day.", 
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'STATS';
            let pos = bot.entity.position;
            // display position to 2 decimal places
            res += `\n- Position: x: ${pos.x.toFixed(2)}, y: ${pos.y.toFixed(2)}, z: ${pos.z.toFixed(2)}`;
            // Gameplay
            res += `\n- Gamemode: ${bot.game.gameMode}`;
            res += `\n- Health: ${Math.round(bot.health)} / 20`;
            res += `\n- Hunger: ${Math.round(bot.food)} / 20`;
            res += `\n- Biome: ${world.getBiomeName(bot)}`;
            let weather = "Clear";
            if (bot.rainState > 0)
                weather = "Rain";
            if (bot.thunderState > 0)
                weather = "Thunderstorm";
            res += `\n- Weather: ${weather}`;
            // let block = bot.blockAt(pos);
            // res += `\n- Artficial light: ${block.skyLight}`;
            // res += `\n- Sky light: ${block.light}`;
            // light properties are bugged, they are not accurate


            if (bot.time.timeOfDay < 6000) {
                res += '\n- Time: Morning';
            } else if (bot.time.timeOfDay < 12000) {
                res += '\n- Time: Afternoon';
            } else {
                res += '\n- Time: Night';
            }

            // get the bot's current action
            let action = agent.actions.currentActionLabel;
            if (agent.isIdle())
                action = 'Idle';
            res += `\- Current Action: ${action}`;


            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            res += '\n- Nearby Human Players: ' + (players.length > 0 ? players.join(', ') : 'None.');
            res += '\n- Nearby Bot Players: ' + (bots.length > 0 ? bots.join(', ') : 'None.');

            res += '\n' + agent.bot.modes.getMiniDocs() + '\n';
            return pad(res);
        }
    },
    {
        name: "!inventory",
        description: "Get your bot's inventory.",
        perform: function (agent) {
            let bot = agent.bot;
            let inventory = world.getInventoryCounts(bot);
            let res = 'INVENTORY';
            // 可磨损物品（工具/防具）按单独的物品堆显示耐久，而非合并计数。
            // 否则 AI 看到的是 "diamond_pickaxe: 1" 却不知道它快爆了。
            // 同名但耐久不同的多把工具会各自列一行，让 AI 能挑耐久高的用。
            const durabilityLabel = (item) => {
                if (!item || !item.maxDurability) return null;
                const used = item.durabilityUsed ?? 0;
                const left = item.maxDurability - used;
                return `${left}/${item.maxDurability}`;
            };
            const damageableByName = {};
            for (const slot of bot.inventory.slots) {
                if (slot && slot.name && slot.maxDurability) {
                    (damageableByName[slot.name] ??= []).push(slot);
                }
            }
            for (const item in inventory) {
                if (inventory[item] && inventory[item] > 0) {
                    const stacks = damageableByName[item];
                    if (stacks && stacks.length > 0) {
                        for (const s of stacks) {
                            const d = durabilityLabel(s);
                            res += `\n- ${item}: 1${d ? ` (耐久 ${d})` : ''}`;
                        }
                    } else {
                        res += `\n- ${item}: ${inventory[item]}`;
                    }
                }
            }
            if (res === 'INVENTORY') {
                res += ': Nothing';
            }
            else if (agent.bot.game.gameMode === 'creative') {
                res += '\n(You have infinite items in creative mode. You do not need to gather resources!!)';
            }

            let helmet = bot.inventory.slots[5];
            let chestplate = bot.inventory.slots[6];
            let leggings = bot.inventory.slots[7];
            let boots = bot.inventory.slots[8];
            res += '\nWEARING: ';
            const wear = (label, it) => it ? `\n${label}: ${it.name}${durabilityLabel(it) ? ` (耐久 ${durabilityLabel(it)})` : ''}` : '';
            res += wear('Head', helmet) + wear('Torso', chestplate) + wear('Legs', leggings) + wear('Feet', boots);
            if (!helmet && !chestplate && !leggings && !boots)
                res += 'Nothing';

            // 手持物品单独提示耐久，方便 AI 判断当前工具是否该换
            if (bot.heldItem) {
                const d = durabilityLabel(bot.heldItem);
                res += `\nHolding: ${bot.heldItem.name}${d ? ` (耐久 ${d})` : ''}`;
            }

            return pad(res);
        }
    },
    {
        name: "!nearbyBlocks",
        description: "Get the blocks near the bot.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_BLOCKS';
            let blocks = world.getNearestBlocks(bot);
            let block_details = new Set();
            
            for (let block of blocks) {
                let details = block.name;
                if (block.name === 'water' || block.name === 'lava') {
                    details += block.metadata === 0 ? ' (source)' : ' (flowing)';
                }
                block_details.add(details);
            }
            for (let details of block_details) {
                res += `\n- ${details}`;
            }
            if (block_details.size === 0) {
                res += ': none';
            } 
            else {
                res += '\n- ' + world.getSurroundingBlocks(bot).join('\n- ');
                res += `\n- First Solid Block Above Head: ${world.getFirstBlockAboveHead(bot, null, 32)}`;
            }
            return pad(res);
        }
    },
    {
        name: "!craftable",
        description: "Get the craftable items with the bot's inventory.",
        perform: function (agent) {
            let craftable = world.getCraftableItems(agent.bot);
            let res = 'CRAFTABLE_ITEMS';
            for (const item of craftable) {
                res += `\n- ${item}`;
            }
            if (res == 'CRAFTABLE_ITEMS') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!entities",
        description: "Get the nearby players and entities.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_ENTITIES';
            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            for (const player of players) {
                res += `\n- Human player: ${player}`;
            }
            for (const bot of bots) {
                res += `\n- Bot player: ${bot}`;
            }

            let nearbyEntities = world.getNearbyEntities(bot);
            let entityCounts = {};
            let villagerIds = [];
            let babyVillagerIds = [];
            let villagerDetails = []; // Store detailed villager info including profession
            
            for (const entity of nearbyEntities) {
                if (entity.type === 'player' || entity.name === 'item')
                    continue;
                    
                if (!entityCounts[entity.name]) {
                    entityCounts[entity.name] = 0;
                }
                entityCounts[entity.name]++;
                
                if (entity.name === 'villager') {
                    if (entity.metadata && entity.metadata[16] === 1) {
                        babyVillagerIds.push(entity.id);
                    } else {
                        const profession = world.getVillagerProfession(entity);
                        villagerIds.push(entity.id);
                        villagerDetails.push({
                            id: entity.id,
                            profession: profession
                        });
                    }
                }
            }
            
            for (const [entityType, count] of Object.entries(entityCounts)) {
                if (entityType === 'villager') {
                    let villagerInfo = `${count} ${entityType}(s)`;
                    if (villagerDetails.length > 0) {
                        const detailStrings = villagerDetails.map(v => `(${v.id}:${v.profession})`);
                        villagerInfo += ` - Adults: ${detailStrings.join(', ')}`;
                    }
                    if (babyVillagerIds.length > 0) {
                        villagerInfo += ` - Baby IDs: ${babyVillagerIds.join(', ')} (babies cannot trade)`;
                    }
                    res += `\n- entities: ${villagerInfo}`;
                } else {
                    res += `\n- entities: ${count} ${entityType}(s)`;
                }
            }
            
            if (res == 'NEARBY_ENTITIES') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!modes",
        description: "Get all available modes and their docs and see which are on/off.",
        perform: function (agent) {
            return agent.bot.modes.getDocs();
        }
    },
    {
        name: '!savedPlaces',
        description: '列出所有已记地点、箱子、笔记、永久事实的结构化记忆摘要。每轮对话已自动注入，这里可主动再查。',
        perform: async function (agent) {
            return agent.memory_bank.getSummary();
        }
    },
    {
        name: '!checkBlueprintLevel',
        description: 'Check if the level is complete and what blocks still need to be placed for the blueprint',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = checkLevelBlueprint(agent, levelNum);
            console.log(res);
            return pad(res);
        }
    }, 
    {
        name: '!checkBlueprint',
        description: 'Check what blocks still need to be placed for the blueprint',
        perform: function (agent) {
            let res = checkBlueprint(agent);
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprint',
        description: 'Get the blueprint for the building',
        perform: function (agent) {
            let res = agent.task.blueprint.explain();
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprintLevel',
        description: 'Get the blueprint for the building',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = agent.task.blueprint.explainLevel(levelNum);
            console.log(res);
            return pad(res);
        }
    },
    {
        name: '!getCraftingPlan',
        description: "Provides a comprehensive crafting plan for a specified item. This includes a breakdown of required ingredients, the exact quantities needed, and an analysis of missing ingredients or extra items needed based on the bot's current inventory.",
        params: {
            targetItem: { 
                type: 'string', 
                description: 'The item that we are trying to craft' 
            },
            quantity: { 
                type: 'int',
                description: 'The quantity of the item that we are trying to craft',
                optional: true,
                domain: [1, Infinity, '[)'], // Quantity must be at least 1,
                default: 1
            }
        },
        perform: function (agent, targetItem, quantity = 1) {
            let bot = agent.bot;

            // Fetch the bot's inventory
            const curr_inventory = world.getInventoryCounts(bot); 
            const target_item = targetItem;
            let existingCount = curr_inventory[target_item] || 0;
            let prefixMessage = '';
            if (existingCount > 0) {
                curr_inventory[target_item] -= existingCount;
                prefixMessage = `You already have ${existingCount} ${target_item} in your inventory. If you need to craft more,\n`;
            }

            // Generate crafting plan
            try {
                let craftingPlan = mc.getDetailedCraftingPlan(target_item, quantity, curr_inventory);
                craftingPlan = prefixMessage + craftingPlan;
                return pad(craftingPlan);
            } catch (error) {
                console.error("Error generating crafting plan:", error);
                return `An error occurred while generating the crafting plan: ${error.message}`;
            }
            
            
        },
    },
    {
        name: '!searchWiki',
        description: 'Search the Minecraft Wiki for the given query. Use English page names (e.g. "iron_ingot" or "iron ingot") for best results.',
        params: {
            'query': { type: 'string', description: 'The query to search for, preferably an English wiki page name.' }
        },
        perform: async function (agent, query) {
            // minecraft.wiki 直接把 query 拼进 URL（https://minecraft.wiki/w/<query>），
            // 但未做 URL 编码：含空格/中文/特殊字符的 query 会得到 404（或被服务器
            // 误解析），表现为"啥都搜不到"。此外即使命中页面，原版只做 navbox 移除，
            // 返回的是带大量空行、JSON-LD、目录导航的 HTML 转文本噪音，AI 很难读。
            //
            // 修复策略：
            //   1. URL 编码 query，并把空格/中文转成 wiki 接受的形式；
            //   2. 精确页 404 时退到 Special:Search 搜索页，解析前若干结果标题，
            //      再逐个抓取并挑选首段正文最长的那个；
            //   3. 文本清洗：去掉脚本/样式/JSON-LD/导航框/目录/注释/连续空行，
            //      只保留真正可读的条目正文；
            //   4. 加超时与截断，避免 hang 或返回超长内容塞爆 LLM 上下文。
            const WIKI = 'https://minecraft.wiki';
            const TIMEOUT_MS = 15000;
            const MAX_CHARS = 4000;
            const raw = String(query ?? '').trim();
            if (!raw) return 'Please provide a query to search the Minecraft Wiki.';

            // wiki 页面名用下划线分隔单词效果最好（如 "iron_ingot"），
            // 但 URL 编码也能处理普通空格，所以两种都支持。
            const pageName = raw.replace(/\s+/g, '_');
            const directUrl = `${WIKI}/w/${encodeURIComponent(pageName)}`;

            async function fetchWithTimeout(url) {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
                try {
                    return await fetch(url, {
                        signal: ctrl.signal,
                        headers: { 'Accept-Language': 'en-US,en;q=0.9' },
                        redirect: 'follow',
                    });
                } finally { clearTimeout(t); }
            }

            // 清洗 HTML 转出的文本：去掉脚本/样式/JSON-LD/导航/目录/注释，
            // 压缩连续空白，截断到 MAX_CHARS。返回 null 表示这不是有效条目页。
            function cleanWikiText($) {
                const out = $("div.mw-parser-output");
                if (out.length === 0) return null;
                // 移除噪音节点：导航框、信息框、目录、脚本、样式、编辑链接、引用标记等。
                // 信息框（table.infobox / .infobox）序列化后会变成一大段
                // {"title":...,"rows":[...]} 的 JSON 噪音塞满文本，且与正文重复，
                // 故直接删节点；条目真正的属性/合成信息在正文段落里也有。
                out.find(
                    'script,style,noscript,table.navbox,table.infobox,.infobox,' +
                    'div.toc,ul.toc,.mw-editsection,.reference,' +
                    '.noprint,.mw-empty-elt,style[data-mw-deduplicate]'
                ).remove();
                let text = out.text();
                if (!text) return null;
                // 去掉 <script>/<style> 内联残留与 HTML 注释
                text = text.replace(/<[^>]+>/g, ' ');
                text = text.replace(/<!--[\s\S]*?-->/g, ' ');
                // 兜底：万一还有漏网的 info-box JSON 数据块，用正则去掉
                text = text.replace(/\{\s*"title"\s*:[\s\S]*?\n\s*\}\s*\n/g, ' ');
                // 压缩空白：连续空白/空行合并成单个换行或空格
                text = text.replace(/[ \t]+/g, ' ')
                    .replace(/\n[ \t]+/g, '\n')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
                // 过短的通常是错误页/重定向残留
                if (text.length < 50) return null;
                return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '\n...(truncated)' : text;
            }

            async function getPageText(url) {
                const resp = await fetchWithTimeout(url);
                if (resp.status === 404) return null;
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const html = await resp.text();
                const $ = load(html);
                return cleanWikiText($);
            }

            async function searchFallback(queryTerm) {
                // Special:Search 搜索页：解析结果链接标题，逐个抓取正文。
                const searchUrl = `${WIKI}/w/Special:Search?search=${encodeURIComponent(queryTerm)}&fulltext=1`;
                const resp = await fetchWithTimeout(searchUrl);
                if (!resp.ok) return null;
                const html = await resp.text();
                const $ = load(html);
                const titles = [];
                // 搜索结果链接用 /w/ 前缀（非 /wiki/），标题在 .mw-search-result-heading 的首个 a。
                // 过滤掉分页/排序/命名空间等非条目链接（href 含 Special: 或带 offset/limit）。
                $('.mw-search-result-heading a').slice(0, 8).each((_, el) => {
                    const t = $(el).attr('title');
                    const href = $(el).attr('href') || '';
                    if (!t) return;
                    if (href.includes('Special:')) return;
                    if (/offset=|limit=|profile=/.test(href)) return;
                    if (!titles.includes(t)) titles.push(t);
                });
                if (titles.length === 0) return null;
                for (const title of titles) {
                    try {
                        const text = await getPageText(`${WIKI}/w/${encodeURIComponent(title.replace(/\s+/g, '_'))}`);
                        if (text) return { title, text };
                    } catch (_) { /* try next */ }
                }
                return null;
            }

            try {
                // 1) 先试精确页
                const direct = await getPageText(directUrl);
                if (direct) {
                    return pad(`[Minecraft Wiki: ${pageName.replace(/_/g, ' ')}]\n\n${direct}`);
                }
                // 2) 精确页 404/无效 → 走搜索
                const hit = await searchFallback(raw);
                if (hit) {
                    return pad(`[Minecraft Wiki: ${hit.title}] (matched by search for "${raw}")\n\n${hit.text}`);
                }
                return `"${raw}" was not found on the Minecraft Wiki. Try an English page name (e.g. "iron_ingot").`;
            } catch (error) {
                console.error("Error fetching or parsing Minecraft Wiki:", error);
                return `Error searching the Minecraft Wiki: ${error.message || error}`;
            }
        }
    },
    {
        name: '!help',
        description: 'Lists all available commands and their descriptions.',
        perform: async function (agent) {
            return getCommandDocs(agent);
        }
    },
];
