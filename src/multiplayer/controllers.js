const fs = require("fs");
const Logger = require("../log");
const PixelConverter = require("./converter");
const path = require("path");
const { Console } = require("console");

/**
 * ControllerManager handles compiling and serving controller scripts from a directory
 */
class ControllerManager {
    #ready;
    #pixelConverter;
    #compiler;
    #logger;
    #scripts = new Map();

    /**
     * Create a new ControllerManager and load and compile PixSimAssembly code in the `filePath` directory.
     * @param {Express} app An Express app.
     * @param {string} httpPath Path to route controller serving to.
     * @param {string} filePath Directory to load controllers from.
     * @param {PixelConverter} converter `PixelConverter` instance for converting pixel IDs.
     * @param {Logger} logger `Logger` instance for logging.
     * @param {boolean} logEverything To log or not to log everything.
     */
    constructor(app, httpPath, filePath, converter, logger, logEverything) {
        if (typeof app != 'function' || app == null || !app.hasOwnProperty('mkcalendar') || typeof app.mkcalendar != 'function') throw new TypeError('"app" must be an Express app');
        if (httpPath.endsWith('/') && httpPath.length > 1) httpPath = httpPath.substring(0, httpPath.length - 1);
        if (!fs.existsSync(filePath)) throw new Error('"filePath" must be a valid directory');
        filePath = path.resolve(filePath);
        if (!(converter instanceof PixelConverter)) throw new TypeError('"converter" must be an instance of PixelConverter');
        this.#pixelConverter = converter;
        if (logger instanceof Logger) this.#logger = logger;
        this.#compiler = new PixSimAssemblyCompiler(this.#pixelConverter);
        app.get(httpPath + '/*', (req, res) => {
            let scriptName = req.path.replace(httpPath + '/', '');
            let format = req.query.format;
            if (format == undefined || scriptName.length == 0) {
                res.sendStatus(400);
                if (logEverything) this.#debug(`Request for ${scriptName} fail - 400`);
                return;
            }
            let script = this.getScript(scriptName, format);
            if (script.length > 0) {
                res.setHeader('Content-Type', 'text/plain'); // text/javascript would trigger browser parsing?
                res.send(script);
                if (logEverything) this.#debug(`Request for ${scriptName} success`);
                return;
            }
            if (logEverything) this.#debug(`Request for ${scriptName} fail - 404`);
            res.sendStatus(404);
        });
        this.#ready = new Promise(async (resolve, reject) => {
            await this.#pixelConverter.ready;
            if (logEverything) this.#info('Detecting controller scripts in ' + filePath);
            const dirList = fs.readdirSync(filePath);
            const scriptList = [];
            for (let dir of dirList) {
                if (fs.lstatSync(path.resolve(filePath, dir)).isDirectory()) {
                    scriptList.push(...fs.readdirSync(path.resolve(filePath, dir)).filter((script) => {
                        return fs.lstatSync(path.resolve(filePath, dir, script)).isFile() && script.endsWith('.pxasm');
                    }).map((script) => {
                        return path.join(dir, script);
                    }));
                }
            }
            this.#info(`Found ${scriptList.length} controller scripts in ${filePath}`);
            if (logEverything) this.#debug(`Scripts found:${scriptList.reduce((acc, curr) => acc + `\n    ${curr}`, '')}`);
            for (const script of scriptList) {
                let start = performance.now();
                if (script.includes(' ')) this.#warn(`"${script}" includes whitespace characters and will be mapped to "${script.replaceAll(' ', '-').replaceAll('.pxasm', '')}"`);
                const raw = fs.readFileSync(path.resolve(filePath, script), 'utf8');
                try {
                    if (logEverything) this.#debug(`Compiling "${script}"`);
                    this.#scripts.set(script.replaceAll(' ', '-').replaceAll('\\', '/').replaceAll('.pxasm', ''), await this.#compiler.compile(raw))
                    if (logEverything) this.#debug(`Compiled "${script}" in ${Math.round(performance.now() - start)}ms`);
                } catch (err) {
                    if (err instanceof PixSimAssemblySyntaxError) {
                        this.#warn(`Failed to load "${script}" due to syntax error in script`);
                        this.#warn(err.stack);
                    } else {
                        this.#error(`Failed to load "${script}"`);
                        this.#error(err.stack);
                    }
                }
            }
            resolve();
        });
    }

    hasScript(path) {
        return this.#scripts.has(path);
    }
    getScript(path, format) {
        if (!this.#scripts.has(path)) return '';
        return this.#scripts.get(path).get(format) ?? '';
    }

    /**
     * A `Promise` representing when all scripts detected have been loaded and compiled.
     */
    get ready() {
        return this.#ready;
    }

    #debug(text) {
        console.debug(text);
        if (this.#logger) this.#logger.debug('[ControllerManager] ' + text);
    }
    #info(text) {
        console.info(text);
        if (this.#logger) this.#logger.info('[ControllerManager] ' + text);
    }
    #warn(text) {
        console.warn(text);
        if (this.#logger) this.#logger.warn('[ControllerManager] ' + text);
    }
    #error(text) {
        console.error(text);
        if (this.#logger) this.#logger.error('[ControllerManager] ' + text);
    }
}

