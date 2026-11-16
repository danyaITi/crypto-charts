import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {Coordinate, ISeriesApi, LogicalRange, MouseEventParams, UTCTimestamp} from 'lightweight-charts';
import {ChartSeriesColor} from '@shared/models/enums';
import {sessionStorageKey} from '@shared/utils';
import {HistoryPage} from './history.page';

const {charts, createChartMock} = vi.hoisted(() => {
  const createSeries = () => {
    let visible = true;
    const scale = {applyOptions: vi.fn()};

    return {
      setData: vi.fn(),
      update: vi.fn(),
      priceScale: () => scale,
      options: () => ({visible}),
      applyOptions: vi.fn((options: {visible?: boolean}) => {
        if (options.visible !== undefined) {
          visible = options.visible;
        }
      }),
    };
  };

  const createChart = () => {
    const main = createSeries();
    const volume = createSeries();
    const getVisibleLogicalRange = vi.fn<() => LogicalRange | null>(() => null);
    const timeScale = {
      scrollToPosition: vi.fn(),
      fitContent: vi.fn(),
      applyOptions: vi.fn(),
      getVisibleLogicalRange,
      setVisibleLogicalRange: vi.fn((range: LogicalRange) => getVisibleLogicalRange.mockReturnValue(range)),
      subscribeVisibleLogicalRangeChange: vi.fn<(handler: (range: LogicalRange | null) => void) => void>(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
    };

    return {
      main,
      volume,
      addCandlestickSeries: vi.fn(() => main),
      addBarSeries: vi.fn(() => main),
      addHistogramSeries: vi.fn(() => volume),
      applyOptions: vi.fn(),
      timeScale: () => timeScale,
      subscribeCrosshairMove: vi.fn<(handler: (param: MouseEventParams) => void) => void>(),
      remove: vi.fn(),
    };
  };

  const charts: ReturnType<typeof createChart>[] = [];
  const createChartMock = vi.fn(() => {
    const chart = createChart();
    charts.push(chart);
    return chart;
  });

  return {charts, createChartMock};
});

const historyResponse = (data: unknown, status = 200): Response =>
  ({
    ok: status === 200,
    status,
    json: async () => data,
  }) as Response;

// Имитирует прокрутку пользователя и обновляет видимый диапазон на момент ответа сервера
const moveChart = (chart: (typeof charts)[number], from: number, to: number) => {
  const range = {from, to} as LogicalRange;
  chart.timeScale().getVisibleLogicalRange.mockReturnValue(range);
  const handler = chart.timeScale().subscribeVisibleLogicalRangeChange.mock.calls[0][0];
  act(() => handler(range));
};

describe('HistoryPage second candles', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const timestamp = 1700000000000;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    fetchMock.mockReturnValue(new Promise(() => undefined));
    charts.length = 0;
    MockWebSocket.instances = [];
    sessionStorage.clear();
    sessionStorage.setItem(sessionStorageKey.chartHistoryPage, JSON.stringify({selectedTimeFrame: '1s'}));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const subscribe = (socket: MockWebSocket, trades: number[][]) => {
    act(() => socket.onopen?.());
    socket.receive({event: 'subscribed', channel: 'trades', symbol: 'tBTCUSD', chanId: 7});
    socket.receive([7, trades]);
  };

  test.each(['1s', '5s', '10s'])(
    'builds %s candles from trades and corrects live OHLC/volume without duplicate executions',
    (interval) => {
      sessionStorage.setItem(sessionStorageKey.chartHistoryPage, JSON.stringify({selectedTimeFrame: interval}));
      render(<HistoryPage />);
      const chart = charts[0];
      const socket = MockWebSocket.instances[0];
      subscribe(socket, [
        [1, timestamp + 100, 2, 100],
        [2, timestamp + 1100, -3, 110],
        [3, timestamp + 5200, 1, 90],
        [4, timestamp + 10200, 4, 120],
        [5, timestamp + 10900, 2, 130],
      ]);

      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({event: 'subscribe', channel: 'trades', symbol: 'tBTCUSD'}),
      );
      expect(socket.send.mock.calls.some(([message]) => String(message).includes('candles'))).toBe(false);
      expect(screen.getByRole('button', {name: interval})).toHaveAttribute('aria-pressed', 'true');
      expect(chart.main.setData.mock.lastCall?.[0].at(-1)).toEqual({
        time: 1700000010,
        open: 120,
        close: 130,
        high: 130,
        low: 120,
      });
      expect(chart.volume.setData.mock.lastCall?.[0].at(-1).value).toBe(6);
      expect(chart.timeScale().applyOptions).toHaveBeenLastCalledWith(
        expect.objectContaining({timeVisible: true, secondsVisible: true}),
      );
      const formatTime = chart.applyOptions.mock.calls[0][0].localization.timeFormatter;
      expect(formatTime(1700000000)).not.toBe(formatTime(1700000001));

      socket.receive([7, 'te', [6, timestamp + 10800, 1, 125]]);
      socket.receive([7, 'tu', [6, timestamp + 10800, 1, 125]]);
      expect(chart.volume.update).toHaveBeenCalledTimes(1);
      expect(chart.volume.update).toHaveBeenLastCalledWith({time: 1700000010, value: 7, color: ChartSeriesColor.UP});

      socket.receive([7, 'tu', [6, timestamp + 10800, 3, 140]]);
      expect(chart.main.update).toHaveBeenLastCalledWith({
        time: 1700000010,
        open: 120,
        close: 130,
        high: 140,
        low: 120,
      });
      expect(chart.volume.update).toHaveBeenLastCalledWith({time: 1700000010, value: 9, color: ChartSeriesColor.UP});
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  test('uses an inclusive trade cursor, restores older OHLC and keeps live changes received during REST loading', async () => {
    let resolveRequest!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    render(<HistoryPage />);
    const chart = charts[0];
    const socket = MockWebSocket.instances[0];
    subscribe(socket, [
      [10, timestamp + 100, 2, 100],
      [20, timestamp + 1100, 3, 110],
    ]);

    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost:5173');
    expect(requestUrl.pathname).toBe('/api/bitfinex/trades/tBTCUSD/hist');
    expect(requestUrl.searchParams.get('end')).toBe(String(timestamp + 100));
    expect(requestUrl.searchParams.get('limit')).toBe('5000');

    moveChart(chart, 49, 100);
    socket.receive([7, 'tu', [20, timestamp + 1100, 4, 120]]);
    socket.receive([7, 'te', [30, timestamp + 2100, 5, 130]]);
    await act(async () =>
      resolveRequest(
        historyResponse([
          [10, timestamp + 100, 2, 100],
          [9, timestamp + 100, 1, 90],
          [8, timestamp - 100, 4, 95],
        ]),
      ),
    );

    expect(chart.main.setData).toHaveBeenLastCalledWith([
      {time: 1699999999, open: 95, close: 95, high: 95, low: 95},
      {time: 1700000000, open: 90, close: 100, high: 100, low: 90},
      {time: 1700000001, open: 120, close: 120, high: 120, low: 120},
      {time: 1700000002, open: 130, close: 130, high: 130, low: 130},
    ]);
    expect(chart.volume.setData.mock.lastCall?.[0].map((point: {value: number}) => point.value)).toEqual([4, 3, 4, 5]);
    expect(chart.timeScale().setVisibleLogicalRange).toHaveBeenLastCalledWith({from: 51, to: 102});
  });

  test('uses 4.1 second request spacing and resumes at the same millisecond without dropping its other trades', async () => {
    const page = Array.from({length: 5000}, (_, index) => [
      index + 1,
      index === 4999 ? timestamp + 500 : timestamp - 100,
      1,
      100,
    ]);
    fetchMock.mockResolvedValueOnce(historyResponse(page)).mockResolvedValueOnce(
      historyResponse([
        [1, timestamp - 100, 1, 100],
        [0, timestamp - 900, 2, 80],
        [7000, timestamp - 1500, 1, 70],
      ]),
    );
    render(<HistoryPage />);
    const chart = charts[0];
    await act(async () =>
      subscribe(MockWebSocket.instances[0], [
        [6000, timestamp + 1100, 1, 110],
        [6001, timestamp + 2100, 1, 120],
      ]),
    );

    expect(chart.main.setData.mock.lastCall?.[0][0].time).toBe(1700000000);
    moveChart(chart, 49, 100);
    await act(async () => vi.advanceTimersByTime(4099));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1][0]), 'http://localhost').searchParams.get('end')).toBe(
      String(timestamp - 100),
    );
    expect(
      chart.volume.setData.mock.lastCall?.[0].find((point: {time: number}) => point.time === 1699999999).value,
    ).toBe(5001);
    expect(screen.getByRole('status')).toHaveTextContent('Вся доступная история загружена');
  });

  test('increases the page limit instead of skipping a millisecond that fills the entire REST page', async () => {
    const page = Array.from({length: 5000}, (_, index) => [index + 1, timestamp + 100, 1, 100]);
    fetchMock.mockResolvedValueOnce(historyResponse(page)).mockResolvedValueOnce(historyResponse([]));
    render(<HistoryPage />);
    charts[0].timeScale().getVisibleLogicalRange.mockReturnValue({from: 0, to: 100} as LogicalRange);
    await act(async () =>
      subscribe(MockWebSocket.instances[0], [
        [1, timestamp + 100, 1, 100],
        [6000, timestamp + 1100, 1, 110],
      ]),
    );
    await act(async () => vi.advanceTimersByTime(4100));

    const next = new URL(String(fetchMock.mock.calls[1][0]), 'http://localhost');
    expect(next.searchParams.get('end')).toBe(String(timestamp + 100));
    expect(next.searchParams.get('limit')).toBe('10000');
    expect(charts[0].volume.setData.mock.lastCall?.[0][0].value).toBe(5000);
  });

  test('keeps live candles on a REST error and retries through the trade API', async () => {
    fetchMock.mockResolvedValueOnce(historyResponse(null, 429)).mockResolvedValueOnce(historyResponse([]));
    render(<HistoryPage />);
    const socket = MockWebSocket.instances[0];
    await act(async () =>
      subscribe(socket, [
        [1, timestamp + 100, 1, 100],
        [2, timestamp + 1100, 1, 110],
      ]),
    );

    expect(screen.getByRole('button', {name: 'Повторить'})).toBeVisible();
    socket.receive([7, 'te', [3, timestamp + 1200, 2, 120]]);
    expect(charts[0].volume.update).toHaveBeenLastCalledWith({time: 1700000001, value: 3, color: ChartSeriesColor.UP});
    await act(async () => vi.advanceTimersByTime(4100));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(screen.getByRole('button', {name: 'Повторить'})));

    expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[0][0]);
    expect(screen.queryByRole('button', {name: 'Повторить'})).not.toBeInTheDocument();
  });

  test('aborts second history and restores the normal candle channel when switching to a minute', async () => {
    let resolveRequest!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    render(<HistoryPage />);
    subscribe(MockWebSocket.instances[0], [
      [1, timestamp + 100, 1, 100],
      [2, timestamp + 1100, 1, 110],
    ]);
    const signal = fetchMock.mock.calls[0][1]?.signal;

    fireEvent.click(screen.getByRole('button', {name: '1m'}));
    expect(signal?.aborted).toBe(true);
    const socket = MockWebSocket.instances[1];
    act(() => socket.onopen?.());
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({event: 'subscribe', channel: 'candles', key: 'trade:1m:tBTCUSD'}),
    );
    await act(async () => resolveRequest(historyResponse([[0, timestamp - 100, 1, 90]])));
    expect(charts[1].main.setData).not.toHaveBeenCalled();
    expect(charts[1].timeScale().applyOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({secondsVisible: false}),
    );
  });

  test('can bootstrap an empty trade snapshot through REST and ignores other channels', async () => {
    fetchMock.mockResolvedValueOnce(
      historyResponse([
        [1, timestamp + 100, 1, 100],
        [2, timestamp + 1100, 1, 110],
      ]),
    );
    render(<HistoryPage />);
    const socket = MockWebSocket.instances[0];
    await act(async () => subscribe(socket, []));

    expect(new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost').searchParams.has('end')).toBe(false);
    expect(charts[0].main.setData.mock.lastCall?.[0]).toHaveLength(2);
    socket.receive([9, 'te', [3, timestamp + 2100, 1, 120]]);
    expect(charts[0].main.update).not.toHaveBeenCalled();
  });

  test('preserves the viewport when an old trade correction removes its previous candle', async () => {
    fetchMock.mockResolvedValueOnce(historyResponse([]));
    render(<HistoryPage />);
    const socket = MockWebSocket.instances[0];
    await act(async () =>
      subscribe(socket, [
        [1, timestamp + 100, 1, 100],
        [2, timestamp + 1500, 1, 110],
        [3, timestamp + 2100, 1, 120],
      ]),
    );
    moveChart(charts[0], 0, 2);

    socket.receive([7, 'tu', [1, timestamp + 1100, 2, 105]]);

    expect(charts[0].main.setData).toHaveBeenLastCalledWith([
      {time: 1700000001, open: 105, close: 110, high: 110, low: 105},
      {time: 1700000002, open: 120, close: 120, high: 120, low: 120},
    ]);
    expect(charts[0].timeScale().setVisibleLogicalRange).toHaveBeenLastCalledWith({from: -1, to: 1});
  });

  test('anchors the visible candles when an interior old candle is removed and the earliest one survives', async () => {
    fetchMock.mockResolvedValueOnce(historyResponse([]));
    render(<HistoryPage />);
    const socket = MockWebSocket.instances[0];
    await act(async () =>
      subscribe(socket, [
        [1, timestamp + 100, 1, 100],
        [2, timestamp + 1100, 1, 110],
        [3, timestamp + 2500, 1, 120],
        [4, timestamp + 3100, 1, 130],
      ]),
    );
    moveChart(charts[0], 2, 3);

    socket.receive([7, 'tu', [2, timestamp + 2100, 2, 115]]);

    expect(charts[0].main.setData).toHaveBeenLastCalledWith([
      {time: 1700000000, open: 100, close: 100, high: 100, low: 100},
      {time: 1700000002, open: 115, close: 120, high: 120, low: 115},
      {time: 1700000003, open: 130, close: 130, high: 130, low: 130},
    ]);
    expect(charts[0].timeScale().setVisibleLogicalRange).toHaveBeenLastCalledWith({from: 1, to: 2});
  });
});

