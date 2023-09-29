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
     * Create a new ControllerManager and load and compile PixAsSimbly code in the `filePath` directory.
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
            let controller = req.path.replace(httpPath, '').replace('/', '');
            if (this.somethingthatdoesntexist) {
                res.send(this.anotherthingthatdoesntexist);
                return;
            }
            res.sendStatus(404);
        });
    }
}

/**
 * PixSimAssemblyCompiler compiles PixAsSimbly into JavaScript code that calls functions for compatibility in participating Pixel Simulators.
 */
class PixSimAssemblyCompiler {
    #pixelConverter;

    /**
     * Create a new PixSimAssembly Compiler
     * @param {PixelConverter} converter `PixelConverter` instance for converting pixel IDs.
     */
    constructor(converter) {
        if (!(converter instanceof PixelConverter)) throw new TypeError('"converter" must be an instance of PixelConverter');
        this.#pixelConverter = converter;
    }

    compile(script) {
        // script is first split into lines, and then parsed manually instead
        // of splitting by space chars due to issues with strings and comments
        const lines = script.replaceAll('\r', '').split('\n').map((line) => line.trim());
        const outputLines = [];
        for (const line of lines) {
            
        }
    }
}

module.exports.ControllerManager = ControllerManager;
module.exports.PixSimAssemblyCompiler = PixSimAssemblyCompiler;
module.exports = PixSimAssemblyCompiler;