/**
 * PixSimAssemblyCompiler compiles PixSimAssembly into JavaScript code that calls functions for compatibility in participating Pixel Simulators.
 */
class PixSimAssemblyCompiler {
    #pixelConverter;

    static #instructions = {
        'WRITE': 'setVariable',
        'DEFARR': 'defArray',
        'WRITEARR': 'setArray',
        'FNCALL': 'await callFunction',
        'WAIT': 'await wait',
        'PRINT': 'print',
        'SETPX': 'await setPixel',
        'GETPX': 'await getPixel',
        'SETAM': 'await setAmount',
        'GETAM': 'await getAmount',
        'CMOVE': 'moveCamera',
        'CSHAKE': 'shakeCamera',
        'WIN': 'triggerWin',
        'SOUND': 'playSound',
        'STARTSIM': 'startSim',
        'STOPSIM': 'stopSim',
        'TICK': 'await awaitTick'
    };
    static #instructionParamCounts = {
        'WRITE': [2],
        'DEFARR': [2, 3],
        'WRITEARR': [3],
        'FNCALL': Infinity,
        'WAIT': [1],
        'PRINT': Infinity,
        'SETPX': [3],
        'GETPX': [2],
        'SETAM': [3],
        'GETAM': [2],
        'CMOVE': [3, 4],
        'CSHAKE': [3],
        'WIN': [1],
        'SOUND': [3, 4],
        'STARTSIM': [0, 1],
        'STOPSIM': [0],
        'TICK': [0]
    };

    /**
     * Create a new PixSimAssembly Compiler
     * @param {PixelConverter} converter `PixelConverter` instance for converting pixel IDs.
     */
    constructor(converter) {
        if (!(converter instanceof PixelConverter)) throw new TypeError('"converter" must be an instance of PixelConverter');
        this.#pixelConverter = converter;
    }

    /**
     * Asynchronously compile a script
     * @param {string} script String containing the entire uncompiled PixSimAssembly script.
     * @returns {Promise<Map<string, string>>} Map of strings containing the entire compiled PixSimAssembly
     * output script, with each key being the target platform for the corresponding script. The compiled
     * scripts are identical, with the exception of the pixel IDs.
     * @throws A `PixSimAssemblySyntaxError` if compilation fails.
     */
    async compile(script) {
        const lines = script.replaceAll('\r', '').split('\n').map((line) => line.trim());
        const outputLines = [];
        let openBlockStack = [];
        for (let lineNo = 0; lineNo < lines.length; lineNo++) {
            const line = lines[lineNo];
            // tokenize (will be replaced with maitian code at some point)
            const tokens = line.split('//')[0].split(' ');
            if (tokens[0].length == 0) continue;
            const instruction = tokens.shift();
            // expressions are arrays of values and operators, and can be nested to represent parenthesis
            let throwEOExpError = () => {
                throw new PixSimAssemblySyntaxError(`Unexpected end of expression (line ${lineNo + 1})`);
            };
            let tokenizeExpression = (token) => {
                const layer = [];
                let i = 0;
                while (i < token.length) {
                    let char = token[i];
                    let doublechar = token.substring(i, i + 2);
                    if (/<[A-Za-z]/.test(doublechar)) {
                        let nextBracket = token.indexOf('[', i + 1) + 1;
                        let nextAccessClose = token.indexOf('>', i + 1) + 1;
                        if (nextAccessClose == 0) throwEOExpError();
                        if (nextBracket > 0 && nextBracket < nextAccessClose) {
                            if (token[nextBracket] == 'L' && token[nextBracket + 1] == ']') {
                                layer.push(token.substring(i, nextBracket), ['L'], ']>');
                                i = nextBracket + 3;
                            } else {
                                let subExpression = tokenizeExpression(token.substring(nextBracket));
                                layer.push(token.substring(i, nextBracket), subExpression[0], ']>');
                                i = nextBracket + subExpression[1] + 1;
                            }
                            continue;
                        } else if (/<[A-Za-z][A-Za-z\d]*?>/.test(token.substring(i, nextAccessClose))) {
                            layer.push(token.substring(i, nextAccessClose));
                            i = nextAccessClose;
                            continue;
                        } else {
                            console.log(token.substring(i, nextAccessClose))
                        }
                    } else if (char == '"') {
                        let endQuote = token.indexOf('"', i + 1) + 1;
                        if (endQuote == 0) throwEOExpError();
                        layer.push(token.substring(i, endQuote));
                        i = endQuote;
                    } else if (char == '{') {
                        let endBracket = token.indexOf('}', i + 1) + 1;
                        if (endBracket == 0) throwEOExpError();
                        layer.push(token.substring(i, endBracket));
                        i = endBracket;
                    } else if (char == '(') {
                        let subExpression = tokenizeExpression(token.substring(i + 1));
                        layer.push(subExpression[0]);
                        i += subExpression[1] + 2;
                    } else if (char == ')' || char == '}' || char == ']') {
                        return [layer, i + 1];
                    } else if (/\+.|-.|\*.|\/.|%.|\^.|>.|<.|==|!.|&&|\|\||~./.test(doublechar)) {
                        if (/>=|<=|==|!=|&&|\|\||~=|~>|~</.test(doublechar)) {
                            layer.push(doublechar);
                            i += 2;
                        } else {
                            layer.push(char);
                            i++;
                        }
                    } else {
                        let remain = token.substring(i);
                        let str = remain.match(/^.+?[+\-*\/%^<>!=&\|~()\]]/);
                        if (str !== null) {
                            layer.push(str[0].substring(0, str[0].length - 1));
                            i += str[0].length - 1;
                        } else if (!/^[\+\-*\/%^<>=!&\|~()[\]]$/.test(remain)) {
                            layer.push(remain);
                            i += remain.length
                        } else {
                            layer.push(char);
                            i++;
                        }
                    }
                }
                return [layer, i + 1];
            };
            const expressions = tokens.map(t => tokenizeExpression(t)[0]);
            // convert instruction and expressions to js function calls
            let outputLine = '';
            let isOpenBlock = 0;
            let isFunctionCall = true;
            let argCount = PixSimAssemblyCompiler.#instructionParamCounts[instruction];
            if (PixSimAssemblyCompiler.#instructions[instruction] === undefined) {
                isFunctionCall = false;
                switch (instruction) {
                    case 'IF':
                        isOpenBlock = 1;
                        openBlockStack.push(0);
                        outputLine = 'if(';
                        argCount = [1];
                        break;
                    case 'ELSE':
                        if (openBlockStack.length == 0 || openBlockStack[openBlockStack.length - 1] != 0) throw new PixSimAssemblySyntaxError(`Illegal ELSE switch (line ${lineNo + 1})`);
                        outputLine = '}else{';
                        argCount = [0];
                        break;
                    case 'ELIF':
                        isOpenBlock = 1;
                        if (openBlockStack.length == 0 || openBlockStack[openBlockStack.length - 1] != 0) throw new PixSimAssemblySyntaxError(`Illegal ELIF switch (line ${lineNo + 1})`);
                        outputLine = '}else if(';
                        argCount = [1];
                        break;
                    case 'WHILE':
                        isOpenBlock = 1;
                        openBlockStack.push(1);
                        outputLine += 'while(';
                        argCount = [1];
                        break;
                    case 'FOR':
                        isOpenBlock = 2;
                        openBlockStack.push(2);
                        outputLine += 'await forEach(';
                        argCount = [2];
                        break;
                    case 'BREAK':
                        if (openBlockStack.length == 0 || openBlockStack[openBlockStack.length - 1] == 0) throw new PixSimAssemblySyntaxError(`Illegal BREAK instruction (line ${lineNo + 1})`);
                        outputLine += 'break;';
                        argCount = [0];
                        break;
                    case 'CONTINUE':
                        if (openBlockStack.length == 0 || openBlockStack[openBlockStack.length - 1] == 0) throw new PixSimAssemblySyntaxError(`Illegal CONTINUE instruction (line ${lineNo + 1})`);
                        outputLine += 'continue;';
                        argCount = [0];
                        break;
                    case 'FUNCTION':
                        isOpenBlock = 2;
                        openBlockStack.push(2);
                        outputLine += 'defFunction(';
                        if (expressions.length == 0) throw new PixSimAssemblySyntaxError(`Invalid argument count (line ${lineNo + 1})`);
                        argCount = Infinity;
                        break;
                    case 'END':
                        if (openBlockStack.length == 0) throw new PixSimAssemblySyntaxError(`Illegal END instruction (line ${lineNo + 1})`);
                        let prev = openBlockStack.pop();
                        if (prev == 2 || prev == 3) outputLine += '});';
                        else outputLine += '}';
                        argCount = [0];
                        break;
                    default:
                        throw new PixSimAssemblySyntaxError(`Unknown instruction '${instruction}' (line ${lineNo + 1})`);
                }
            } else outputLine = PixSimAssemblyCompiler.#instructions[instruction];
            if (argCount != Infinity && !argCount.includes(expressions.length)) throw new PixSimAssemblySyntaxError(`Invalid argument count (line ${lineNo + 1})`);
            let parseExpression = (exparr) => {
                let ret = '';
                let closeStr = null;
                let closeTimer = 0;
                let lastExp = 1;
                for (let i = 0; i < exparr.length; i++) {
                    const exp = exparr[i];
                    if (closeStr !== null && closeTimer == 0) {
                        ret += closeStr;
                        closeStr = null;
                    }
                    closeTimer--;
                    if (typeof exp == 'string') {
                        if (/<.*(>|\[)/.test(exp)) {
                            if (/<.*\[/.test(exp)) {
                                if (i + 2 >= exparr.length || !Array.isArray(exparr[i + 1]) || exparr[i + 2] != ']>') throwEOExpError();
                                ret += `getArray("${exp.substring(1, exp.length - 1).replaceAll('"', '\\"')}",${parseExpression(exparr[i + 1])})`;
                                i += 2;
                            } else ret += `getVariable("${exp.substring(1, exp.length - 1).replaceAll('"', '\\"')}")`;
                            lastExp = 0;
                        } else if (/{.*}/.test(exp)) {
                            // convert id later
                            ret += exp;
                            lastExp = 0;
                        } else if (/".*"/.test(exp)) {
                            ret += `"${exp.substring(1, exp.length - 1).replaceAll('"', '\\"')}"`;
                            lastExp = 0;
                        } else {
                            if (!isNaN(parseFloat(exp))) {
                                if (lastExp == 0) throw new PixSimAssemblySyntaxError(`Unexpected value '${exp}' (line ${lineNo + 1})`);
                                ret += exp;
                                lastExp = 0;
                            } else if (/".*"/.test(exp)) {
                                if (lastExp == 0) throw new PixSimAssemblySyntaxError(`Unexpected value '${exp}' (line ${lineNo + 1})`);
                                ret += `"${exp.substring(1, exp.length - 1).replaceAll('"', '\\"')}"`;
                                lastExp = 0;
                            } else switch (exp) {
                                case '-':
                                    // negative sign exception
                                    if (lastExp == 1 && (i >= exparr.length - 1 || !/\-?\d+\.?\d*/.test(exparr[i + 1]))) throw new PixSimAssemblySyntaxError(`Unexpected operator '${exp}' (line ${lineNo + 1})`);
                                    ret += exp;
                                    lastExp = 1;
                                    break;
                                case '+':
                                case '*':
                                case '/':
                                case '%':
                                case '>':
                                case '<':
                                case '>=':
                                case '<=':
                                case '&&':
                                case '||':
                                case '!':
                                    if (lastExp == 1) throw new PixSimAssemblySyntaxError(`Unexpected operator '${exp}' (line ${lineNo + 1})`);
                                    ret += exp;
                                    lastExp = 1;
                                    break;
                                case '==':
                                    if (lastExp == 1) throw new PixSimAssemblySyntaxError(`Unexpected operator '${exp}' (line ${lineNo + 1})`);
                                    ret += '===';
                                    lastExp = 1;
                                    break;
                                case '!=':
                                    if (lastExp == 1) throw new PixSimAssemblySyntaxError(`Unexpected operator '${exp}' (line ${lineNo + 1})`);
                                    ret += '!==';
                                    lastExp = 1;
                                    break;
                                case '^':
                                    if (lastExp == 1) throw new PixSimAssemblySyntaxError(`Unexpected operator '${exp}' (line ${lineNo + 1})`);
                                    ret += '**';
                                    lastExp = 1;
                                    break;
                                case '~=':
                                    ret += 'Math.round(';
                                    closeStr = ')';
                                    closeTimer = 1;
                                    lastExp = 1;
                                    break;
                                case '~>':
                                    ret += 'Math.ceil(';
                                    closeStr = ')';
                                    closeTimer = 1;
                                    lastExp = 1;
                                    break;
                                case '~<':
                                    ret += 'Math.floor(';
                                    closeStr = ')';
                                    closeTimer = 1;
                                    lastExp = 1;
                                    break;
                                default:
                                    if (lastExp == 0) throw new PixSimAssemblySyntaxError(`Unexpected value '${exp}' (line ${lineNo + 1})`);
                                    ret += `"${exp.replaceAll('"', '\\"')}"`;
                                    lastExp = 0;
                            }
                        }
                    } else {
                        if (closeStr == ')' && closeTimer == 0) ret += `(${parseExpression(exp)}`;
                        else ret += `(${parseExpression(exp)})`;
                        lastExp = 0;
                    }
                }
                if (closeStr !== null) {
                    if (closeTimer > 0) throwEOExpError();
                    ret += closeStr;
                }
                if (lastExp == 1) throwEOExpError();
                return ret;
            };
            if (isFunctionCall) outputLine += '(';
            for (let expression of expressions) {
                outputLine += parseExpression(expression) + ',';
            }
            let lineCap = isFunctionCall ? ');' : '';
            if (isOpenBlock == 1) lineCap = '){';
            else if (isOpenBlock == 2) lineCap = ',async()=>{';
            outputLine = outputLine.substring(0, outputLine.length - (expressions.length > 0)) + lineCap;
            outputLines.push(outputLine);
        }
        if (openBlockStack.length > 0) throw new PixSimAssemblySyntaxError('Unclosed loop or switch');
        const compiledScript = outputLines.join('');
        const outputMap = new Map();
        for (let format of this.#pixelConverter.conversionFormats) {
            outputMap.set(format, compiledScript.replaceAll(/{[A-Za-z0-9\-_]+?}/g, (match) => {
                let cid = this.#pixelConverter.convertStr(match.substring(1, match.length - 1), 'standard', format);
                if (cid == undefined) throw new PixSimAssemblyPixelIdError(`Unknown pixel id '${match.substring(1, match.length - 1)}'`);
                return `"${cid}"`;
            }));
        }
        return outputMap;
    }
}

class PixSimAssemblyPixelIdError extends Error {
    /**
     * PixSimAssemblyPixelIdErrorConstructor
     * @param {string} message 
     */
    constructor(message = undefined) {
        super(message);
        this.name = 'PixSimAssemblyPixelIdError';
    }
}
class PixSimAssemblySyntaxError extends SyntaxError {
    /**
     * PixSimAssemblySyntaxErrorConstructor
     * @param {string} message 
     */
    constructor(message = undefined) {
        super(message);
        this.name = 'PixSimAssemblySyntaxError';
    }
}

module.exports.ControllerManager = ControllerManager;
module.exports.PixSimAssemblyCompiler = PixSimAssemblyCompiler;
module.exports = ControllerManager;