describe('HistoryPage history pagination', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const snapshot = [
    [1700000000000, 100, 110, 115, 95, 5],
    [1700000060000, 110, 105, 115, 100, 8],
  ];
  const older = [
    [1699999880000, 90, 95, 100, 85, 3],
    [1699999940000, 95, 100, 105, 90, 4],
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    charts.length = 0;
    MockWebSocket.instances = [];
    sessionStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('loads older candles and volume, deduplicates overlaps and preserves the current viewport and live updates', async () => {
    let resolveRequest!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    render(<HistoryPage />);
    const chart = charts[0];
    const socket = MockWebSocket.instances[0];
    socket.receive([1, snapshot]);

    moveChart(chart, -10, 30);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestPath = String(fetchMock.mock.calls[0][0]);
    const requestUrl = new URL(requestPath, 'http://localhost:5173');
    expect(requestPath).toMatch(/^\/api\/bitfinex\/candles\//);
    expect(requestUrl.origin).toBe('http://localhost:5173');
    expect(requestUrl.pathname).toBe('/api/bitfinex/candles/trade:1m:tBTCUSD/hist');
    expect(requestUrl.searchParams.get('end')).toBe('1699999999999');
    expect(requestUrl.searchParams.get('limit')).toBe('500');
    expect(requestUrl.searchParams.get('sort')).toBe('-1');
    expect(screen.getByRole('status')).toHaveTextContent('Загружаем историю');

    moveChart(chart, -20, 40);
    socket.receive([1, [1700000060000, 110, 112, 115, 100, 9]]);
    socket.receive([1, [1700000120000, 112, 120, 125, 110, 12]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => resolveRequest(historyResponse([older[1], older[0], older[1], snapshot[0]])));

    expect(chart.main.setData).toHaveBeenLastCalledWith([
      {time: 1699999880, open: 90, close: 95, high: 100, low: 85},
      {time: 1699999940, open: 95, close: 100, high: 105, low: 90},
      {time: 1700000000, open: 100, close: 110, high: 115, low: 95},
      {time: 1700000060, open: 110, close: 112, high: 115, low: 100},
      {time: 1700000120, open: 112, close: 120, high: 125, low: 110},
    ]);
    expect(chart.volume.setData.mock.lastCall?.[0]).toHaveLength(5);
    expect(chart.volume.setData.mock.lastCall?.[0][4]).toEqual({
      time: 1700000120,
      value: 12,
      color: ChartSeriesColor.UP,
    });
    expect(chart.timeScale().setVisibleLogicalRange).toHaveBeenLastCalledWith({from: -18, to: 42});
    expect(chart.timeScale().fitContent).toHaveBeenCalledTimes(1);
  });

  test('waits for a snapshot and requests data only near the left edge', () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    render(<HistoryPage />);
    const chart = charts[0];
    moveChart(chart, 20, 100);
    expect(fetchMock).not.toHaveBeenCalled();

    chart.timeScale().getVisibleLogicalRange.mockReturnValue({from: 50, to: 100} as LogicalRange);
    MockWebSocket.instances[0].receive([1, snapshot]);
    expect(fetchMock).not.toHaveBeenCalled();

    moveChart(chart, 49, 100);
    moveChart(chart, 0, 100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('advances the cursor, limits request frequency and stops after the end of history', async () => {
    fetchMock.mockResolvedValueOnce(historyResponse(older)).mockResolvedValueOnce(historyResponse([]));
    render(<HistoryPage />);
    const chart = charts[0];
    MockWebSocket.instances[0].receive([1, snapshot]);

    await act(async () => moveChart(chart, 49, 100));
    expect(chart.timeScale().setVisibleLogicalRange).toHaveBeenLastCalledWith({from: 51, to: 102});
    moveChart(chart, 49, 100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(2099));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1][0]), 'http://localhost:5173').searchParams.get('end')).toBe(
      '1699999879999',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Вся доступная история загружена');

    moveChart(chart, -500, 100);
    await act(async () => vi.advanceTimersByTime(10000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chart.main.setData).toHaveBeenCalledTimes(2);
  });

  test('loads successive pages when the user scrolls past more than one page', async () => {
    fetchMock.mockResolvedValueOnce(historyResponse(older)).mockResolvedValueOnce(historyResponse([]));
    render(<HistoryPage />);
    const chart = charts[0];
    MockWebSocket.instances[0].receive([1, snapshot]);

    await act(async () => moveChart(chart, -500, -100));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(2100));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('Вся доступная история загружена');
  });

  test.each([429, 500])('keeps the chart on HTTP %s and retries the same page only on demand', async (status) => {
    fetchMock.mockResolvedValueOnce(historyResponse(null, status)).mockResolvedValueOnce(historyResponse(older));
    render(<HistoryPage />);
    const chart = charts[0];
    MockWebSocket.instances[0].receive([1, snapshot]);

    await act(async () => moveChart(chart, 49, 100));
    expect(screen.getByRole('status')).toHaveTextContent('Не удалось загрузить историю');
    expect(chart.main.setData).toHaveBeenCalledTimes(1);
    moveChart(chart, 10, 100);
    await act(async () => vi.advanceTimersByTime(60000));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    chart.timeScale().getVisibleLogicalRange.mockReturnValue({from: 49, to: 100} as LogicalRange);
    await act(async () => fireEvent.click(screen.getByRole('button', {name: 'Повторить'})));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[0][0]);
    expect(screen.queryByText('Не удалось загрузить историю.')).not.toBeInTheDocument();
    expect(chart.main.setData.mock.lastCall?.[0]).toHaveLength(4);
  });

  test('treats malformed history as an error rather than the end of available data', async () => {
    fetchMock.mockResolvedValueOnce(historyResponse([['error', 10020, 'invalid response']]));
    render(<HistoryPage />);
    MockWebSocket.instances[0].receive([1, snapshot]);

    await act(async () => moveChart(charts[0], 49, 100));

    expect(screen.getByRole('button', {name: 'Повторить'})).toBeVisible();
    expect(screen.queryByText('Вся доступная история загружена')).not.toBeInTheDocument();
    expect(charts[0].main.setData).toHaveBeenCalledTimes(1);
  });

  test.each(['currency', 'timeframe', 'series'])(
    'aborts pending history and ignores stale data after switching %s',
    async (selection) => {
      let resolveRequest!: (response: Response) => void;
      fetchMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
      );
      render(<HistoryPage />);
      const previousChart = charts[0];
      MockWebSocket.instances[0].receive([1, snapshot]);
      moveChart(previousChart, 49, 100);
      const signal = fetchMock.mock.calls[0][1]?.signal;

      if (selection === 'currency') {
        fireEvent.click(screen.getByText('ETH'));
      } else if (selection === 'timeframe') {
        fireEvent.click(screen.getByRole('button', {name: '15m'}));
      } else {
        fireEvent.click(screen.getByText('Бары'));
      }

      expect(signal?.aborted).toBe(true);
      expect(previousChart.timeScale().unsubscribeVisibleLogicalRangeChange).toHaveBeenCalledWith(
        previousChart.timeScale().subscribeVisibleLogicalRangeChange.mock.calls[0][0],
      );
      await act(async () => resolveRequest(historyResponse(older)));
      expect(previousChart.main.setData).toHaveBeenCalledTimes(1);
      expect(charts[1].main.setData).not.toHaveBeenCalled();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    },
  );

  test('cancels a scheduled page request on unmount', async () => {
    fetchMock.mockResolvedValueOnce(historyResponse(older));
    const {unmount} = render(<HistoryPage />);
    MockWebSocket.instances[0].receive([1, snapshot]);
    await act(async () => moveChart(charts[0], -100, 100));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => vi.advanceTimersByTime(60000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('retains paginated data when another WebSocket snapshot arrives', async () => {
    fetchMock.mockResolvedValueOnce(historyResponse(older));
    render(<HistoryPage />);
    MockWebSocket.instances[0].receive([1, snapshot]);
    await act(async () => moveChart(charts[0], 49, 100));

    MockWebSocket.instances[0].receive([1, snapshot]);

    expect(charts[0].main.setData.mock.lastCall?.[0]).toHaveLength(4);
    expect(charts[0].volume.setData.mock.lastCall?.[0]).toHaveLength(4);
    expect(charts[0].timeScale().setVisibleLogicalRange).toHaveBeenLastCalledWith({from: 51, to: 102});
  });
});

vi.mock('lightweight-charts', () => ({createChart: createChartMock}));

// Лента проверяется отдельно, чтобы её соединение не влияло на сценарии графика
vi.mock('./ui/components/trades_feed', () => ({TradesFeed: () => null}));

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: {data: string}) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
  });

  constructor() {
    MockWebSocket.instances.push(this);
  }

  receive(data: unknown) {
    act(() => this.onmessage?.({data: JSON.stringify(data)}));
  }
}

