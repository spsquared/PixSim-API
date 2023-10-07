const fs = require("fs");
const Logger = require("../log");
const PixelConverter = require("./converter");
const path = require("path");

/**
 * MapManager handles serving maps from a directory in different formats
 */
class MapManager {
    #ready;
    #pixelConverter;
    #logger;
    #maps = new Map();

    /**
     * Create a new MapManager and load and convert maps in the `filePath` directory.
     * @param {Express} app An Express app.
     * @param {string} httpPath Path to route map serving to.
     * @param {string} filePath Directory to load maps from.
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
        app.get(httpPath + '/list/*', (req, res) => {
            let gameMode = req.path.replace(httpPath + '/list/', '').replace('/', '');
            if (gameMode.length == 0) {
                res.sendStatus(400);
                if (logEverything) this.#debug(`Request for list ${gameMode} fail - 400`);
                return;
            }
            let list = this.mapList(gameMode);
            if (list.length > 0) {
                res.send(list);
                if (logEverything) this.#debug(`Request for list ${gameMode} success`);
                return;
            }
            res.sendStatus(404);
            if (logEverything) this.#debug(`Request for list ${gameMode} fail - 404`);
        });
        app.get(httpPath + '/*', (req, res) => {
            let format = req.query.format;
            let [gameMode, map] = req.path.replace(httpPath + '/', '').split('/');
            if (format == undefined || gameMode == undefined || gameMode.length == 0) {
                res.sendStatus(400);
                if (logEverything) this.#debug(`Request for ${gameMode}/${map} fail - 400`);
                return;
            }
            if (this.hasMap(gameMode, map)) {
                res.send(this.getMap(gameMode, map, format));
                if (logEverything) this.#debug(`Request for ${gameMode}/${map} success`);
                return;
            }
            if (logEverything) this.#debug(`Request for ${gameMode}/${map} fail - 404`);
            res.sendStatus(404);
        });
        this.#ready = new Promise(async (resolve, reject) => {
            await this.#pixelConverter.ready;
            if (logEverything) this.#info('Detecting maps in ' + filePath);
            const dirList = fs.readdirSync(filePath);
            const mapList = [];
            for (let dir of dirList) {
                if (fs.lstatSync(path.resolve(filePath, dir)).isDirectory()) {
                    mapList.push(...fs.readdirSync(path.resolve(filePath, dir)).filter((map) => {
                        return fs.lstatSync(path.resolve(filePath, dir, map)).isFile() && map.endsWith('.json');
                    }).map((map) => {
                        return path.join(dir, map);
                    }));
                }
            }
            this.#info(`Found ${mapList.length} maps in ${filePath}`);
            if (logEverything) this.#debug(`Maps found:${mapList.reduce((acc, curr) => acc + `\n    ${curr}`, '')}`);
            for (const map of mapList) {
                let start = performance.now();
                if (map.includes(' ')) this.#warn(`"${map}" includes whitespace characters and will be mapped to "${map.replaceAll(' ', '-').replaceAll('.json', '')}"`);
                const raw = fs.readFileSync(path.resolve(filePath, map));
                try {
                    if (logEverything) this.#debug(`Loading "${map}"`);
                    this.#addMap(map.replaceAll(' ', '-').replaceAll('.json', ''), JSON.parse(raw));
                    if (logEverything) this.#debug(`Loaded "${map}" in ${Math.round(performance.now() - start)}ms`);
                } catch (err) {
                    this.#error(`Failed to load "${map}"`);
                    this.#error(err.stack);
                }
            }
            resolve();
        });
    }

    #addMap(name, map) {
        let [gameMode, id] = name.split('/').map((e) => e.split('\\'));
        // oh no i have to write parsers and generators for all the formats
        // tokenize save code into size and grid
        // I HAVE NO IDEA HOW THE BPS SAVE CODE FORMAT WORKS AAAAAA ROTATION GRID (just slap _left and stuff onto it but still really hard)
        const tokens = [];
        const placeableTokens = [];
        const teamTokens = [];
        const mapData = {
            width: 0,
            height: 0,
            tick: 0, // should stay as 0 lol
        };
        // tokens split into pairs of id and amount?
        switch (map.format) {
            case 'rps':

                break;
            case 'bps':
                break;
            case 'psp':
                break;
        }
    }

    mapList(gameMode) {
        if (this.#maps.has(gameMode)) return Array.from(this.#maps.get(gameMode).keys());
        else return [];
    }
    hasMap(gameMode, name) {
        if (this.#maps.has(gameMode) && this.#maps.get(gameMode).has(name)) return true;
        return false;
    }
    getMap(gameMode, name, format) {
        if (!this.hasMap(gameMode, name)) return null;
        return this.#maps.get(gameMode).get(name).get(format) ?? null;
    }

    /**
     * A `Promise` representing when all maps detected have been loaded and converted.
     */
    get ready() {
        return this.#ready;
    }

    #debug(text) {
        console.debug(text);
        if (this.#logger) this.#logger.debug('[MapManager] ' + text);
    }
    #info(text) {
        console.info(text);
        if (this.#logger) this.#logger.info('[MapManager] ' + text);
    }
    #warn(text) {
        console.warn(text);
        if (this.#logger) this.#logger.warn('[MapManager] ' + text);
    }
    #error(text) {
        console.error(text);
        if (this.#logger) this.#logger.error('[MapManager] ' + text);
    }
}

module.exports = MapManager;