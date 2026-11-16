// @vitest-environment node

import {createServer as createHttpServer, Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {mkdtemp, rmdir, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer, preview} from 'vite';

const candles = [[1700000000000, 100, 110, 115, 95, 5]];
const trades = [[1, 1700000000000, 0.5, 100]];

/**
 * Закрывает HTTP-сервер теста, освобождая порт и соединения
 */
const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

describe('History API proxy', () => {
  let upstream: Server;
  let upstreamUrl: string;
  let previewDirectory: string;
  const requests: string[] = [];

  beforeAll(async () => {
    // Preview проверяется независимо от наличия готовой сборки: CI запускает тесты перед build
    previewDirectory = await mkdtemp(join(tmpdir(), 'crypto-history-preview-'));
    await writeFile(join(previewDirectory, 'index.html'), '<!doctype html><title>Preview fixture</title>');
    // Имитирует Bitfinex без Access-Control-Allow-Origin: ответ нельзя читать прямым fetch с другого сайта
    upstream = createHttpServer((request, response) => {
      requests.push(request.url ?? '');
      response.writeHead(200, {'Content-Type': 'application/json'});
      response.end(JSON.stringify(request.url?.startsWith('/v2/trades/') ? trades : candles));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    requests.length = 0;
  });
  afterAll(async () => {
    await closeServer(upstream);
    await unlink(join(previewDirectory, 'index.html'));
    await rmdir(previewDirectory);
  });

  test.each([
    ['dev', 'candles/trade:1m:tBTCUSD/hist', candles],
    ['preview', 'candles/trade:1m:tBTCUSD/hist', candles],
    ['dev', 'trades/tBTCUSD/hist', trades],
    ['preview', 'trades/tBTCUSD/hist', trades],
  ])(
    'serves %s history for %s on the application origin and preserves the cursor',
    async (mode, endpoint, expected) => {
      const proxy = {'/api/bitfinex/candles/': {target: upstreamUrl}, '/api/bitfinex/trades/': {target: upstreamUrl}};
      const server =
        mode === 'dev'
          ? await createServer({server: {host: '127.0.0.1', port: 0, proxy, watch: null}})
          : await preview({build: {outDir: previewDirectory}, preview: {host: '127.0.0.1', port: 0, proxy}});

      try {
        if ('listen' in server) {
          await server.listen();
        }

        const address = server.httpServer?.address() as AddressInfo;
        const origin = `http://127.0.0.1:${address.port}`;
        const response = await fetch(`${origin}/api/bitfinex/${endpoint}?limit=500&sort=-1&end=1699999999999`, {
          headers: {Origin: origin},
        });

        expect(response.ok).toBe(true);
        expect(await response.json()).toEqual(expected);
        expect(requests).toEqual([`/v2/${endpoint}?limit=500&sort=-1&end=1699999999999`]);
        expect(new URL(response.url).origin).toBe(origin);
      } finally {
        await server.close();
      }
    },
    15000,
  );
});
