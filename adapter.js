const JSLoader = require("./jsloader");
const Logger = require("./log");

/**
 * Allows for conversion of pixel ids from one game to another.
 */
class PixSimGridAdapter {
    #ready;

    /**
     * 
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
            await redpixelLoader.ready.then(() => {
            });
            await bluepixelLoader.ready.then(() => {
            });
            resolve();
        });
    }

    get ready() {
        return this.#ready;
    }
}

module.exports = PixSimGridAdapter;