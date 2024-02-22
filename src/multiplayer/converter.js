const fs = require("fs");
const JSLoader = require("./jsloader");
const Logger = require("../log");

/**
 * Allows for conversion of pixel ids from one game to another.
 */
class PixelConverter {
    #ready;
    #tables = new Map();
    #idTables = new Map();

    /**
     * Create a new `PixelConverter`, loading and parsing the remote files. Not necessary (and inefficient) to do more than once.
     * @param {Array<PixelFormat>} formats List of formats to load.
     * @param {Logger} logger `Logger` instance.
     * @param {boolean} logEverything To log or not to log everything.
     * @param {boolean} allowCache Whether JSLoader is allowed to use the file cache or not.
     */
    constructor(formats, logger, logEverything = false, allowCache = true) {
        const loaders = [];
        for (let i in formats) {
            loaders.push(new JSLoader(formats[i].url, {
                fallback: formats[i].fallback,
                logger: logger,
                logEverything, logEverything,
                allowCache: allowCache,
                allowInsecure: true
            }));
        }
        const rawLookup = fs.readFileSync(__dirname + '/pixsimpixelslookup.csv', 'utf8');
        const lookupTable = rawLookup.replaceAll('\r', '').split('\n').map((line) => line.split(','));
        let extract = async (gid, loader, script) => {
            await loader.ready;
            if (logEverything) logger.info('[PixelConverter] Extracting pixel IDs for ' + gid);
            const pixels = await loader.execute(script);
            const from = new Uint8ClampedArray(Buffer.alloc(256, 0xff));
            const to = new Uint8ClampedArray(Buffer.alloc(256, 0xff));
            const idfrom = new Map();
            const idto = new Map();
            const col = lookupTable[0].findIndex((header) => header.toLowerCase() == gid);
            if (col >= 0) for (let id in pixels) {
                const row = lookupTable.find((row) => row[col] == id);
                if (row) {
                    let id2 = parseInt(row[0]);
                    from[pixels[id]] = id2;
                    to[id2] = pixels[id];
                    idfrom.set(id, id2);
                    idto.set(id2, id);
                }
            }
            this.#tables.set(gid, {
                from: from,
                to: to
            });
            this.#idTables.set(gid, {
                from: idfrom,
                to: idto
            });
            if (logEverything) logger.info('[PixelConverter] Extracted pixel IDs for ' + gid);
            await loader.terminate();
        };
        const promises = [];
        for (let i in formats) {
            promises.push(extract(formats[i].id, loaders[i], formats[i].extractor));
        }
        promises.push(new Promise((resolve, reject) => {
            const idfrom = new Map();
            const idto = new Map();
            const col = lookupTable[0].findIndex((header) => header.toLowerCase() == 'standard');
            if (col >= 0) for (let i = 1; i < lookupTable.length; i++) {
                const row = lookupTable[i];
                let id = parseInt(row[0]);
                idfrom.set(row[col], id);
                idto.set(id, row[col]);
            }
            this.#idTables.set('standard', {
                from: idfrom,
                to: idto
            });
            if (logEverything) logger.info('[PixelConverter] Extracted pixel IDs for PixSim Standard');
            resolve();
        }));
        this.#ready = new Promise(async (resolve, reject) => {
            for (let i in promises) {
                await promises[i];
            }
            if (logEverything) {
                logger.info('[PixelConverter] All pixel IDs extracted');
                let longest = {};
                for (const [format, table] of this.#idTables) {
                    let l = 0;
                    longest[format] = '';
                    for (let [sid, nid] of table.from) {
                        if (sid.length > l) l = sid.length;
                    }
                    for (let i = 0; i < l; i++) {
                        longest[format] += ' ';
                    }
                }
                let outputTable = `+`;
                for (const [format] of this.#idTables) {
                    outputTable += `-----${format.toUpperCase()}${longest[format].substring(format.length).replaceAll(' ', '-')}-+`;
                }
                for (let [nid, sid] of this.#idTables.get('standard').to) {
                    if (sid == '') continue;
                    outputTable += `\n| ${nid}${'   '.substring(('' + nid).length)} ${sid}${longest.standard.substring(sid.length)} | `;
                    for (const [format, table] of this.#tables) {
                        outputTable += ` ${table.to[nid]}${'   '.substring(('' + table.to[nid]).length)} ${this.#idTables.get(format).to.get(nid) ?? ''}${longest[format].substring((this.#idTables.get(format).to.get(nid) ?? '').length)} |`;
                    }
                }
                outputTable += '\n+';
                for (const [format,] of this.#idTables) {
                    outputTable += `-----${longest[format].replaceAll(' ', '-')}-+`;
                }
                logger.debug(outputTable);
            }
            resolve();
        });
    }

    /**
     * Remap a pixel ID as according to the PixSim API specifications.
     * @param {number} n Incoming numerical ID to convert.
     * @param {string} from ID map of incoming.
     * @param {string} to ID map to convert to.
     * @returns {number} Remapped numerical ID, or the input `n` if conversion is not possible.
     */
    convert(n, from, to) {
        if (from === to) return n;
        if (this.#tables.has(from) && this.#tables.has(to)) {
            return this.#tables.get(to).to[this.#tables.get(from).from[n]] ?? 255;
        } else return 255;
    }
    /**
     * Create a copy of and remap the pixel IDs of a compressed grid as according to the PixSim API specifications.
     * @param {Buffer} grid Incoming compressed grid to convert.
     * @param {string} from ID map of incoming.
     * @param {string} to ID map to convert to.
     * @returns {Buffer} A `Buffer` with same length as `grid` where the numericals IDs have been remapped, or the input `grid` `Buffer` if conversion is not possible.
     */
    convertGrid(grid, from, to) {
        if (this.#tables.has(from) && this.#tables.has(to)) {
            const fromTable = this.#tables.get(from).from;
            const toTable = this.#tables.get(to).to;
            const newGrid = Buffer.from(grid);
            let i = 0;
            while (i < grid.length) {
                header = compressed[i++];
                for (let j = 0; j < 8 && i < grid.length; j++) {
                    newGrid[i] = toTable[fromTable[grid[i]]] ?? 255;
                    if (header & 0b10000000 == 0) i++;
                    i++;
                    header <<= 1;
                }
            }
            return newGrid;
        } else return grid;
    }

    /**
     * Remap a pixel String ID as according to the PixSim API specifications.
     * @param {string} id Incoming string ID to convert.
     * @param {string} from ID map of incoming ID.
     * @param {string} to ID map to convert to.
     * @returns {string} Remapped string ID, or the input `id` if conversion is not possible.
     */
    convertStr(id, from, to) {
        if (from === to) return id;
        if (this.#idTables.has(from) && this.#idTables.has(to)) {
            return this.#idTables.get(to).to.get(this.#idTables.get(from).from.get(id)) ?? 'null';
        } else return null;
    }

    /**
     * An `Array<string>` containing the supported formats that can be mapped.
     */
    get conversionFormats() {
        return Array.from(this.#tables.keys());
    }

    /**
     * A `Promise` representing if the files have been loaded and the pixel data been extracted.
     */
    get ready() {
        return this.#ready;
    }
}

// It's pretty clear I don't know what I'm doing, especially trying to do this without TypeScript
/**
 * Information for a format in a `PixelConverter`.
 * @typedef {{id: string, url: string, fallback: url|undefined, extractor: JSExpression}} PixelFormat
 * @typedef {string} JSExpression
 * @param id Internal ID.
 * @param url Primary URL to load format from.
 * @param fallback Secondary URL to load format from, in case primary fails.
 * @param extractor A JavaScript expression to execute within the context of the loader to extract pixels.
 */

module.exports.PixelConverter = PixelConverter;
module.exports.PixelFormat = this.PixelFormat;
module.exports = PixelConverter;