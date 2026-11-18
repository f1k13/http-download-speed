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
  timeoutMs?: number;
}

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 60_000;

const elapsedMs = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;

/**
 * Выполняет один GET-запрос и полностью дочитывает тело ответа.
 * Тело не сохраняется — считаются только байты.
 */
export function download(rawUrl: string, options: DownloadOptions = {}): Promise<DownloadResult> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = process.hrtime.bigint();

  const attempt = (current: URL, redirectsLeft: number): Promise<DownloadResult> =>
    new Promise((resolve, reject) => {
      const client =
        current.protocol === 'https:' ? https : current.protocol === 'http:' ? http : undefined;
      if (!client) {
        reject(new Error(`Неподдерживаемый протокол: ${current.protocol}`));
        return;
      }

      const req = client.get(
        current,
        {
          // Новое соединение на каждый запрос: все замеры в одинаковых условиях
          // (DNS + TCP + TLS + скачивание).
          agent: false,
          headers: {
            'User-Agent': 'speedtest-cli/1.0',
            // Без сжатия — считаем реальные байты ресурса.
            'Accept-Encoding': 'identity',
            'Cache-Control': 'no-cache',
          },
        },
        (res) => {
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

          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
          });
          res.on('end', () => resolve({ bytes, ms: elapsedMs(start), status }));
          res.on('error', reject);
        },
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Таймаут ${timeoutMs / 1000} с`));
      });
      req.on('error', reject);
    });

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Promise.reject(new Error(`Некорректный URL: ${rawUrl}`));
  }
  return attempt(url, maxRedirects);
}
