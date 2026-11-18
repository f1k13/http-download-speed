import type { DownloadResult } from './download.ts';

export interface Summary {
  count: number;
  totalBytes: number;
  totalMs: number;
  avgMs: number;
  /** Мегабиты в секунду (1 Mbit = 10^6 бит). */
  mbitPerSec: number;
  /** Мегабайты в секунду (1 MB = 10^6 байт). */
  mbytePerSec: number;
}

/** Скорость в Mbit/s по объёму в байтах и времени в мс. */
export function toMbitPerSec(bytes: number, ms: number): number {
  return ms > 0 ? (bytes * 8) / (ms / 1000) / 1e6 : 0;
}

/**
 * Итоговая скорость = общий объём / суммарное время,
 * а не среднее скоростей отдельных запросов.
 */
export function summarize(results: readonly DownloadResult[]): Summary {
  const count = results.length;
  const totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);
  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);
  const mbitPerSec = toMbitPerSec(totalBytes, totalMs);
  return {
    count,
    totalBytes,
    totalMs,
    avgMs: count > 0 ? totalMs / count : 0,
    mbitPerSec,
    mbytePerSec: mbitPerSec / 8,
  };
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Десятичные единицы: 1 KB = 1000 B. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let i = 0;
  while (value >= 1000 && i < BYTE_UNITS.length - 1) {
    value /= 1000;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 2)} ${BYTE_UNITS[i]}`;
}
