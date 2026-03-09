import pino from 'pino';
import path from 'path';

const logsDir = path.join(process.cwd(), 'logs');

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-roll',
    options: {
      file: path.join(logsDir, 'nanoclaw'),
      frequency: 'hourly',
      dateFormat: 'yyyy-MM-dd-HH',
      mkdir: true,
    },
  },
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
