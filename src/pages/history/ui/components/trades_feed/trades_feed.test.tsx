import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {TradesFeed} from './trades_feed.component';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: {data: string}) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.onclose?.();
    }
  });

  constructor() {
    MockWebSocket.instances.push(this);
  }

  subscribe(symbol = 'tBTCUSD', chanId = 7) {
    act(() => {
      this.readyState = 1;
      this.onopen?.();
    });
    this.receive({event: 'subscribed', channel: 'trades', symbol, chanId});
  }

  receive(data: unknown) {
    act(() => this.onmessage?.({data: JSON.stringify(data)}));
  }
}

// Данные имеют формат публичного канала trades: [ID, MTS, AMOUNT, PRICE]
const firstTrade = [1, 1700000000000, 0.5, 100];
const secondTrade = [2, 1700000001000, -0.25, 101];
const tradeRows = () => screen.getAllByRole('row').slice(1);

describe('TradesFeed', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('subscribes to the selected pair and shows newest trades first with side and local time', () => {
    render(<TradesFeed selectedCurrency="tBTCUSD" />);
    expect(screen.getByRole('status')).toHaveTextContent('Подключение');

    const socket = MockWebSocket.instances[0];
    socket.subscribe();

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({event: 'subscribe', channel: 'trades', symbol: 'tBTCUSD'}),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Онлайн');
    expect(screen.getByText('Сделок пока нет. Ожидаем новые…')).toBeVisible();

    socket.receive([7, [firstTrade, secondTrade]]);

    const rows = tradeRows();
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('101.00')).toBeVisible();
    expect(within(rows[0]).getByText('0.25')).toBeVisible();
    expect(within(rows[0]).getByText('Продажа')).toBeVisible();
    expect(rows[0].querySelector('time')).toHaveAttribute('datetime', '2023-11-14T22:13:21.000Z');
    expect(within(rows[1]).getByText('Покупка')).toBeVisible();
    expect(screen.getByRole('columnheader', {name: 'Объём, BTC'})).toBeVisible();
  });

  test('updates the same trade for te and tu without adding duplicate rows', () => {
    render(<TradesFeed selectedCurrency="tBTCUSD" />);
    const socket = MockWebSocket.instances[0];
    socket.subscribe();
    socket.receive([7, [firstTrade]]);
    socket.receive([7, 'te', secondTrade]);
    socket.receive([7, 'tu', [2, 1700000001000, -0.75, 102]]);

    const rows = tradeRows();
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('102.00')).toBeVisible();
    expect(within(rows[0]).getByText('0.75')).toBeVisible();
    expect(screen.queryByText('101.00')).not.toBeInTheDocument();
  });

  test('keeps only the latest 50 trades across snapshots and new updates', () => {
    render(<TradesFeed selectedCurrency="tBTCUSD" />);
    const socket = MockWebSocket.instances[0];
    socket.subscribe();
    socket.receive([7, Array.from({length: 100}, (_, index) => [index + 1, 1700000000000 + index, 1, 101 + index])]);

    expect(tradeRows()).toHaveLength(50);
    expect(within(tradeRows()[0]).getByText('200.00')).toBeVisible();
    expect(within(tradeRows()[49]).getByText('151.00')).toBeVisible();

    socket.receive([7, 'te', [101, 1700000000100, 1, 201]]);

    expect(tradeRows()).toHaveLength(50);
    expect(within(tradeRows()[0]).getByText('201.00')).toBeVisible();
    expect(screen.queryByText('151.00')).not.toBeInTheDocument();
  });

  test('clears the previous pair and ignores its late messages after switching currency', () => {
    const {rerender} = render(<TradesFeed selectedCurrency="tBTCUSD" />);
    const previous = MockWebSocket.instances[0];
    previous.subscribe();
    previous.receive([7, [firstTrade]]);
    const previousHandler = previous.onmessage;

    rerender(<TradesFeed selectedCurrency="tETHUSD" />);

    expect(previous.close).toHaveBeenCalledTimes(1);
    expect(previous.onmessage).toBeNull();
    expect(tradeRows()).toHaveLength(0);
    expect(screen.getByRole('columnheader', {name: 'Объём, ETH'})).toBeVisible();
    act(() => previousHandler?.({data: JSON.stringify([7, 'te', secondTrade])}));
    expect(tradeRows()).toHaveLength(0);

    const current = MockWebSocket.instances[1];
    current.subscribe('tETHUSD', 8);
    current.receive([8, 'te', [3, 1700000002000, 2, 1500]]);
    expect(tradeRows()).toHaveLength(1);
    expect(screen.getByText('1,500.00')).toBeVisible();

    rerender(<TradesFeed selectedCurrency="tETHUSD" />);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  test('reconnects automatically and merges the new snapshot without losing or duplicating trades', () => {
    render(<TradesFeed selectedCurrency="tBTCUSD" />);
    const previous = MockWebSocket.instances[0];
    previous.subscribe();
    previous.receive([7, [firstTrade]]);

    act(() => previous.close());
    expect(screen.getByRole('status')).toHaveTextContent('Переподключение');
    expect(tradeRows()).toHaveLength(1);

    act(() => vi.advanceTimersByTime(999));
    expect(MockWebSocket.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));

    const current = MockWebSocket.instances[1];
    current.subscribe('tBTCUSD', 8);
    current.receive([8, [firstTrade, secondTrade]]);

    expect(screen.getByRole('status')).toHaveTextContent('Онлайн');
    expect(tradeRows()).toHaveLength(2);
  });

  test('increases reconnect delays for consecutive unsuccessful attempts', () => {
    render(<TradesFeed selectedCurrency="tBTCUSD" />);

    act(() => MockWebSocket.instances[0].close());
    act(() => vi.advanceTimersByTime(1000));
    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => MockWebSocket.instances[1].close());
    act(() => vi.advanceTimersByTime(1999));
    expect(MockWebSocket.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  test('accepts server heartbeats and reconnects if all messages stop', () => {
    render(<TradesFeed selectedCurrency="tBTCUSD" />);
    const socket = MockWebSocket.instances[0];
    socket.subscribe();

    act(() => vi.advanceTimersByTime(44000));
    socket.receive([7, 'hb']);
    act(() => vi.advanceTimersByTime(44000));
    expect(socket.close).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1000));
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Переподключение');
  });

  test('shows a subscription error and allows retrying manually', () => {
    render(<TradesFeed selectedCurrency="tBTCUSD" />);
    const socket = MockWebSocket.instances[0];
    socket.receive({event: 'error', code: 10300, msg: 'subscription failed'});

    expect(screen.getByRole('status')).toHaveTextContent('Ошибка подключения');
    expect(socket.close).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(30000));
    expect(MockWebSocket.instances).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', {name: 'Повторить'}));

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent('Подключение');
    MockWebSocket.instances[1].subscribe();
    expect(screen.getByRole('status')).toHaveTextContent('Онлайн');
  });

  test('ignores malformed messages, invalid trades and other channels', () => {
    render(<TradesFeed selectedCurrency="tBTCUSD" />);
    const socket = MockWebSocket.instances[0];
    socket.subscribe();

    act(() => socket.onmessage?.({data: 'not json'}));
    socket.receive(null);
    socket.receive([9, 'te', firstTrade]);
    socket.receive([7, 'hb']);
    socket.receive([7, 'te', [1, 1700000000000, 0.5]]);
    socket.receive([7, 'te', [1, 1700000000000, 0, 100]]);
    socket.receive([7, 'te', [1, 1700000000000, 1, -100]]);
    socket.receive([7, 'te', [1, 8640000000000001, 1, 100]]);
    socket.receive([7, 'te', [1, 1700000000000, '0.5', 100]]);
    socket.receive([7, [[1, 1700000000000, 0, 100], firstTrade]]);

    expect(tradeRows()).toHaveLength(1);
    expect(screen.getByText('100.00')).toBeVisible();
  });

  test('cleans up sockets and reconnect timers on unmount', () => {
    const {unmount} = render(<TradesFeed selectedCurrency="tBTCUSD" />);
    const socket = MockWebSocket.instances[0];
    act(() => socket.close());

    unmount();
    act(() => vi.advanceTimersByTime(60000));

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.onmessage).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
