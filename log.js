const fs = require('fs');

/**
 * A simple logging class with timestamps and logging levels.
 */
class Logger {
    #file;

    constructor(path) {
        if (typeof path != 'string') throw new TypeError('file path must be a string');
        try {
            let filePath = path + 'log.log';
            if (fs.existsSync(filePath)) {
                let dirPath = path + 'logs/';
                if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath);
                let fileCount = fs.readdirSync(dirPath).length;
                fs.renameSync(filePath, dirPath + `log-${fileCount}.log`);
            }
            this.#file = fs.openSync(filePath, 'a');
            console.log('Logger instance created');
            this.log('Logger instance created');
        } catch (err) {
            console.error(err);
        }
    }

    /**
     * Get a timestamp in YYYY-MM-DD [HH:MM:SS] format.
     * @returns Timestamp in YYYY-MM-DD [HH:MM:SS] format
     */
    timestamp() {
        const time = new Date();
        let month = time.getMonth().toString();
        let day = time.getDate().toString();
        let hour = time.getHours().toString();
        let minute = time.getMinutes().toString();
        let second = time.getSeconds().toString();
        if(month.length == 1) month = 0 + month;
        if(day.length == 1) day = 0 + day;
        if(hour.length == 1) hour = 0 + hour;
        if(minute.length == 1) minute = 0 + minute;
        if(second.length == 1) second = 0 + second;
        return `${time.getFullYear()}-${month}-${day} [${hour}:${minute}:${second}]`;
    }
    /**
     * Append a debug-level entry to the log.
     * @param {string} text Text
     */
    log(text) {
        let prefix = `${this.timestamp()}   LOG | `;
        fs.appendFile(this.#file, `${prefix}${text.toString().replaceAll('\n', `\n${prefix}`)}\n`, {encoding: 'utf-8'}, (err) => {if (err) console.error(err)});
    }
    /**
     * Append a warning-level entry to the log.
     * @param {string} text Text
     */
    warn(text) {
        let prefix = `${this.timestamp()}  WARN | `;
        fs.appendFile(this.#file, `${prefix}${text.toString().replaceAll('\n', `\n${prefix}`)}\n`, {encoding: 'utf-8'}, (err) => {if (err) console.error(err)});
    }
    /**
     * Append an error-level entry to the log.
     * @param {string} text Text
     */
    error(text) {
        let prefix = `${this.timestamp()} ERROR | `;
        fs.appendFile(this.#file, `${prefix}${text.toString().replaceAll('\n', `\n${prefix}`)}\n`, {encoding: 'utf-8'}, (err) => {if (err) console.error(err)});
    }

    /**
     * Safely closes the logging session.
     */
    destroy() {
        console.log('Logger instance destroyed');
        this.log('Logger instance destroyed');
        fs.closeSync(this.#file);
    }
}

module.exports = Logger;