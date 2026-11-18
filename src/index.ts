#!/usr/bin/env node
import { download, type DownloadResult } from './download.ts';
import { formatBytes, summarize, toMbitPerSec } from './stats.ts';

const REQUESTS = 10;

function printUsage(): void {
  console.error('Использование: speedtest <url>');
  console.error('Пример:        speedtest https://proof.ovh.net/files/10Mb.dat');
}

async function main(argv: readonly string[]): Promise<number> {
  const target = argv[0];
  if (!target || target === '-h' || target === '--help') {
    printUsage();
    return target ? 0 : 1;
  }

  console.log(`URL: ${target}`);
  console.log(`Запросов: ${REQUESTS} (последовательно)\n`);

  const results: DownloadResult[] = [];
  for (let i = 1; i <= REQUESTS; i++) {
    const label = `#${String(i).padStart(2)}`;
    try {
      // Последовательно: следующий запрос стартует только после полного ответа.
      const r = await download(target);
      results.push(r);
      console.log(
        `${label}  ${formatBytes(r.bytes).padStart(10)}  ` +
          `${r.ms.toFixed(1).padStart(9)} ms  ${toMbitPerSec(r.bytes, r.ms).toFixed(2).padStart(8)} Mbit/s`,
      );
    } catch (err) {
      console.log(`${label}  ошибка: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (results.length === 0) {
    console.error('\nНи один запрос не завершился успешно.');
    return 1;
  }

  const s = summarize(results);
  console.log('\n--- Итого ---');
  console.log(`Успешных запросов:     ${s.count} из ${REQUESTS}`);
  console.log(`Среднее время запроса: ${s.avgMs.toFixed(1)} ms`);
  console.log(`Скачано всего:         ${formatBytes(s.totalBytes)} (${s.totalBytes} байт)`);
  console.log(
    `Скорость скачивания:   ${s.mbitPerSec.toFixed(2)} Mbit/s (${s.mbytePerSec.toFixed(2)} MB/s)`,
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  },
);
