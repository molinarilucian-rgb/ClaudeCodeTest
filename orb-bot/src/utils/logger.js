import winston from 'winston';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dir = dirname(fileURLToPath(import.meta.url));
const logsDir = join(__dir, '..', '..', 'logs');
mkdirSync(logsDir, { recursive: true });

const { combine, timestamp, printf, colorize, errors } = winston.format;

const lineFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} [${level}] ${stack || message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    lineFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize(),
        timestamp({ format: 'HH:mm:ss' }),
        lineFormat
      ),
    }),
    // One rolling file per day (date set at startup; the scheduler restarts daily).
    new winston.transports.File({
      filename: join(logsDir, `${new Date().toISOString().slice(0, 10)}.log`),
    }),
  ],
});

export default logger;
