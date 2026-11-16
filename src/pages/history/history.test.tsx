import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {Coordinate, ISeriesApi, MouseEventParams, UTCTimestamp} from 'lightweight-charts';
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
    const timeScale = {scrollToPosition: vi.fn(), fitContent: vi.fn(), applyOptions: vi.fn()};

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

vi.mock('lightweight-charts', () => ({createChart: createChartMock}));

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
