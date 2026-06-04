import winston from 'winston';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const { combine, printf, colorize } = winston.format;

// Timestamps in ET so logs line up with the market times the strategy reasons
// about (09:30 ET open), regardless of the host/container timezone.
const etStamp = () => new Intl.DateTimeFormat('en-US', {
  timeZone: process.env.TIMEZONE || 'America/New_York',
  hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
}).format(new Date());

const lineFormat = printf(({ level, message, stack }) => {
  return `${etStamp()} ET [${level}] ${stack || message}`;
});

// Console is the primary sink — this is what Railway captures and shows in its
// dashboard. File logging is opt-in (LOG_TO_FILE=true) since container disks are
// ephemeral and wiped on every redeploy.
const transports = [
  new winston.transports.Console({
    format: combine(colorize(), lineFormat),
  }),
];

if (process.env.LOG_TO_FILE === 'true') {
  const logsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'logs');
  mkdirSync(logsDir, { recursive: true });
  transports.push(new winston.transports.File({
    filename: join(logsDir, `${new Date().toISOString().slice(0, 10)}.log`),
    format: lineFormat,
  }));
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.errors({ stack: true }),
  transports,
});

export default logger;
