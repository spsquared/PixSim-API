const fs = require("fs");
const JSLoader = require("./jsloader");
const Logger = require("./log");

/**
 * Allows for conversion of pixel ids from one game to another.
 */
class PixSimGridAdapter {
    #ready;
    #tables = new Map();

    /**
     * Create a new `PixSimGridAdapter`, loading and parsing the remote files. Not necessary (and inefficient) to do more than once.
     * @param {Logger} logger `Logger` instance.
     */
    constructor(logger) {
        const redpixelLoader = new JSLoader('https://raw.githubusercontent.com/definitely-nobody-is-here/red-pixel-simulator/master/pixels.js', {
            fallback: 'https://red.pixelsimulator.repl.co/index.js',
            logger: logger
        });
        const bluepixelLoader = new JSLoader('https://blue-pixel-simulator.maitiansha1.repl.co/pixelSetup.js', {
            logger: logger
        });
        this.#ready = new Promise(async (resolve, reject) => {
            const rawLookup = fs.readFileSync('./pixsimpixelslookup.csv', 'utf8');
            const lookupTable = [];
            rawLookup.split('\n').forEach((line, i) => {
                lookupTable[i] = line.split(',');
            });
            let loadRed = new Promise(async (resolve, reject) => {
                await redpixelLoader.ready;
                const pixels = await redpixelLoader.execute('let p = []; for (let i in pixels) p[i] = pixels[i].numId; return p;');
                const fromRed = new Uint8ClampedArray(Buffer.alloc(256, 0xff));
                const toRed = new Uint8ClampedArray(Buffer.alloc(256, 0xff));
                for (let id in pixels) {
                    let lookup = lookupTable.find((v) => v[1] == id);
                    if (lookup) {
                        let id2 = parseInt(lookup[0]);
                        fromRed[pixels[id]] = id2;
                        toRed[id2] = pixels[id];
                    }
                }
                this.#tables.set('rps', {
                    from: fromRed,
                    to: toRed
                });
                await redpixelLoader.terminate();
                resolve();
            });
            let loadBlue = new Promise(async (resolve, reject) => {
                await bluepixelLoader.ready;
                // currently there is no way to map every available pixel to a number, since
                // bps stores rotations separately
                const pixels = await redpixelLoader.execute('let p = []; return p;');
                const fromBlue = new Uint8ClampedArray(Buffer.alloc(256, 0xff));
                const toBlue = new Uint8ClampedArray(Buffer.alloc(256, 0xff));
                for (let id in pixels) {
                    let lookup = lookupTable.find((v) => v[2] == id);
                    if (lookup) {
                        let id2 = parseInt(lookup[0]);
                        fromBlue[pixels[id]] = id2;
                        toBlue[id2] = pixels[id];
                    }
                }
                this.#tables.set('bps', {
                    from: fromBlue,
                    to: toBlue
                });
                await bluepixelLoader.terminate();
                resolve();
            });
            await loadRed;
            await loadBlue;
            resolve();
        });
    }

    /**
     * Create a copy of and remap the pixel IDs of a compressed grid as according to the PixSim API specifications.
     * @param {Buffer} grid Incoming compressed grid to convert.
     * @param {string} from ID map of incoming grid.
     * @param {string} to ID map to convert grid to.
     * @returns {Buffer} A `Buffer` with same length as `grid` where the pixel ID has been remapped.
     */
    convert(grid, from, to) {
        if (this.#tables.has(from) && this.#tables.has(to)) {
            let fromTable = this.#tables.get(from).from;
            let toTable = this.#tables.get(to).to;
            let newGrid = Buffer.from(grid);
            for (let i = 0; i < grid.length; i += 2) {
                newGrid[i] = toTable[fromTable[grid[i]]];
            }
        }
    }

    /**
     * A `Promise` representing if the files have been loaded and the pixel data been extracted.
     */
    get ready() {
        return this.#ready;
    }
}

module.exports = PixSimGridAdapter;