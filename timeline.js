/*
 * Timeline
 * Author: Drizer
 * Scope-based asynchronous scripting language for timeline-based applications
 * 15/03/2020
 */

class TimelineState {
    constructor(program, instance) {
        this.debug = false;
        this.commands = {};
        this.groupCommands = {};
        this.depth = 0;
        this.callStack = ['program'];
        this.instance = instance;
        this.program = program;
        this.scope = {};
        this.prevScope = {};
        this.global = {};
        this.commands.___DATA_REF___ = this.dataRef;
        this.groupCommands.scope = this.groupCommands.group = this.nop;
        this.groupCommands.cmd = this.groupCommands.cmdg = this.badUsage;
        this.current = program.head;
        this.dataRefCachedFuncs = {};
        this.evalRawDataRegionIndex = 1;
    }
	exec(cmd, rawArgs, next) {
		(this.commands[cmd] || this.scope[cmd])(() => {
			next();
		}, rawArgs, this.instance.parseArgs(rawArgs), this);
	}
    currentScope() {
        return this.callStack[this.callStack.length - 1];
    }
    nop(next) {
        next();
    }
    dataRef(next, rawArgs, args, state) {
        let region = state.program.rawDataRegions[parseInt(args[0]) - 1];
        if (region == null) throw new Error('invalid ___DATA_REF___ region ref');
        let regionData = region.data.match(/^\s*(js|cmdg?)\s+(.*?)\s*{\s*$/m);
        if (regionData) {
            switch (regionData[1]) {
                default: throw new Error('unknown dataref command: ' + regionData[1]);
                case 'js':
                    {
                        if (state.dataRefCachedFuncs[region.id]) {
                            state.dataRefCachedFuncs[region.id](next, state.current.rawArgs, state.current.args, state);
                        } else {
                            let code = region.data.substring(regionData[0].length);
                            code = code.substring(0, code.lastIndexOf('}'));
                            let funcref = Function('next, rawArgs, args, state', code);
                            funcref(next, state.current.rawArgs, state.current.args, state);
                            state.dataRefCachedFuncs[region.id] = funcref;
                        }
                    }
                    return;
                case 'cmdg':
                    {
                        if (state.depth !== 0) throw new Error('invalid ___DATA_REF___');
                        let name = regionData[2];
                        if (state.groupCommands[name]) throw new Error('Group command redefinition not allowed! (cmdg=' + name + ')');
                        if (state.debug) {
                            console.log('Group command definition: %s', name);
                        }
                        let code = region.data.substring(regionData[0].length);
                        code = code.substring(0, code.lastIndexOf('}'));
                        state.groupCommands[name] = Function('next, rawArgs, args, state', code);
                    }
                    break;
                case 'cmd':
                    {
                        if (state.depth !== 0) throw new Error('invalid ___DATA_REF___');
                        let name = regionData[2];
                        if (state.commands[name]) throw new Error('Command redefinition not allowed! (cmd=' + name + ')');
                        if (state.debug) {
                            console.log('Command definition: %s', name);
                        }
                        let code = region.data.substring(regionData[0].length);
                        code = code.substring(0, code.lastIndexOf('}'));
                        state.commands[name] = Function('next, rawArgs, args, state', code);
                    }
                    break;
            }
        } else throw new Error('invalid ___DATA_REF___ region format');
        next();
    }
    badUsage(next, rawArgs, args, state) {
        console.warn('WARNING: bad usage of group command "' + state.current.name + '"! You should only use this in the global scope. (maybe bad indentation?)');
        next();
    }
}
class TimelineQueue {
    constructor(debugMode) {
        this.id = ++TimelineQueue.UID;
        this.items = [];
        this.callbacks = [];
        this.debugMode = debugMode;
        this.children = [];
    }
    execCallbacks(params) {
        this.callbacks.forEach(cb => cb(params));
    }
    addCallback(cb) {
        this.callbacks.push(cb);
    }
    then(cb) {
        this.items.push(cb);
        return this;
    }
    continue() {
        if (!this.halted) throw new Error('Not in a halted state.');
        this.halted = false;
        this.haltReason = null;
        this.exec(this.haltContinueExecutionAt);
    }
    halt(reason) {
        // console.log('Queue %d halted! (reason: %s)', this.id, reason ? reason : 'none provided');
        this.halted = true;
        this.haltReason = reason;
        for (let c of this.children) {
            c.halt('Halt request by parent queue (' + this.id + ')');
        }
    }
    exec(offset) {
        return new Promise(resolve => {
            let self = this;
            let queue = [];
            let prev = null;
            let _this = this;
            async function readQueue(i) {
                if (_this.halted) {
                    _this.haltContinueExecutionAt = i;
                    return resolve();
                }
                if (_this.debugMode) {
                    if (!_this.debugCallback) {
                        throw new Error('Missing debug callback.');
                    }
                    await _this.debugCallback(i);
                }
                var obj = { prev, queue, i, t: Date.now(), event: 'queue' };
                self.execCallbacks(obj);
                prev = obj;
                if (queue[i]) {
                    let __next = flag => readQueue(flag != null && typeof flag === 'number' ? flag : i + 1);
                    __next.offset = offset => {
                        readQueue(i + offset);
                    };
                    __next.queue = queue;
                    __next.current = i;
                    queue[i](__next);
                } else resolve();
            }
            for (let t of self.items) {
                if (t instanceof TimelineQueue) {
                    queue.push(next => {
                        t.exec().then(() => next());
                    });
                } else if (t instanceof Array) {
                    let q = new TimelineQueue();
                    self.children.push(q);
                    for (let o of t) q.then(o);
                    queue.push(next => {
                        q.exec().then(() => next());
                    });
                } else queue.push(t);
            }
            readQueue(offset != null ? offset : 0);
        });
    }
}
TimelineQueue.UID = 0;
class TimelineCompiler {
    constructor(source, usestdlib = true) {
        this.source = source;
        try {
            this.program = this.compile(this.source, usestdlib);
        } catch (e) {
            this.program = null;
            this.compilationError = e.message;
            console.warn(`Compilation Error: %s`, e.stack);
        }
    }
    executeOne(item, queue, state) {
        queue.then(next => {
            if (!item.staticEvaluation && item.rawArgs != null) {
                if (item._rawLine == null) {
                    // a linha deve ser expandida toda vez que for executada
                    item._rawLine = item.rawLine;
                }
                item.rawLine = state.instance.parseExpando(item._rawLine || item.rawLine, state);
                item.args = state.instance.parseArgs(item.rawLine).slice(1);
                item.rawArgs = item.rawLine.substring(item.rawArgsOffset);
            }
            if (item.name === "" && item.rawLine.startsWith('//')) {
                // comment
                next();
            } else if (!state.commands[item.name]) {
                if (state.scope[item.name]) {
                    state.scope[item.name](
                        next,
                        item.rawArgs,
                        item.args,
                        state,
                    );
                } else {
                    console.warn('WARNING: Undefined Function: ' + item.name);
                    next();
                }
            } else {
                state.commands[item.name](
                    next,
                    item.rawArgs,
                    item.args,
                    state,
                );
            }
        });
    }
    executeGroup(scope, state, passedArgs, passedRawArgs) {
        let queue = new TimelineQueue();
        if (!this.mainQueue) this.mainQueue = queue; else {
            this.mainQueue.children.push(queue);
        }
        for (let item of scope.children) {
            if (item.children) {
                queue.then(async next => {
                    if (!item.staticEvaluation && item.rawArgs != null) {
                        if (item._rawLine == null) {
                            // a linha deve ser expandida toda vez que for executada
                            item._rawLine = item.rawLine;
                        }
                        item.rawLine = state.instance.parseExpando(item._rawLine || item.rawLine, state);
                        item.rawArgs = item.rawLine.substring(item.rawLine.substring(item.rawLine.indexOf(' ')[1]).trim());
                        item.rawArgs = item.rawArgs.substring(0, item.rawArgs.length - 1);
                        item.args = state.instance.parseArgs(item.rawArgs).slice(1);
                    }
                    if (passedArgs && passedRawArgs) {
                        item.args = passedArgs;
                        item.rawArgs = passedRawArgs;
                    }
                    state.depth++;
                    state.callStack.push(item.name);
                    let lastCurrent = state.current;
                    let initialScope = Object.assign({}, state.scope);
                    let initialPrevScope = state.prevScope;
                    let beforeScopeExitCallback = null;
                    state.current = item;
                    state.prevScope = initialScope;
                    if (!state.groupCommands[item.name]) {
                        console.warn('WARNING: Group %s is not defined!', item.name);
                    } else {
                        let _self = this;
                        await ((async function () {
                            return new Promise(_next => {
                                state.groupCommands[item.name](async (_onExitScope, _userhandledExit) => {
                                    if (state.skipExecution) {
                                        state.skipExecution = false;
                                        if (state.debug) {
                                            console.log('Skipping group execution for "%s" (was handled internally)', item.name);
                                        }
                                    } else {
                                        if (state.debug) {
                                            console.log('Executing group: "%s" at scope "%d:%s"', item.name, state.depth, scope.name);
                                        }
                                        await _self.executeGroup(item, state);
                                    }
                                    if (_onExitScope) {
                                        if (!_userhandledExit) {
                                            _onExitScope();
                                            _next();
                                        } else {
                                            _onExitScope(_next, cb => beforeScopeExitCallback = cb);
                                        }
                                    } else {
                                        _next();
                                    }
                                }, item.rawArgs, item.args, state);
                            });
                        })())
                    }
                    for (let key of Object.keys(state.scope)) {
                        if (initialScope[key]) {
                            initialScope[key] = state.scope[key];
                        }
                    }
                    state.prevScope = initialPrevScope;
                    state.scope = initialScope;
                    state.current = lastCurrent;
                    state.callStack.pop();
                    state.depth--;
                    if (beforeScopeExitCallback) {
                        beforeScopeExitCallback(next);
                    } else next();
                });
            } else {
                this.executeOne(item, queue, state);
            }
        }
        return queue.exec();
    }
    stop() {
        if (this.mainQueue) {
            this.mainQueue.halt();
            this.mainQueue = null;
            return true;
        }
        return false;
    }
    execute(debug = false, global = {}) {
        if (!this.program) {
            console.warn('WARNING: Could not execute (nothing to execute!)');
            return Promise.resolve(null);
        }
        this.mainQueue = null;
        let _self = this;
        let state = new TimelineState(this.program, this);
        this.lastState = state;
        state.debug = debug;
        for (let obj in global) {
            if (global.hasOwnProperty(obj)) {
                state.global[obj] = global[obj];
            }
        }
        return new Promise(async resolve => {
            await this.executeGroup(_self.program.head, state);
            resolve(state);
        });
    }
    findExpandoEnd(raw, depth = 0) {
        var isInsideString = false, escapeNext = false;
        for (var i = 0; i < raw.length; i++) {
            var chr = raw[i];
            if (escapeNext) {
                escapeNext = false;
                build += chr;
                continue;
            }
            if (chr === '\\') {
                escapeNext = true;
                continue;
            } else if (chr === '}' && !isInsideString) {
                depth--;
                if (depth === 0) return i;
                continue;
            } else if (chr === '{' && !isInsideString) {
                depth++;
                continue;
            } else if (chr === '"') {
                if (isInsideString) {
                    isInsideString = false;
                    continue;
                } else {
                    isInsideString = true;
                }
            }
        }
        return -1;
    }
    parseArgs(raw) {
        var build = '', isInsideString = false, args = [], escapeNext = false;
        for (var i = 0; i < raw.length; i++) {
            var chr = raw[i];
            if (escapeNext) {
                escapeNext = false;
                build += chr;
                continue;
            }
            if (chr === '\\') {
                escapeNext = true;
                continue;
            }
            if (chr === '"') {
                if (isInsideString) {
                    args.push(build);
                    build = '';
                    isInsideString = false;
                    continue;
                } else {
                    if (build !== '') {
                        args.push(build);
                        build = '';
                    }
                    isInsideString = true;
                }
            } else if (chr === ' ') {
                if (isInsideString) build += chr; else if (build !== '') {
                    args.push(build);
                    build = '';
                }
            } else {
                build += chr;
            }
        }
        if (build !== '') args.push(build);
        if (isInsideString) throw new Error('unterminated "');
        return args;
    }
    parseExpando(line, state) {
        let self = this;
        for (let i = 0; i < line.length; i++) {
            let chr = line[i];
            if ((chr === '#' || chr === '$') && line[i + 1] === '{') {
                function _normalize(n) {
                    let r = '';
                    for (let i = 0; i < n.length; i++) {
                        let chr = n[i];
                        let cd = chr.charCodeAt(0);
                        r += chr.match(/^[a-zA-Z0-9_$]$/i) ? chr : '_' + cd.toString(16) + '_';
                    }
                    return r;
                }
                function _eval(code) {
                    let pargs = Object.values(state.scope).concat([state, (state.current ? state.current.args : []), (state.current ? state.current.rawArgs : null)]);
                    let funcref = new Function(Object.keys(state.scope).map(n => _normalize(n)).concat(['state', 'args', 'rawArgs']).join(', '), 'return ' + code);
                    return funcref.apply(state, pargs);
                }
                function exec(code) {
                    return JSON.stringify(_eval(code));
                }
                let isEval = chr == '$';
                let nextIndex = this.findExpandoEnd(line.substring(i));
                if (nextIndex == -1) continue;
                let contents = line.substring(i + 2, i + nextIndex);
                let result = isEval ? _eval(contents) : exec(contents);
                if (typeof result !== 'string') result = JSON.stringify(result);
                line = line.substring(0, i) + result + line.substring(i + nextIndex + 1);
                return self.parseExpando(line, state);
            }
        }
        return line;
    }
    parseCommand(line) {
        let named = line.match(/^\s*([0-9a-zA-Z_$+\-~]+)\s*/);
        let quickRef = line.indexOf('#') === -1 && line.indexOf('$') === -1;
        return {
            staticEvaluation: quickRef,
            name: named ? named[1] : '',
            rawArgsOffset: named ? named[0].length : 0,
            rawArgs: line.substring(named ? named[0].length : 0),
            rawLine: line,
            args: quickRef ? this.parseArgs(line).slice(1) : null,
        }
    }
    createExecutionScope(state, target) {
        let self = this;
        let executionScope = this.createDummyScope();
        let nscope = {
            exec: (mState, passedArgs, passedRawArgs) => self.executeGroup(executionScope, mState || state, passedArgs, passedRawArgs),
            push: (target) => {
                let gref = Object.assign({}, target);
                gref.name = 'scope';
                executionScope.children.push(gref);
                return true;
            }
        };
        if (target) nscope.push(target);
        return nscope;
    }
    createDummyScope(parent) {
        return {
            rawLine: 'scope {',
            rawArgs: '',
            args: [],
            parent: parent || null,
            name: 'scope',
            children: [],
        }
    }
    parseGroup(lines) {
        let gparts = {
            parent: null,
            name: 'program',
            children: []
        };
        let warns = [];
        let parts = gparts, index = 0;
        let depth = 0;
        let lineid = 0;
        for (let _line of lines) {
            lineid++;
            let _matchGroup = _line.match(/^\s*([0-9a-zA-Z_$+\-~]+)(\s+[^\n\r]+)?\s*\{$/);
            if (_matchGroup) {
                let quickRef = _line.indexOf('#') === -1 && _line.indexOf('$') === -1;
                depth++;
                let nparts = {
                    staticEvaluation: quickRef,
                    rawLine: _line.trimStart(),
                    rawArgs: _matchGroup[2],
                    args: quickRef ? this.parseArgs(_matchGroup[2] || '') : null,
                    parent: parts,
                    name: _matchGroup[1].trim(),
                    children: [],
                };
                parts.children.push(nparts);
                parts = nparts;
            } else {
                if (_line.trim() === '}') {
                    if (depth === 0) {
                        throw new Error('Error: Unexpected "}"');
                    }
                    depth--;
                    parts = parts.parent;
                } else {
                    if (depth > 0) {
                        if (!_line.match(new RegExp('^\\s{' + (depth) + ',}')) && _line.trim() !== '') {
                            console.warn('WARNING: Line without indentation!');
                            console.warn('WARNING: Line: "' + _line + '" (expected min spaces=' + depth + ')');
                            warns.push({
                                type: 'indentation',
                                lineNumber: lineid,
                                line: _line,
                            });
                        }
                    }
                    let content = _line.trimStart();
                    if (content !== '') {
                        parts.children.push(this.parseCommand(content));
                    }
                }
            }
            index++;
        }
        if (depth !== 0) throw new Error('Unterminated scope.');
        return {
            parts: gparts, index, depth, warns,
        }
    }
    compile(source, usestdlib = true) {
        if (usestdlib) {
            source = TimelineCompiler.STDLIB + '\n' + source;
        }
        let includes = [];
        let i = 0;
        let rawDataId = 0;
        let rawDataIndex = -1;
        let isReadingRawData = false;
        let isSpecialDataReadOff = 0;
        let isSpecialDataRead = false;
        let rawDataRegions = [];
        let replacedOffset = 0;
        let lines = source.split(/\r?\n/);
        let warns = [];
        let lineid = 0;
        let index = 0;
        let defs = [];
        let ifcondskip = false;
        let defining = null;
        let definitionBody = '';
        for (let _line of lines) {
            if (defining) {
                if (_line.trim() === '#endlibdef') {
                    lines[index] = '';
                    TimelineCompiler.LIB[defining] = definitionBody;
                    definitionBody = '';
                    defining = null;
                }
                definitionBody += lines[index] + '\n';
                lines[index] = '';
            } else if (ifcondskip) {
                if (_line.trim() === '#endif') {
                    ifcondskip = false;
                }
                lines[index] = '// (SKIPPED) ' + lines[index];
            } else {
                // formato } text...
                // broken quando dentro de rawjs
                let mlf = _line.match(/^(\s*)\}\s*(.+?\{\s*)$/);
                if (mlf) {
                    _line = mlf[1] + '}\n' + mlf[1] + mlf[2];
                    lines[index] = _line;
                }
                else if (_line.startsWith('#include ') || _line.startsWith('include ') || _line.startsWith('use ')) {
                    let srcfile = _line.substring(_line.indexOf(' ')).trim();
                    if (includes.indexOf(srcfile) !== -1) throw new Error('Multiple includes for the same file.');
                    includes.push(srcfile);
                    if (!TimelineCompiler.LIB[srcfile]) throw new Error('Lib not found: ' + srcfile);
                    let libsource = typeof TimelineCompiler.LIB[srcfile] == 'string' ? TimelineCompiler.LIB[srcfile] : TimelineCompiler.LIB[srcfile]();
                    let placeholder = '// included file (' + srcfile + ')\n' + libsource + '\n// end included file\n';
                    lines[index] = placeholder;
                } else if (_line.toLowerCase().startsWith('#define ')) {
                    defs.push(_line.substring(8).trim());
                    lines[index] = '// ' + lines[index];
                } else if (_line.toLowerCase().startsWith('#ifdef ')) {
                    let varname = _line.substring(7).trim();
                    if (defs.indexOf(varname) == -1) ifcondskip = true;
                    lines[index] = '// ' + lines[index];
                } else if (_line.trim() === '#endif') {
                    lines[index] = '// ' + lines[index];
                } else if (_line.startsWith('#libdef ')) {
                    let name = _line.substring(8);
                    if (name.endsWith('.tl')) name = name.substring(0, name.length - 3);
                    defining = name;
                    lines[index] = '// ' + lines[index];
                }
            }
            index++;
        }
        source = lines.join('\n');
        lines = source.split('\n');
        for (let _line of lines) {
            lineid++;
            if (isReadingRawData) {
                if (_line === '}' || (isSpecialDataRead && _line.match(new RegExp('^\\s{' + (isSpecialDataReadOff) + '}\\}')) != null)) {
                    if (isSpecialDataRead && _line === '}') {
                        throw new Error('Error: Bad indentation for raw js. Expecting valid indentation for "}", unindented "}" found instead.');
                    }
                    i += _line.length;
                    let data = source.substring(rawDataIndex - replacedOffset, i - replacedOffset);
                    let placeholder = `${(isSpecialDataRead ? ' '.repeat(isSpecialDataReadOff) : '')}___DATA_REF___ ${rawDataId}`;
                    isReadingRawData = false;
                    isSpecialDataRead = false;
                    isSpecialDataReadOff = 0;
                    rawDataRegions.push({
                        id: rawDataId,
                        data: data,
                    });
                    source = source.substring(0, rawDataIndex - replacedOffset) + placeholder + source.substring(i - replacedOffset);
                    replacedOffset += data.length - placeholder.length;
                    i -= _line.length;
                } else if (!_line.match(/^\s/) && _line !== '') {
                    debugger;
                    console.warn('WARNING: Raw data line without indentation!');
                    console.warn('WARNING: Line raw value: "' + _line + '"');
                    warns.push({
                        type: 'indentation',
                        lineNumber: lineid,
                        line: _line,
                    });
                }
            } else {
                if (TimelineCompiler.INTERNAL_RAW_DATA_GROUPS.findIndex(r => _line.startsWith(r + ' ') || _line.startsWith(r + '{')) !== -1) {
                    isReadingRawData = true;
                    rawDataIndex = i;
                    rawDataId++;
                } else if (_line.trimStart().match(/^js\s*{/)) {
                    isReadingRawData = true;
                    isSpecialDataRead = true;
                    isSpecialDataReadOff = _line.match(/^\s+/);
                    isSpecialDataReadOff = isSpecialDataReadOff != null ? isSpecialDataReadOff[0].length : 0;
                    rawDataIndex = i;
                    rawDataId++;
                }
            }
            i += _line.length + 1;
        }
        if (isReadingRawData) throw new Error('Syntax Error: unterminated raw data.');
        lines = source.split(/\r?\n/);
        let head = this.parseGroup(lines);
        warns.push.apply(warns, head.warns);
        return {
            includes,
            source,
            head: head.parts,
            rawDataRegions,
            warns,
        };
    }
}
TimelineCompiler.INTERNAL_RAW_DATA_GROUPS = ['cmd', 'cmdg', 'js'];
TimelineCompiler.STDLIB = `
cmd say {
    console.log(rawArgs);
    next();
}
cmd echo {
    $('body').append(\`<div>\${rawArgs}</div>\`);
    next();
}
cmd eval {
    state.instance.parseExpando('\${'+rawArgs+'}', state);
    next();
}
cmd set {
    state.prevScope[args[0].split('=')[0]] = eval(rawArgs);
    next();
}
cmd local {
    state.scope[args[0].split('=')[0]] = eval(rawArgs);
    next();
}
cmd arg {
    if(state.scope.__argIndex == null) state.scope.__argIndex = 0;
    for(let arg of args) {
        if(arg.trim() !== '') {
            state.scope[arg] = state.current.args[state.scope.__argIndex++];
        }
    }
    next();
}
cmdg if {
    state.skipExecution = true;
    if(args.length != 1) {
        throw new Error('Invalid usage!');
    }
    (async function() {
        let scope = state.instance.createExecutionScope(state, state.current);
        if(eval(args[0])) {
            await scope.exec();
        } else state.prevScope.$else = true;
        next();
    })();
}
cmdg else {
    state.skipExecution = true;
    (async function() {
        let scope = state.instance.createExecutionScope(state, state.current);
        if(state.scope.$else) {
            state.scope.$else = false;
            await scope.exec();
        }
        next();
    })();
}
cmdg event {
    state.skipExecution = true;
    if(args.length != 1) {
        throw new Error('Invalid usage!');
    }
    if(!state.global.$listen) {
        state.global.$listen = {};
    }
    if(!state.global.$listen[args[0]]) {
        state.global.$listen[args[0]] = [];
    }
    let scope = state.instance.createExecutionScope(state, state.current);
    state.global.$listen[args[0]].push((async function(pargs, prawargs) {
        args = pargs;
        rawArgs = prawargs;
        await scope.exec(null, args, rawArgs);
    }));
    next();
}
cmd trigger {
    if(args.length < 1) {
        throw new Error('Invalid usage!');
    }
    let _name = args[0];
    args.splice(0, 1);
    if(state.global.$listen && state.global.$listen[_name]) {
        for(let cb of state.global.$listen[_name]) {
            cb(args, rawArgs);
        }
    }
    next();
}
cmd wtrigger {
    if(args.length != 1) {
        throw new Error('Invalid usage!');
    }
    (async function() {
        if(state.global.$listen && state.global.$listen[args[0]]) {
            for(let cb of state.global.$listen[args[0]]) {
                await cb();
            }
        }
        next();
    })();
}
cmdg repeat {
    state.skipExecution = true;
    if(args.length != 1) {
        throw new Error('Invalid usage!');
    }
    let times = parseInt(args[0]);
    if(isNaN(times) || times < 1) throw new Error('Invalid argument.');
    let scope = state.instance.createExecutionScope(state, state.current);
    (async function() {
        for(let i=0; i<times; i++) {
            await scope.exec();
        }
        next();
    })();
}
cmdg while {
    state.skipExecution = true;
    if(args.length != 1) {
        throw new Error('Invalid usage!');
    }
    let scope = state.instance.createExecutionScope(state, state.current);
    let execWhileOnce = (async function() {
        await scope.exec();
        next((_next, setScopeExitHandler) => {
            setScopeExitHandler(__next => {
                __next.offset(0);
            });
            _next();
        }, true);
    });
    if(args[0] != 'false') {
        execWhileOnce();
    } else next();
}
cmd alias {
    if (args.length < 2) {
        throw new Error('Invalid alias usage!');
    }
    if(args[1] === '=') args.splice(1,1);
    if(!state.commands[args[1]]) {
        throw new Error('Function not found: '+args[1]);
    }
    if(!args[0].match(/^[0-9a-zA-Z_$+\\-~]+$/)) {
        throw new Error('Function name does not match valid format.');
    }
    if (state.scope[args[0]]) {
        throw new Error('Alias already defined for this scope.');
    }
    if (state.commands[args[0]]) {
        console.warn('WARNING: alias for an already defined command %s.', args[0]);
    }
    if (args[0] === args[1]) {
        throw new Error('Alias self-reference is not allowed.');
    }
    state.scope[args[0]] = state.commands[args[1]];
    next();
}
cmd softhalt {
    next(Infinity);
}
cmdg func {
    state.skipExecution = true;
    if(!args.length) {
        throw new Error('Missing function name!');
    }
    if(args.length !== 1) {
        throw new Error('Too many arguments in function signature.');
    }
    if(!args[0].match(/^[0-9a-zA-Z_$+\\-~]+$/)) {
        throw new Error('Function name does not match valid format.');
    }
    let gref = Object.assign({}, state.current);
    gref.name = 'scope';
    let executionScope = state.instance.createDummyScope();
    executionScope.children.push(gref);
    state.prevScope[args[0]] = async (next, rawArgs, args, state) => {
        gref.rawArgs = rawArgs;
        gref.args = args;
        await state.instance.executeGroup(executionScope, state);
        next();
    };
    state.prevScope[args[0]].scoperef = executionScope; // helper
    if (state.debug) console.log('Defined User Function %s', args[0]);
    next();
}
cmdg debug {
    console.log('Entering debug scope');
    state.debug = true;
    next(() => {
        console.log('Leaving debug scope');
        state.debug = false;
    });
}
cmdg js {
    // js for non-global scopes, non-ideal (fallback)
    let src = '';
    state.skipExecution = true;
    function buildSrc(c) {
        for(let child of c) {
            src += child.rawLine + '\\n';
            if(child.children) {
                buildSrc(child.children); 
                src += '\\n}';
            }
        }
    }
    buildSrc(state.current.children);
    let funcref = Function('next, rawArgs, args, state', src);
    funcref(next, rawArgs, args, state);
}
cmdg module {
    if (!args[0]) {
        throw new Error('Missing module name!');
    }
    if (args.length !== 1) {
        throw new Error('Too many arguments.');
    }
    for (let child of state.current.children) {
        if(child.name !== 'export') throw new Error('Unexpected "'+child.name+'" inside module!');
    }
    state.scope.module = {}
    next(() => {
        if(!state.global.modules) state.global.modules = {};
        state.global.modules[args[0]] = state.scope.module;
        state.scope.module = null;
    });
}
cmdg export {
    state.skipExecution = true;
    if (!state.scope.module) {
        throw new Error('Not inside a module scope!');
    }
    if(!args.length) {
        throw new Error('Missing export function name!');
    }
    if(args.length !== 1) {
        throw new Error('Too many arguments in export function signature.');
    }
    if(!args[0].match(/^[0-9a-zA-Z_$+\\-~]+$/)) {
        throw new Error('Export function name does not match valid format.');
    }
    let gref = Object.assign({}, state.current);
    gref.name = 'scope';
    let executionScope = state.instance.createDummyScope();
    executionScope.children.push(gref);
    state.scope.module[args[0]] = async (next, rawArgs, args, state) => {
        gref.rawArgs = rawArgs;
        gref.args = args;
        await state.instance.executeGroup(executionScope, state);
        next();
    };
    next();
}
cmd import {
    let m = rawArgs.match(/^\\s*([0-9a-zA-Z_$+\\-~\\s,{}]+)\\s+from\\s+([^\\s]+)(?:\\s+as\\s+([0-9a-zA-Z_$+\\-~]+))?$/);
    if (!m) throw new Error('Invalid import usage! Must be in the format: import {? funcName, ...}? from moduleName (as x)?');
    let imports = [];
    let many = m[1].match(/[,{}]/);
    if(m[3] && many) throw new Error('Invalid import format usage!');
    if(many) {
        if(m[1].trim()[0] !== '{' || !m[1].trim().endsWith('}')) {
            throw new Error('Invalid import format usage!');
        }
        m[1].replace(/[}{]/g, '').split(',').map(n => n.trim()).forEach(ni => {
            let dd = ni.split(/\\s+as\\s+/);
            let def = dd[0];
            let asn = dd[1];
            state.scope[asn ?? def] = state.global.modules[m[2]][def];
            if(!state.scope[asn ?? def]) throw new Error('Module not defined or did not export this function @ '+rawArgs+' (NOT FOUND NAME = '+ni+')');
        });
    } else {
        if (!state.global.modules[m[2]][m[1]]) throw new Error('Module not defined or did not export this function @ '+rawArgs);
        state.scope[m[3] ?? m[1]] = state.global.modules[m[2]][m[1]];
    }
    next();
}
func halt {
    js {
        throw new Error('Halted.');
    }
}

// aliases

alias print    = say
alias -        = eval

`;
TimelineCompiler.LIB = {};
TimelineCompiler.LIB.wait = `
cmd wait {
    setTimeout(function() {
        next();
    }, parseInt(rawArgs));
}
alias delay = wait
`;
TimelineCompiler.LIB.dummy = `func dummy {
    say DummyFileFunc
}`;
TimelineCompiler.LIB.notify = `cmd notify {
    top.postMessage({info: rawArgs, msg: 'notify'});
    next();
}`;

