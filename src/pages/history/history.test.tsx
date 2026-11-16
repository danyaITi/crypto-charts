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
