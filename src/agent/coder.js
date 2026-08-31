import { writeFile, readFile, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeCompartment, lockdown, isLockedDown } from './library/lockdown.js';
import * as skills from './library/skills.js';
import * as world from './library/world.js';
import { Vec3 } from 'vec3';
import {ESLint} from "eslint";
import settings from './settings.js';
import { Prompter } from '../models/prompter.js';

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
        this.agent.bot.modes.pause('unstuck');
        lockdown();
        // fail closed: without hardened intrinsics the compartment is not an
        // isolation boundary at all
        if (!isLockedDown())
            return 'Code execution is disabled: the JS sandbox (SES lockdown) failed to initialize on this host.';
        // this message history is transient and only maintained in this function
        let messages = agent_history.getHistory();

        // skill library: a near-identical task solved before is re-executed
        // from the store instead of regenerated (falls through on failure)
        const task = this._getTaskContext(messages);
        if (this._skillsEnabled() && task) {
            const direct = await this._tryDirectSkill(task);
            if (direct === null && this.agent.bot.interrupt_code)
                return null;
            if (direct)
                return direct;
        }

        messages.push({role: 'system', content: 'Code generation started. Write code in codeblock in your response:'});

        const MAX_ATTEMPTS = 5;
        const MAX_NO_CODE = 3;

        let code = null;
        let no_code_failures = 0;
        for (let i=0; i<MAX_ATTEMPTS; i++) {
            if (this.agent.bot.interrupt_code)
                return null;
            const messages_copy = JSON.parse(JSON.stringify(messages));
            let res = await this.agent.prompter.promptCoding(messages_copy);
            if (this.agent.bot.interrupt_code)
                return null;
            if (res === Prompter.NO_CODE_RESPONSE) {
                // a concurrent codegen owns the model; do NOT compile/execute
                // the stub or it gets persisted as a no-op "learned skill"
                console.warn('Coder: another code generation is in progress, aborting this one.');
                return 'Another code generation is already running. Try again when it finishes.';
            }
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
                    console.warn("Action failed, agent would not write code.");
                    return 'Action failed, agent would not write code.';
                }
                messages.push({
                    role: 'system', 
                    content: 'Error: no code provided. Write code in codeblock in your response. ``` // example ```'}
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

                const code_output = this.agent.actions.getBotOutputSummary();
                const summary = "Agent wrote this code: \n```" + this._sanitizeCode(code) + "```\nCode Output:\n" + code_output;
                // never learn from an interrupted run — the injected interrupt
                // checks make truncated programs return "successfully"
                if (!this.agent.bot.interrupt_code) {
                    if (this._skillsEnabled() && task)
                        await this.agent.learned_skills.saveFromSuccess(task, this._sanitizeCode(code), code_output);
                    else
                        this.agent.memory?.record('code', `Wrote working code for the current task. Output: ${code_output.substring(0, 300)}`);
                }
                return summary;
            } catch (e) {
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
                    content: `Code Output:\n${code_output}\nCODE EXECUTION THREW ERROR: ${e.toString()}\n Please try again:`
                });
            }
        }
        return `Code generation failed after ${MAX_ATTEMPTS} attempts.`;
    }

    _skillsEnabled() {
        return settings.use_skill_library && this.agent.learned_skills?.isEnabled();
    }

    // The task text driving this code generation: the argument of the most
    // recent !newAction(...) in the conversation. Stops at the newest
    // !newAction mention even if its argument doesn't extract — falling back
    // to an OLDER task would save/execute skills under the wrong key. Only
    // double quotes: the command parser never emits single-quoted args.
    _getTaskContext(messages) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role === 'system' || !m.content) continue;
            if (!m.content.includes('!newAction')) continue;
            const match = m.content.match(/!newAction\(\s*"([\s\S]*?)"\s*\)/);
            return (match && match[1].trim().length > 0) ? match[1].trim() : null;
        }
        return null;
    }

    // Execute a stored skill for a near-identical task. Returns a summary
    // string on success, false to fall through to codegen, null on interrupt.
    async _tryDirectSkill(task) {
        try {
            const match = await this.agent.learned_skills.findBestMatch(task);
            if (!this.agent.learned_skills.shouldDirectExecute(match))
                return false;
            const skill = match.skill;
            console.log(`Coder: executing learned skill '${skill.name}' (similarity ${match.similarity.toFixed(2)}) instead of regenerating.`);
            // run through the namespace wrapper: same compile pipeline, plus
            // cycle tracking and success/failure stats in exactly one place
            await this._learnedNamespace()[skill.name](this.agent.bot);
            if (this.agent.bot.interrupt_code)
                return null;
            const code_output = this.agent.actions.getBotOutputSummary();
            this.agent.memory?.record('code', `Reused learned skill '${skill.name}' (${skill.docstring})`, { skill: skill.name });
            return `Reused learned skill '${skill.name}' (${skill.docstring}).\nCode Output:\n${code_output}`;
        } catch (err) {
            if (this.agent.bot.interrupt_code)
                return null;
            console.warn('Coder: learned skill failed, falling back to code generation:', err.message || err);
            // don't let the failed skill's partial log contaminate the
            // fallback codegen's output summary
            this.agent.bot.output = '';
            return false;
        }
    }

    // Compile stored skill code through the same sanitize/interrupt/template/
    // compartment pipeline as fresh code — identical security envelope.
    _compileLearned(code) {
        code = this._sanitizeCode(code);
        code = code.replaceAll('console.log(', 'log(bot,');
        code = code.replaceAll('log("', 'log(bot,"');
        code = code.replaceAll(';\n', '; if(bot.interrupt_code) {log(bot, "Code interrupted.");return;}\n');
        let src = '';
        for (let line of code.split('\n')) {
            src += `    ${line}\n`;
        }
        src = this.code_template.replace('/* CODE HERE */', src);
        const compartment = makeCompartment(this._endowments());
        return compartment.evaluate(src);
    }

    _endowments() {
        const endowments = {
            skills,
            log: skills.log,
            world,
            Vec3,
        };
        if (this._skillsEnabled())
            endowments.learned = this._learnedNamespace();
        return endowments;
    }

    _learnedNamespace() {
        if (!this._learned_ns)
            this._learned_ns = this.agent.learned_skills.buildNamespace((code) => this._compileLearned(code));
        return this._learned_ns;
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
        if (this._skillsEnabled()) {
            // validate learned.<name> calls against the actual skill store
            const learnedNames = this.agent.learned_skills.names();
            const learnedRegex = /learned\.(\w+)\s*\(/g;
            let lm;
            while ((lm = learnedRegex.exec(codeNoComments)) !== null) {
                if (!learnedNames.has(lm[1]))
                    missingSkills.push(`learned.${lm[1]}`);
            }
        }
        if (missingSkills.length > 0) {
            result += 'These functions do not exist:\n';
            result += missingSkills.join('\n');
            console.log(result);
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
        const compartment = makeCompartment(this._endowments());
        const mainFn = compartment.evaluate(src);
        
        if (write_result) {
            console.error('Error writing code execution file: ' + write_result);
            return null;
        }
        return { func:{main: mainFn}, src_lint_copy: src_lint_copy };
    }

    _sanitizeCode(code) {
        code = code.trim();
        const remove_strs = ['Javascript', 'javascript', 'js'];
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