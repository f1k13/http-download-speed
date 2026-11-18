#!/usr/bin/env node
import { download, FatalDownloadError, parseTarget, type DownloadResult } from './download.ts';
import { formatBytes, summarize, toMbitPerSec } from './stats.ts';

const REQUESTS = 10;

/** Коды выхода. */
const EXIT_OK = 0;
const EXIT_SOME_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_INTERRUPTED = 130;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function printUsage(): void {
  console.error('Использование: speedtest <url>');
  console.error('Пример:        speedtest https://proof.ovh.net/files/10Mb.dat');
}

function printSummary(results: readonly DownloadResult[], attempted: number): void {
  console.log('\n--- Итого ---');
  console.log(`Успешных запросов:     ${results.length} из ${attempted}`);
  if (results.length === 0) return;
  const s = summarize(results);
  console.log(`Среднее время запроса: ${s.avgMs.toFixed(1)} ms`);
  console.log(`Скачано всего:         ${formatBytes(s.totalBytes)} (${s.totalBytes} байт)`);
  console.log(
    `Скорость скачивания:   ${s.mbitPerSec.toFixed(2)} Mbit/s (${s.mbytePerSec.toFixed(2)} MB/s)`,
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const arg = argv[0];
  if (arg === '-h' || arg === '--help') {
    printUsage();
    return EXIT_OK;
  }
  if (!arg) {
    printUsage();
    return EXIT_USAGE;
  }

  let target: URL;
  try {
    target = parseTarget(arg);
  } catch (err) {
    console.error(errorMessage(err));
    return EXIT_USAGE;
  }

  // Ctrl+C / docker stop: прерываем текущий запрос и печатаем итог по уже скачанному.
  // Свой обработчик нужен ещё и потому, что в контейнере Node — PID 1
  // и без обработчиков игнорирует SIGINT/SIGTERM.
  const abort = new AbortController();
  const onSignal = (): void => abort.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  console.log(`URL: ${target.href}`);
  console.log(`Запросов: ${REQUESTS} (последовательно)\n`);

  const results: DownloadResult[] = [];
  let attempted = 0;
  let failed = 0;

  for (let i = 1; i <= REQUESTS && !abort.signal.aborted; i++) {
    const label = `#${String(i).padStart(2)}`;
    attempted++;
    try {
      // Последовательно: следующий запрос стартует только после полного ответа.
      const r = await download(target, { signal: abort.signal });
      results.push(r);
      console.log(
        `${label}  ${formatBytes(r.bytes).padStart(10)}  ` +
          `${r.ms.toFixed(1).padStart(9)} ms  ${toMbitPerSec(r.bytes, r.ms).toFixed(2).padStart(8)} Mbit/s`,
      );
    } catch (err) {
      if (abort.signal.aborted) {
        attempted--;
        break;
      }
      failed++;
      console.log(`${label}  ошибка: ${errorMessage(err)}`);
      if (err instanceof FatalDownloadError) {
        console.error('\nОстальные запросы пропущены: повторять бессмысленно.');
        return EXIT_SOME_FAILED;
      }
    }
  }

  if (abort.signal.aborted) console.log('\nПрервано пользователем.');
  printSummary(results, attempted);

  if (abort.signal.aborted) return EXIT_INTERRUPTED;
  return failed > 0 ? EXIT_SOME_FAILED : EXIT_OK;
}

main(process.argv.slice(2)).then(
  (code) => {
    // exit, а не exitCode: после прерывания не ждём закрытия сокетов.
    process.exit(code);
  },
  (err: unknown) => {
    console.error(err);
    process.exit(EXIT_SOME_FAILED);
  },
);
