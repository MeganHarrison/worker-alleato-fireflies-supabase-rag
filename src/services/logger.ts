// Logging service for better debugging and monitoring

import { LogLevel, LogEntry } from '../types';

export class Logger {
  private logLevel: LogLevel;
  private context: Record<string, any> = {};

  constructor(logLevel: LogLevel = 'info') {
    this.logLevel = logLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.logLevel);
  }

  private formatLog(level: LogLevel, message: string, context?: Record<string, any>, error?: Error): LogEntry {
    return {
      level,
      message,
      timestamp: new Date().toISOString(),
      context: { ...this.context, ...context },
      error: error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } as any : undefined,
    };
  }

  private log(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) return;

    const logMethod = entry.level === 'error' ? console.error : 
                     entry.level === 'warn' ? console.warn : 
                     console.log;
    
    logMethod(JSON.stringify(entry));
  }

  debug(message: string, context?: Record<string, any>): void {
    this.log(this.formatLog('debug', message, context));
  }

  info(message: string, context?: Record<string, any>): void {
    this.log(this.formatLog('info', message, context));
  }

  warn(message: string, context?: Record<string, any>): void {
    this.log(this.formatLog('warn', message, context));
  }

  error(message: string, error?: Error, context?: Record<string, any>): void {
    this.log(this.formatLog('error', message, context, error));
  }

  setContext(context: Record<string, any>): void {
    this.context = { ...this.context, ...context };
  }

  clearContext(): void {
    this.context = {};
  }

  child(context: Record<string, any>): Logger {
    const child = new Logger(this.logLevel);
    child.context = { ...this.context, ...context };
    return child;
  }
}