import http from 'node:http';
import https from 'node:https';

export interface DownloadResult {
  /** Размер полученного тела ответа, байт. */
  bytes: number;
  /** Время от отправки запроса до последнего байта тела, мс. */
  ms: number;
  status: number;
}

export interface DownloadOptions {
  maxRedirects?: number;
  /** Сколько ждать заголовков ответа (подключение + TLS + ответ сервера), мс. */
  responseTimeoutMs?: number;
  /** Сколько ждать очередной порции данных при скачивании тела, мс. */
  idleTimeoutMs?: number;
  /** Отмена запроса (например, по Ctrl+C). */
  signal?: AbortSignal;
}

/** Ошибка, при которой повторять запросы бессмысленно. */
export class FatalDownloadError extends Error {}

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_RESPONSE_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/** Сетевые ошибки, которые не исправятся сами при следующей попытке. */
const FATAL_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED']);

const elapsedMs = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;

/** Разбирает адрес и проверяет протокол. Бросает понятную ошибку. */
export function parseTarget(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FatalDownloadError(`Некорректный URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FatalDownloadError(`Неподдерживаемый протокол: ${url.protocol} (нужен http или https)`);
  }
  return url;
}

/**
 * Выполняет один GET-запрос и полностью дочитывает тело ответа.
 * Тело не сохраняется — считаются только байты.
 */
export function download(target: URL, options: DownloadOptions = {}): Promise<DownloadResult> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const start = process.hrtime.bigint();

  const attempt = (current: URL, redirectsLeft: number): Promise<DownloadResult> =>
    new Promise((resolve, reject) => {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        reject(new FatalDownloadError(`Редирект на неподдерживаемый протокол: ${current.protocol}`));
        return;
      }
      const client = current.protocol === 'https:' ? https : http;

      const req = client.get(current, {
        // Новое соединение на каждый запрос: все замеры в одинаковых условиях
        // (DNS + TCP + TLS + скачивание).
        agent: false,
        headers: {
          'User-Agent': 'speedtest-cli/1.0',
          // Без сжатия — считаем реальные байты ресурса.
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache',
        },
        ...(options.signal ? { signal: options.signal } : {}),
      });

      // Таймаут на получение заголовков: недоступный сервер не держит нас минуту.
      const responseTimer = setTimeout(() => {
        req.destroy(new Error(`Сервер не ответил за ${responseTimeoutMs / 1000} с`));
      }, responseTimeoutMs);

      req.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(responseTimer);
        if (err.code && FATAL_CODES.has(err.code)) {
          reject(new FatalDownloadError(`${err.code}: ${current.host}`));
        } else {
          reject(err);
        }
      });

      req.on('response', (res) => {
        clearTimeout(responseTimer);
        // Дальше — таймаут простоя при скачивании тела.
        req.setTimeout(idleTimeoutMs, () => {
          req.destroy(new Error(`Нет данных ${idleTimeoutMs / 1000} с`));
        });

        const status = res.statusCode ?? 0;
        const { location } = res.headers;

        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Слишком много редиректов'));
            return;
          }
          // Время редиректов входит в общее время запроса (start общий).
          attempt(new URL(location, current), redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }

        const lengthHeader = res.headers['content-length'];
        const expected = lengthHeader !== undefined ? Number(lengthHeader) : undefined;

        let bytes = 0;
        let ended = false;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
        });
        res.on('end', () => {
          ended = true;
          if (expected !== undefined && Number.isFinite(expected) && bytes !== expected) {
            reject(new Error(`Ответ оборван: получено ${bytes} из ${expected} байт`));
            return;
          }
          resolve({ bytes, ms: elapsedMs(start), status });
        });
        // Соединение оборвалось, а тело не дочитано. 'close' — страховка,
        // чтобы промис не завис, если 'error' не пришёл.
        const onBroken = (): void => {
          if (ended) return;
          const of = expected !== undefined ? ` из ${expected}` : '';
          reject(new Error(`Ответ оборван: получено ${bytes}${of} байт`));
        };
        res.on('error', onBroken);
        res.on('close', onBroken);
      });
    });

  return attempt(target, maxRedirects);
}
