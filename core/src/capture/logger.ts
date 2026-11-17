export {};
/**
 * 抓包服务日志（轻量控制台输出）
 */

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type CaptureLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface CaptureLogger {
    (level: string, message: string, extra?: Record<string, unknown> | string | null): void;
    debug(message: string, extra?: Record<string, unknown> | string | null): void;
    info(message: string, extra?: Record<string, unknown> | string | null): void;
    warn(message: string, extra?: Record<string, unknown> | string | null): void;
    error(message: string, extra?: Record<string, unknown> | string | null): void;
}

function createLogger(level: string = 'info'): CaptureLogger {
    const threshold = LEVELS[String(level || 'info').toLowerCase()] ?? LEVELS.info;

    function write(levelName: string, message: string, extra?: Record<string, unknown> | string | null): void {
        if ((LEVELS[levelName] ?? LEVELS.info) < threshold) return;
        const time = new Date().toISOString();
        const extraText = extra && typeof extra === 'object'
            ? ` ${JSON.stringify(extra)}`
            : (extra ? ` ${extra}` : '');
        console[levelName === 'error' ? 'error' : 'log'](
            `[${time}] [capture] [${levelName.toUpperCase()}] ${message}${extraText}`,
        );
    }

    const log = ((levelName: string, message: string, extra?: Record<string, unknown> | string | null) => {
        write(String(levelName || 'info').toLowerCase(), message, extra);
    }) as CaptureLogger;
    log.debug = (message, extra) => write('debug', message, extra);
    log.info = (message, extra) => write('info', message, extra);
    log.warn = (message, extra) => write('warn', message, extra);
    log.error = (message, extra) => write('error', message, extra);
    return log;
}

module.exports = { createLogger };
