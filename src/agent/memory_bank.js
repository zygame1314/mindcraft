// 分层结构化记忆库。
//
// 设计目标：让 AI 拥有"金鱼脑"之外更持久的记忆。把记忆拆成几类，
// 各自独立保存，互不覆盖，避免单条摘要被新信息挤掉旧信息：
//   places   : 命名地点（坐标 + 可选备注 + 可选别名）。
//   chests   : 命名箱子（坐标 + 用途/标签，不记具体物品，因为会变；想看内容用 !viewChest）。
//   notes    : 自由文本笔记（关键事实、长期提醒、玩家偏好等），按时间倒序，可单条删除。
//   facts    : 永久事实，永不衰减，LLM 摘要不会动它。
//
// 所有写入操作都返回简短描述，方便命令回显和后续 LLM 理解。
// getSummary() 输出一份精简结构化摘要，供每轮对话 prompt 注入。

const MAX_NOTES = 40;      // notes 上限，超出按时间淘汰最旧的
const MAX_NOTE_LEN = 240;  // 单条 note 最大长度

function clamp(s, n) {
    if (typeof s !== 'string') return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
}

function fmtTime(ts) {
    if (!ts) return '';
    try {
        const d = new Date(ts);
        return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch (_) { return ''; }
}

function coordStr(c) {
    if (!Array.isArray(c)) return '';
    return `(${c[0]}, ${c[1]}, ${c[2]})`;
}

export class MemoryBank {
    constructor() {
        // 向后兼容：旧版 memory_bank 只是一个 { name: [x,y,z] } 的扁平 map。
        // 旧存档加载时通过 loadJson 自动迁移。
        this.places = {};   // name -> { pos: [x,y,z], note: '', aliases: [], ts }
        this.chests = {};   // name -> { pos: [x,y,z]?, place: '家'?, items: {name:count}, ts }
        this.notes = [];    // [{ id, text, ts }]
        this.facts = [];    // [string]
        this._legacy_places = {}; // 兼容旧字段
    }

    // ---------- 地点 ----------
    rememberPlace(name, x, y, z, note = '') {
        if (!name) return false;
        const pos = [round(x), round(y), round(z)];
        this.places[name] = {
            pos,
            note: clamp(note, 200),
            aliases: this.places[name]?.aliases || [],
            ts: Date.now(),
        };
        return true;
    }

    addPlaceAlias(name, alias) {
        if (!this.places[name]) return false;
        if (!this.places[name].aliases.includes(alias)) {
            this.places[name].aliases.push(alias);
        }
        return true;
    }

    recallPlace(name) {
        const p = this.places[name];
        if (!p) return null;
        return p.pos;
    }

    resolvePlaceName(name) {
        // 支持别名解析：传入别名也能命中真实地点
        if (this.places[name]) return name;
        for (const k in this.places) {
            if (this.places[k].aliases.includes(name)) return k;
        }
        return null;
    }

    // ---------- 容器 ----------
    // 记一个箱子的别名+用途/标签，不记具体物品（物品会变，记了就过期）。
    // pos 可选；purpose 必填（用途/标签，如"存矿物""食物""杂物"）。
    // 若已有同名箱子则更新用途，坐标留旧值。
    rememberChest(name, purpose, pos = null) {
        if (!name) return false;
        const old = this.chests[name];
        this.chests[name] = {
            pos: pos ? pos.map(round) : (old?.pos || null),
            purpose: clamp(purpose, 200),
            ts: Date.now(),
        };
        return true;
    }

    recallChest(name) {
        return this.chests[name] || null;
    }

    // 按坐标找已记录的箱子（坐标四舍五入匹配），返回 name
    findChestByPos(x, y, z) {
        const tx = round(x), ty = round(y), tz = round(z);
        for (const name in this.chests) {
            const p = this.chests[name].pos;
            if (p && p[0] === tx && p[1] === ty && p[2] === tz) return name;
        }
        return null;
    }

    forgetChest(name) {
        if (this.chests[name]) { delete this.chests[name]; return true; }
        return false;
    }

    // ---------- 笔记 ----------
    addNote(text) {
        text = clamp(text, MAX_NOTE_LEN);
        if (!text) return false;
        // 去重：完全相同就不重复加
        if (this.notes.some(n => n.text === text)) return false;
        this.notes.push({ id: Date.now() + Math.random(), text, ts: Date.now() });
        // 超出上限淘汰最旧
        while (this.notes.length > MAX_NOTES) this.notes.shift();
        return true;
    }

    recallNotes(keyword = null) {
        if (!keyword) return this.notes.slice();
        const kw = keyword.toLowerCase();
        return this.notes.filter(n => n.text.toLowerCase().includes(kw));
    }

    forgetNote(keyword) {
        if (!keyword) {
            const n = this.notes.length;
            this.notes = [];
            return n;
        }
        const kw = keyword.toLowerCase();
        const before = this.notes.length;
        this.notes = this.notes.filter(n => !n.text.toLowerCase().includes(kw));
        return before - this.notes.length;
    }

    // ---------- 永久事实 ----------
    addFact(text) {
        text = clamp(text, MAX_NOTE_LEN);
        if (!text) return false;
        if (this.facts.includes(text)) return false;
        this.facts.push(text);
        return true;
    }

    forgetFact(keyword) {
        if (!keyword) {
            const n = this.facts.length;
            this.facts = [];
            return n;
        }
        const kw = keyword.toLowerCase();
        const before = this.facts.length;
        this.facts = this.facts.filter(f => !f.toLowerCase().includes(kw));
        return before - this.facts.length;
    }

    getFacts() { return this.facts.slice(); }

    // ---------- 综合查询 ----------
    getPlaceKeys() {
        return Object.keys(this.places).join(', ');
    }

    getChestKeys() {
        return Object.keys(this.chests).join(', ');
    }

    // 旧版兼容：getKeys 仍返回地点名
    getKeys() { return this.getPlaceKeys(); }

    // ---------- 摘要（注入 prompt 用） ----------
    getSummary() {
        const lines = [];

        if (Object.keys(this.places).length) {
            lines.push('【已记地点】');
            for (const name in this.places) {
                const p = this.places[name];
                let line = `- ${name} ${coordStr(p.pos)}`;
                if (p.note) line += ` 备注:${p.note}`;
                if (p.aliases?.length) line += ` 别名:${p.aliases.join('/')}`;
                lines.push(line);
            }
        }

        if (Object.keys(this.chests).length) {
            lines.push('【已记箱子】(只记用途，想看内容用 !viewChest)');
            for (const name in this.chests) {
                const c = this.chests[name];
                let line = `- ${name}`;
                if (c.pos) line += ` ${coordStr(c.pos)}`;
                if (c.purpose) line += ` 用途:${c.purpose}`;
                lines.push(line);
            }
        }

        if (this.facts.length) {
            lines.push('【永久事实】');
            for (const f of this.facts) lines.push(`- ${f}`);
        }

        if (this.notes.length) {
            lines.push('【笔记】');
            // 最近 12 条，倒序
            for (const n of this.notes.slice(-12).reverse()) {
                lines.push(`- ${n.text}${n.ts ? ` (${fmtTime(n.ts)})` : ''}`);
            }
            if (this.notes.length > 12) lines.push(`（共 ${this.notes.length} 条，仅显示最近 12 条，用 !recallNote 查全部）`);
        }

        return lines.length ? lines.join('\n') : '（暂无结构化记忆，用 !rememberHere/!rememberChest/!rememberNote 记录）';
    }

    // ---------- 持久化 ----------
    getJson() {
        return {
            version: 2,
            places: this.places,
            chests: this.chests,
            notes: this.notes,
            facts: this.facts,
        };
    }

    loadJson(json) {
        if (!json) return;
        // 版本迁移：旧版是 { name: [x,y,z] } 的扁平 map
        if (json.version === 2) {
            this.places = json.places || {};
            this.chests = json.chests || {};
            this.notes = Array.isArray(json.notes) ? json.notes : [];
            this.facts = Array.isArray(json.facts) ? json.facts : [];
            return;
        }
        // 旧扁平格式
        this.places = {};
        this.chests = {};
        this.notes = [];
        this.facts = [];
        for (const name in json) {
            const v = json[name];
            if (Array.isArray(v) && v.length >= 3) {
                this.places[name] = { pos: v.slice(0, 3), note: '', aliases: [], ts: 0 };
            }
        }
    }
}

function round(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}