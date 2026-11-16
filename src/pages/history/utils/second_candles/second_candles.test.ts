import {Trade} from '@pages/history/models';
import {createSecondCandleStore} from './index';

const timestamp = 1700000000000;
const trade = (id: number, offset: number, price: number, amount = 1): Trade => ({
  id,
  timestamp: timestamp + offset,
  price,
  amount: Math.abs(amount),
  side: amount > 0 ? 'buy' : 'sell',
});

describe('Second candle aggregation', () => {
  test('calculates OHLC in execution order and sums bought and sold amounts without inventing empty candles', () => {
    const store = createSecondCandleStore(1000);
    store.addTrades([trade(3, 900, 110, -4), trade(1, 100, 100, 2), trade(2, 500, 90, 3), trade(4, 5100, 120)]);

    expect(store.getCandles(true)).toEqual([
      [timestamp, 100, 110, 110, 90, 9],
      [timestamp + 5000, 120, 120, 120, 120, 1],
    ]);
  });

  test('orders trades with identical timestamps by ID', () => {
    const store = createSecondCandleStore(5000);
    store.addTrades([trade(2, 100, 110), trade(1, 100, 90)]);

    expect(store.getCandles(true)).toEqual([[timestamp, 90, 110, 110, 90, 2]]);
  });

  test('deduplicates te and tu and recalculates extrema and volume on corrections', () => {
    const store = createSecondCandleStore(1000);
    store.addTrades([trade(1, 100, 100), trade(2, 900, 120, 2)]);
    expect(store.addTrades([trade(2, 900, 120, 2)])).toEqual([]);

    store.addTrades([trade(2, 900, 90, 3)]);

    expect(store.getCandles(true)).toEqual([[timestamp, 100, 90, 100, 90, 4]]);
  });

  test('keeps live corrections when REST history overlaps the same trades', () => {
    const store = createSecondCandleStore(1000);
    store.addTrades([trade(1, 100, 120, 3)]);
    store.addTrades([trade(1, 100, 100), trade(2, 200, 110, 2)], false);

    expect(store.getCandles(true)).toEqual([[timestamp, 120, 110, 120, 110, 5]]);
  });

  test('removes the old candle if a corrected trade moves to another bucket', () => {
    const store = createSecondCandleStore(1000);
    store.addTrades([trade(1, 100, 100), trade(2, 2100, 120)]);
    store.addTrades([trade(1, 1100, 110)]);

    expect(store.getCandles(true)).toEqual([
      [timestamp + 1000, 110, 110, 110, 110, 1],
      [timestamp + 2000, 120, 120, 120, 120, 1],
    ]);
    expect(store.getOldestTimestamp()).toBe(timestamp + 1100);
  });

  test('hides the incomplete oldest candle until older trades establish its boundary', () => {
    const store = createSecondCandleStore(1000);
    store.addTrades([trade(2, 900, 110), trade(3, 1200, 120)]);
    expect(store.getCandles()).toEqual([[timestamp + 1000, 120, 120, 120, 120, 1]]);

    store.addTrades([trade(1, 100, 100), trade(0, -100, 90)], false);

    expect(store.getCandles()).toEqual([
      [timestamp, 100, 110, 110, 100, 2],
      [timestamp + 1000, 120, 120, 120, 120, 1],
    ]);
    expect(store.getOldestTimestamp()).toBe(timestamp - 100);
  });
});
