const fs = require('fs');

/**
 * A simple logging class with timestamps and logging levels.
 */
class Logger {
    #file;

    /**
     * Create a new `Logger` in a specified directory. Creating a `Logger` will also create a `logs/` directory
     * if there already exists a log.log in the directory, moving it in. This means creating multiple
     * `Loggers` in the same directory will break them.
     * @param {string} path Filepath to the log directory. The default is `'./'`.
     */
    constructor(path = './') {
        if (typeof path != 'string') throw new TypeError('path must be a string');
        if (path.length == 0 || path[path.length - 1] != '/') throw new Error('path must be a valid directory');
        try {
            let filePath = path + 'log.log';
            if (fs.existsSync(filePath)) {
                let dirPath = path + 'logs/';
                if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath);
                let fileCount = fs.readdirSync(dirPath).length;
                fs.renameSync(filePath, dirPath + `log-${fileCount}.log`);
            }
            this.#file = fs.openSync(filePath, 'a');
            console.info('Logger instance created');
            this.info('Logger instance created');
        } catch (err) {
            console.error(err);
        }
    }

    /**
     * Get a timestamp in YYYY-MM-DD [HH:MM:SS] format.
     * @returns Timestamp in YYYY-MM-DD [HH:MM:SS] format.
     */
    timestamp() {
        const time = new Date();
        let month = time.getMonth().toString();
        let day = time.getDate().toString();
        let hour = time.getHours().toString();
        let minute = time.getMinutes().toString();
        let second = time.getSeconds().toString();
        if (month.length == 1) month = 0 + month;
        if (day.length == 1) day = 0 + day;
        if (hour.length == 1) hour = 0 + hour;
        if (minute.length == 1) minute = 0 + minute;
        if (second.length == 1) second = 0 + second;
        return `${time.getFullYear()}-${month}-${day} [${hour}:${minute}:${second}]`;
    }
    /**
     * Append an information-level entry to the log.
     * @param {string} text Text.
     */
    info(text) {
        if (this.#file == undefined) return;
        let prefix = `${this.timestamp()}  INFO | `;
        fs.appendFile(this.#file, `${prefix}${text.toString().replaceAll('\n', `\n${prefix}`)}\n`, { encoding: 'utf-8' }, (err) => { if (err) console.error(err) });
    }
    /**
     * Append a warning-level entry to the log.
     * @param {string} text Text.
     */
    warn(text) {
        if (this.#file == undefined) return;
        let prefix = `${this.timestamp()}  WARN | `;
        fs.appendFile(this.#file, `${prefix}${text.toString().replaceAll('\n', `\n${prefix}`)}\n`, { encoding: 'utf-8' }, (err) => { if (err) console.error(err) });
    }
    /**
     * Append an error-level entry to the log.
     * @param {string} text Text.
     */
    error(text) {
        if (this.#file == undefined) return;
        let prefix = `${this.timestamp()} ERROR | `;
        fs.appendFile(this.#file, `${prefix}${text.toString().replaceAll('\n', `\n${prefix}`)}\n`, { encoding: 'utf-8' }, (err) => { if (err) console.error(err) });
    }
    /**
     * Append an fatal-level entry to the log.
     * @param {string} text Text.
     */
    fatal(text) {
        if (this.#file == undefined) return;
        let prefix = `${this.timestamp()} FATAL | `;
        fs.appendFile(this.#file, `${prefix}${text.toString().replaceAll('\n', `\n${prefix}`)}\n`, { encoding: 'utf-8' }, (err) => { if (err) console.error(err) });
    }

    /**
     * Safely closes the logging session.
     */
    destroy() {
        if (this.#file == undefined) return;
        console.log('Logger instance destroyed');
        this.info('Logger instance destroyed');
        fs.closeSync(this.#file);
        this.#file = undefined;
    }
}

module.exports = Logger;