// Вызывает наведение на свечу без canvas, используя контракт событий графика
const hoverCandle = (chart: (typeof charts)[number], volume: number) => {
  const handler = chart.subscribeCrosshairMove.mock.calls[0][0];
  const time = 1700000000 as UTCTimestamp;
  const seriesData: MouseEventParams['seriesData'] = new Map();

  seriesData.set(chart.main as unknown as ISeriesApi<'Candlestick'>, {time, open: 100, close: 110, high: 115, low: 95});
  seriesData.set(chart.volume as unknown as ISeriesApi<'Histogram'>, {time, value: volume});

  act(() =>
    handler({
      point: {x: 10 as Coordinate, y: 10 as Coordinate},
      time,
      seriesData,
    }),
  );
};

describe('HistoryPage volume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    charts.length = 0;
    MockWebSocket.instances = [];
    sessionStorage.clear();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test('loads price and volume in chronological order and replaces the current candle volume', () => {
    render(<HistoryPage />);
    const socket = MockWebSocket.instances[0];
    const {main, volume} = charts[0];

    socket.receive([
      1,
      [
        [1700000060000, 110, 105, 115, 100, 8],
        [1700000000000, 100, 110, 115, 95, 5],
      ],
    ]);

    expect(main.setData).toHaveBeenLastCalledWith([
      {time: 1700000000, open: 100, close: 110, high: 115, low: 95},
      {time: 1700000060, open: 110, close: 105, high: 115, low: 100},
    ]);
    expect(volume.setData).toHaveBeenLastCalledWith([
      {time: 1700000000, value: 5, color: ChartSeriesColor.UP},
      {time: 1700000060, value: 8, color: ChartSeriesColor.DOWN},
    ]);

    socket.receive([1, [1700000060000, 110, 112, 115, 100, 9]]);

    expect(main.update).toHaveBeenLastCalledWith({time: 1700000060, open: 110, close: 112, high: 115, low: 100});
    expect(volume.update).toHaveBeenLastCalledWith({time: 1700000060, value: 9, color: ChartSeriesColor.UP});
    expect(volume.setData).toHaveBeenCalledTimes(1);

    socket.receive([1, 'hb']);
    expect(volume.update).toHaveBeenCalledTimes(1);
  });

  test('toggles volume and its legend without recreating the chart or socket and keeps receiving data', () => {
    const {container} = render(<HistoryPage />);
    const button = screen.getByRole('button', {name: 'Объём'});
    const {main, volume} = charts[0];

    hoverCandle(charts[0], 0);

    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('[data-volume]')).toHaveTextContent('ОБЪЁМ 0 BTC');
    expect(container.querySelector('[data-volume]')).toBeVisible();
    expect(main.priceScale().applyOptions).toHaveBeenLastCalledWith({scaleMargins: {top: 0.1, bottom: 0.25}});

    fireEvent.click(button);

    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(volume.applyOptions).toHaveBeenLastCalledWith({visible: false});
    expect(container.querySelector('[data-volume]')).not.toBeVisible();
    expect(main.priceScale().applyOptions).toHaveBeenLastCalledWith({scaleMargins: {top: 0.1, bottom: 0.1}});
    expect(JSON.parse(sessionStorage.getItem(sessionStorageKey.chartHistoryPage) ?? '{}').isVolumeVisible).toBe(false);

    MockWebSocket.instances[0].receive([1, [1700000000000, 100, 110, 115, 95, 7]]);
    expect(volume.update).toHaveBeenLastCalledWith({time: 1700000000, value: 7, color: ChartSeriesColor.UP});

    fireEvent.click(button);

    expect(volume.applyOptions).toHaveBeenLastCalledWith({visible: true});
    expect(container.querySelector('[data-volume]')).toBeVisible();
    expect(createChartMock).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  test('restores hidden volume and preserves it when switching timeframe and chart type', () => {
    sessionStorage.setItem(sessionStorageKey.chartHistoryPage, JSON.stringify({isVolumeVisible: false}));
    render(<HistoryPage />);

    expect(screen.getByRole('button', {name: 'Объём'})).toHaveAttribute('aria-pressed', 'false');
    expect(charts[0].volume.applyOptions).toHaveBeenLastCalledWith({visible: false});

    fireEvent.click(screen.getByRole('button', {name: '15m'}));

    expect(charts[1].volume.applyOptions).toHaveBeenLastCalledWith({visible: false});
    expect(MockWebSocket.instances[0].close).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances[0].onmessage).toBeNull();
    act(() => MockWebSocket.instances[1].onopen?.());
    expect(MockWebSocket.instances[1].send).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'subscribe',
        channel: 'candles',
        key: 'trade:15m:tBTCUSD',
      }),
    );

    fireEvent.click(screen.getByText('Бары'));

    expect(charts[2].addBarSeries).toHaveBeenCalledTimes(1);
    expect(charts[2].volume.applyOptions).toHaveBeenLastCalledWith({visible: false});
  });

  test('shows volume by default for saved settings from the previous version', () => {
    sessionStorage.setItem(sessionStorageKey.chartHistoryPage, JSON.stringify({selectedCurrency: 'tETHUSD'}));
    const {container} = render(<HistoryPage />);

    hoverCandle(charts[0], 0.00000001);

    expect(screen.getByRole('button', {name: 'Объём'})).toHaveAttribute('aria-pressed', 'true');
    const legend = container.querySelector('[data-volume]');
    expect(legend).toHaveTextContent('ETH');
    expect(legend).not.toHaveTextContent('$');
    expect(legend).not.toHaveTextContent('ОБЪЁМ 0 ETH');
  });

  test('clears the old legend and updates the volume unit when switching currency', () => {
    const {container} = render(<HistoryPage />);
    hoverCandle(charts[0], 5);
    expect(container.querySelector('[data-volume]')).toHaveTextContent('BTC');

    fireEvent.click(screen.getByText('SOL'));

    expect(container.querySelector('[data-volume]')).toBeNull();
    expect(charts[0].remove).toHaveBeenCalledTimes(1);
    hoverCandle(charts[1], 12);
    expect(container.querySelector('[data-volume]')).toHaveTextContent('ОБЪЁМ 12 SOL');
  });

  test('handles an empty snapshot without treating it as a candle update', () => {
    render(<HistoryPage />);

    MockWebSocket.instances[0].receive([1, []]);

    expect(charts[0].main.setData).toHaveBeenCalledWith([]);
    expect(charts[0].volume.setData).toHaveBeenCalledWith([]);
    expect(charts[0].volume.update).not.toHaveBeenCalled();
  });
});
