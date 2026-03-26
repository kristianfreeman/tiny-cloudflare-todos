export type LogLevel = "info" | "warn" | "error";

export interface StructuredLogEvent {
  event: string;
  requestId: string;
  method: string;
  path: string;
  userId?: string;
  resourceType?: string;
  resourceId?: string;
  status?: number;
  details?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
  };
}

interface LogRecord extends StructuredLogEvent {
  ts: string;
  level: LogLevel;
}

const writeRecord = (level: LogLevel, payload: StructuredLogEvent): void => {
  const record: LogRecord = {
    ts: new Date().toISOString(),
    level,
    ...payload
  };

  const line = JSON.stringify(record);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.info(line);
};

export const logInfo = (payload: StructuredLogEvent): void => writeRecord("info", payload);

export const logWarn = (payload: StructuredLogEvent): void => writeRecord("warn", payload);

export const logError = (payload: StructuredLogEvent): void => writeRecord("error", payload);
