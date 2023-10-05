const fs = require("fs");
const Logger = require("../log");
const PixelConverter = require("./converter");
const path = require("path");

// compiles the script into javascript
// uses converter to replace ids with target ids
// labels wrap everything below it into a function

/**
 * 
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
            if (format != 'rps' && format != 'bps' && format != 'psp') {
                res.sendStatus(400);
                if (logEverything) this.#debug(`Request for ${scriptName} fail - 400`);
                return;
            }
            let script = this.getScript(scriptName, format);
            if (script.length > 0) {
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
        'WAIT': 'wait',
        'PRINT': 'console.log',
        'CAMERA': 'moveCamera',
        'SETPX': 'setPixel',
        'GETPX': 'getPixel',
        'SETAM': 'setAmount',
        'GETAM': 'getAmount'
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
        // script is first split into lines, and then parsed manually instead
        // of splitting by space chars due to issues with strings and comments
        const lines = script.replaceAll('\r', '').split('\n').map((line) => line.trim());
        const outputLines = [];
        let openBlockStack = [];
        for (let lineNo = 0; lineNo < lines.length; lineNo++) {
            const line = lines[lineNo];
            // tokenize (will be replaced with maitian code at some point)
            const tokens = line.split('//')[0].split(' ');
            if (tokens[0].length == 0) continue;
            const instruction = tokens.shift();
            // split expressions to prepare for conversion
            // expressions are arrays of values and operators, and can be nested to represent parenthesis
            const expressions = [];
            for (const token of tokens) {
                const layerStack = [];
                let currLayer = [];
                let currStr = '';
                let closingChar = null;
                for (let i = 0; i < token.length; i++) {
                    let char = token[i];
                    let doublechar = token.substring(i, i + 2);
                    if (closingChar !== null) {
                        currStr += char;
                        if (char == closingChar) {
                            closingChar = null;
                            currLayer.push(currStr);
                            currStr = '';
                        }
                    } else {
                        if (/<[A-Za-z]/.test(doublechar)) {
                            currStr += char;
                            closingChar = '>';
                        } else if (char == '"') {
                            currStr += char;
                            closingChar = '"';
                        } else if (char == '{') {
                            currStr += char;
                            closingChar = '}';
                        } else if (/\+.|-.|\*.|\/.|%.|\^.|>=|<=|>.|<.|==|!=|&&|\|\||!.|~=|~>|~</.test(doublechar)) {
                            if (currStr.length > 0) currLayer.push(currStr);
                            if (/>=|<=|==|!=|&&|\|\||~=|~>|~</.test(doublechar)) {
                                currStr = doublechar;
                                currLayer.push(currStr);
                                i++;
                            } else if (/[+\-*\/%^><!][\d<~!()]/.test(doublechar)) {
                                currStr = char;
                                currLayer.push(currStr);
                            }
                            currStr = '';
                        } else if (char == '(') {
                            if (currStr.length > 0) currLayer.push(currStr);
                            layerStack.push(currLayer);
                            currLayer = [];
                            currStr = '';
                        } else if (char == ')') {
                            if (currStr.length > 0) currLayer.push(currStr);
                            layerStack[layerStack.length - 1].push(currLayer);
                            currLayer = layerStack.pop();
                            currStr = '';
                        } else currStr += char;
                    }
                }
                if (currStr.length > 0) currLayer.push(currStr);
                expressions.push(currLayer);
            }
            // convert instruction and expressions to js function calls
            let outputLine = '';
            let isOpenBlock = false;
            let isFunctionCall = true;
            if (PixSimAssemblyCompiler.#instructions[instruction] === undefined) {
                isFunctionCall = false;
                switch (instruction) {
                    case 'IF':
                        isOpenBlock = true;
                        openBlockStack.push(1);
                        outputLine = 'if(';
                        break;
                    case 'ELSE':
                        if (openBlockStack.length == 0 || !openBlockStack[openBlockStack.length - 1]) throw new PixSimAssemblySyntaxError(`Illegal ELSE switch on line ${lineNo + 1}`);
                        outputLine = '}else{';
                        break;
                    case 'ELIF':
                        isOpenBlock = true;
                        if (openBlockStack.length == 0 || !openBlockStack[openBlockStack.length - 1]) throw new PixSimAssemblySyntaxError(`Illegal ELIF switch on line ${lineNo + 1}`);
                        outputLine = '}else if(';
                        break;
                    case 'WHILE':
                        isOpenBlock = true;
                        openBlockStack.push(0);
                        outputLine += 'while(';
                        break;
                    case 'FOR':
                        isOpenBlock = true;
                        openBlockStack.push(0);
                        throw new Error('FOR instruction not implemented yet');
                        break;
                    case 'BREAK':
                        if (openBlockStack.length == 0 || openBlockStack[openBlockStack.length - 1]) throw new PixSimAssemblySyntaxError(`Illegal BREAK instruction on line ${lineNo + 1}`);
                        outputLine += 'break;';
                        break;
                    case 'CONTINUE':
                        if (openBlockStack.length == 0 || openBlockStack[openBlockStack.length - 1]) throw new PixSimAssemblySyntaxError(`Illegal CONTINUE instruction on line ${lineNo + 1}`);
                        outputLine += 'continue;';
                        break;
                    case 'END':
                        if (openBlockStack.length == 0) throw new PixSimAssemblySyntaxError(`Illegal END instruction on line ${lineNo + 1}`);
                        openBlockStack.pop();
                        outputLine += '}';
                        break;
                    default:
                        throw new PixSimAssemblySyntaxError(`Unknown instruction ${instruction} on line ${lineNo + 1}`);
                }
            } else outputLine = PixSimAssemblyCompiler.#instructions[instruction];
            let parseExpression = (exparr) => {
                let ret = '';
                let closeStr = null;
                for (let exp of exparr) {
                    if (closeStr !== null) {
                        ret += ')';
                        closeStr = null;
                    }
                    if (typeof exp == 'string') {
                        if (/<.*>/.test(exp)) {
                            if (/<.*\[.*]>/.test(exp)) ret += `getArray("${exp.substring(1, exp.indexOf('[')).replaceAll('"', '\\"')}",${exp.substring(exp.indexOf('[') + 1, exp.length - 2).replaceAll('"', '\\"')})`;
                            else ret += `getVariable("${exp.substring(1, exp.length - 1).replaceAll('"', '\\"')}")`;
                        } else if (/{.*}/.test(exp)) {
                            // convert id later
                            ret += exp;
                        } else {
                            if (!isNaN(parseFloat(exp)) || /".*"/.test(exp)) ret += exp;
                            else switch (exp) {
                                case '+':
                                case '-':
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
                                    ret += exp;
                                    break;
                                case '==':
                                    ret += '===';
                                    break;
                                case '!=':
                                    ret += '!==';
                                    break;
                                case '^':
                                    ret += '**';
                                    break;
                                case '~=':
                                    ret += 'Math.round(';
                                    closeStr = ')';
                                    break;
                                case '~>':
                                    ret += 'Math.ceil(';
                                    closeStr = ')';
                                    break;
                                case '~<':
                                    ret += 'Math.floor(';
                                    closeStr = ')';
                                    break;
                                default:
                                    ret += `"${exp.replaceAll('"', '\\"')}"`;
                            }
                        }
                    } else ret += `(${parseExpression(exp)})`;
                }
                if (closeStr !== null) {
                    ret += ')';
                    closeStr = null;
                }
                return ret;
            };
            if (isFunctionCall) outputLine += '(';
            for (let expression of expressions) {
                outputLine += parseExpression(expression) + ',';
            }
            outputLine = outputLine.substring(0, outputLine.length - (expressions.length > 0)) + (isOpenBlock ? '){' : (isFunctionCall ? ');' : ''));
            outputLines.push(outputLine);
        }
        if (openBlockStack.length > 0) throw new PixSimAssemblySyntaxError('Unclosed loop or switch');
        const compiledScript = outputLines.reduce((prev, curr) => prev + '\n' + curr, '').substring(1);
        const outputMap = new Map();
        for (let format of this.#pixelConverter.conversionFormats) {
            outputMap.set(format, compiledScript.replaceAll(/{.*?}/g, (match) => {
                return `"${this.#pixelConverter.convertId(match.substring(1, match.length - 1), 'standard', format)}"`;
            }));
        }
        return outputMap;
    }
}

class PixSimAssemblySyntaxError extends Error {
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