import { writeFile, readFile, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeCompartment, lockdown } from './library/lockdown.js';
import * as skills from './library/skills.js';
import * as world from './library/world.js';
import { Vec3 } from 'vec3';
import {ESLint} from "eslint";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class Coder {
    constructor(agent) {
        this.agent = agent;
        this.file_counter = 0;
        this.fp = '/bots/'+agent.name+'/action-code/';
        this.code_template = '';
        this.code_lint_template = '';

        readFile(path.join(__dirname, '../../bots/execTemplate.js'), 'utf8', (err, data) => {
            if (err) throw err;
            this.code_template = data;
        });
        readFile(path.join(__dirname, '../../bots/lintTemplate.js'), 'utf8', (err, data) => {
            if (err) throw err;
            this.code_lint_template = data;
        });
        mkdirSync('.' + this.fp, { recursive: true });
    }

    async generateCode(agent_history) {
        // 暂停所有 modes，防止在 LLM 代码生成请求期间 modes 触发 actions.stop()
        // 中断网络请求。但代码【执行】阶段需要恢复安全类 modes（self_defense、
        // self_preservation、cowardice、air），让 bot 执行代码时也能自卫/逃跑/捡东西。
        // item_collecting/hunting 等只中断 followPlayer 不中断 newAction，可一直开着。
        const modes = this.agent.bot.modes;
        const paused = [];
        if (modes) {
            for (const name of modes.getModeNames ? modes.getModeNames() : []) {
                if (modes.isOn(name) && !modes.isPaused(name)) {
                    modes.pause(name);
                    paused.push(name);
                }
            }
        }
        const restore = () => {
            for (const name of paused) {
                try { modes.unpause(name); } catch (_) {}
            }
        };
        // 执行阶段的生命安全监控：代码执行期间 modes 全暂停，bot 裸奔。
        // 用轻量定时器监控生命值，着火/溺水/血量低时中断代码让 AI 重新决策。
        // 不通过 mode 系统（那会触发 actions.stop 中断网络请求阶段），
        // 只在 executionModule.main 执行期间生效。
        let emergencyInterrupt = false;
        const healthWatch = setInterval(() => {
            const bot = this.agent.bot;
            if (!bot.entity) return;
            try {
                // 着火
                if (bot.entity.onFire && bot.health > 0) {
                    if (!emergencyInterrupt) console.warn('Code execution interrupted: bot is on fire!');
                    emergencyInterrupt = true;
                }
                // 溺水（氧气耗尽）
                if (typeof bot.oxygenLevel === 'number' && bot.oxygenLevel <= 0) {
                    if (!emergencyInterrupt) console.warn('Code execution interrupted: bot is drowning!');
                    emergencyInterrupt = true;
                }
                // 血量极低
                if (bot.health > 0 && bot.health <= 6) {
                    if (!emergencyInterrupt) console.warn('Code execution interrupted: bot health critical!');
                    emergencyInterrupt = true;
                }
                if (emergencyInterrupt) {
                    bot.interrupt_code = true;
                    bot.pathfinder.stop();
                }
            } catch (_) {}
        }, 500);
        lockdown();
        // this message history is transient and only maintained in this function
        let messages = agent_history.getHistory(); 
        messages.push({role: 'system', content: 'Code generation started. Write code in codeblock in your response:'});

        const MAX_ATTEMPTS = 5;
        const MAX_NO_CODE = 3;

        let code = null;
        let no_code_failures = 0;
        let timeout_count = 0;
        const MAX_TIMEOUTS = 2;
        try {
        for (let i=0; i<MAX_ATTEMPTS; i++) {
            if (this.agent.bot.interrupt_code)
                return null;
            const messages_copy = JSON.parse(JSON.stringify(messages));
            let res;
            try {
                res = await this.agent.prompter.promptCoding(messages_copy);
            } catch (e) {
                if (this.agent.bot.interrupt_code)
                    return null;
                timeout_count++;
                console.warn(`Code generation request failed: ${e.toString()}`);
                if (timeout_count >= MAX_TIMEOUTS) {
                    return `代码生成连续 ${timeout_count} 次失败（最近错误：${e.toString()}）。`;
                }
                messages.push({
                    role: 'system',
                    content: `上一次代码生成请求失败：${e.toString()}。请重新尝试。`
                });
                continue;
            }
            if (this.agent.bot.interrupt_code)
                return null;
            let contains_code = res.indexOf('```') !== -1;
            if (!contains_code) {
                if (res.indexOf('!newAction') !== -1) {
                    messages.push({
                        role: 'assistant', 
                        content: res.substring(0, res.indexOf('!newAction'))
                    });
                    continue; // using newaction will continue the loop
                }
                
                if (no_code_failures >= MAX_NO_CODE) {
                    console.warn("操作失败，代理没有编写代码。");
                    return '操作失败，代理没有编写代码。';
                }
                messages.push({
                    role: 'system', 
                    content: '错误：没有提供代码。请在回复中使用代码块编写代码。``` // 示例 ```'}
                );
                console.warn("No code block generated. Trying again.");
                no_code_failures++;
                continue;
            }
            code = res.substring(res.indexOf('```')+3, res.lastIndexOf('```'));
            const result = await this._stageCode(code);
            const executionModule = result.func;
            const lintResult = await this._lintCode(result.src_lint_copy);
            if (lintResult) {
                const message = 'Error: Code lint error:'+'\n'+lintResult+'\nPlease try again.';
                console.warn("Linting error:"+'\n'+lintResult+'\n');
                messages.push({ role: 'system', content: message });
                continue;
            }
            if (!executionModule) {
                console.warn("Failed to stage code, something is wrong.");
                return 'Failed to stage code, something is wrong.';
            }

            try {
                console.log('Executing code...');
                await executionModule.main(this.agent.bot);
                clearInterval(healthWatch);

                const code_output = this.agent.actions.getBotOutputSummary();
                const summary = "代理编写了以下代码：\n```" + this._sanitizeCode(code) + "```\n代码输出：\n" + code_output;
                return summary;
            } catch (e) {
                clearInterval(healthWatch);
                if (this.agent.bot.interrupt_code)
                    return null;
                
                console.warn('Generated code threw error: ' + e.toString());
                console.warn('trying again...');

                const code_output = this.agent.actions.getBotOutputSummary();

                messages.push({
                    role: 'assistant',
                    content: res
                });
                messages.push({
                    role: 'system',
                    content: `代码输出：\n${code_output}\n代码执行抛出错误：${e.toString()}\n 请重试：`
                });
            }
        }
        return `代码生成在 ${MAX_ATTEMPTS} 次尝试后失败。`;
        } finally {
            clearInterval(healthWatch);
            restore();
        }
    }
    
    async  _lintCode(code) {
        let result = '#### CODE ERROR INFO ###\n';
        const codeNoComments = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const skillRegex = /((?:skills|world)\.(.*?))\(/g;
        const skills = [];
        let match;
        while ((match = skillRegex.exec(codeNoComments)) !== null) {
            skills.push(match[1]);
        }
        const allDocs = await this.agent.prompter.skill_libary.getAllSkillDocs();
        const knownSkills = new Set(allDocs.map(doc => doc.split('\n')[0]));
        const missingSkills = skills.filter(skill => !knownSkills.has(skill));
        if (missingSkills.length > 0) {
            result += 'These functions do not exist:\n';
            result += missingSkills.join('\n');
            console.log(result)
            return result;
        }

        const eslint = new ESLint();
        const results = await eslint.lintText(code);
        const codeLines = code.split('\n');
        const exceptions = results.map(r => r.messages).flat();

        if (exceptions.length > 0) {
            exceptions.forEach((exc, index) => {
                if (exc.line && exc.column ) {
                    const errorLine = codeLines[exc.line - 1]?.trim() || 'Unable to retrieve error line content';
                    result += `#ERROR ${index + 1}\n`;
                    result += `Message: ${exc.message}\n`;
                    result += `Location: Line ${exc.line}, Column ${exc.column}\n`;
                    result += `Related Code Line: ${errorLine}\n`;
                }
            });
            result += 'The code contains exceptions and cannot continue execution.';
        } else {
            return null;//no error
        }

        return result ;
    }
    // write custom code to file and import it
    // write custom code to file and prepare for evaluation
    async _stageCode(code) {
        code = this._sanitizeCode(code);
        let src = '';
        code = code.replaceAll('console.log(', 'log(bot,');
        code = code.replaceAll('log("', 'log(bot,"');

        console.log(`Generated code: """${code}"""`);

        // this may cause problems in callback functions
        code = code.replaceAll(';\n', '; if(bot.interrupt_code) {log(bot, "Code interrupted.");return;}\n');
        for (let line of code.split('\n')) {
            src += `    ${line}\n`;
        }
        let src_lint_copy = this.code_lint_template.replace('/* CODE HERE */', src);
        src = this.code_template.replace('/* CODE HERE */', src);

        let filename = this.file_counter + '.js';
        // if (this.file_counter > 0) {
        //     let prev_filename = this.fp + (this.file_counter-1) + '.js';
        //     unlink(prev_filename, (err) => {
        //         console.log("deleted file " + prev_filename);
        //         if (err) console.error(err);
        //     });
        // } commented for now, useful to keep files for debugging
        this.file_counter++;
        
        let write_result = await this._writeFilePromise('.' + this.fp + filename, src);
        // This is where we determine the environment the agent's code should be exposed to.
        // It will only have access to these things, (in addition to basic javascript objects like Array, Object, etc.)
        // Note that the code may be able to modify the exposed objects.
        const compartment = makeCompartment({
            skills,
            log: skills.log,
            world,
            Vec3,
        });
        const mainFn = compartment.evaluate(src);
        
        if (write_result) {
            console.error('Error writing code execution file: ' + write_result);
            return null;
        }
        return { func:{main: mainFn}, src_lint_copy: src_lint_copy };
    }

    _sanitizeCode(code) {
        code = code.trim();
        const remove_strs = ['Javascript', 'javascript', 'js']
        for (let r of remove_strs) {
            if (code.startsWith(r)) {
                code = code.slice(r.length);
                return code;
            }
        }
        return code;
    }

    _writeFilePromise(filename, src) {
        // makes it so we can await this function
        return new Promise((resolve, reject) => {
            writeFile(filename, src, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }
}