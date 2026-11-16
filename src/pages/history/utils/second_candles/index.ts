import {Candle, TimeFrame, Trade} from '@pages/history/models';

/**
 * Возвращает длительность секундной свечи в миллисекундах; остальные интервалы отдаёт биржа
 */
export const getSecondInterval = (timeFrame: TimeFrame): number | null => {
  const intervals: Partial<Record<TimeFrame, number>> = {
    [TimeFrame['1SECOND']]: 1000,
    [TimeFrame['5SECOND']]: 5000,
    [TimeFrame['10SECOND']]: 10000,
  };

  return intervals[timeFrame] ?? null;
};

/**
 * Собирает OHLC и объём из уникальных сделок; пересчитывает только изменившиеся интервалы
 */
export const createSecondCandleStore = (interval: number) => {
  const trades = new Map<number, Trade>();
  const buckets = new Map<number, Map<number, Trade>>();
  const candles = new Map<number, Candle>();
  let firstBucket = Infinity;

  /**
   * Заново вычисляет свечу, учитывая исправления цены, объёма и порядка сделок с одинаковым временем
   */
  const recalculateCandle = (timestamp: number) => {
    const bucket = buckets.get(timestamp);

    if (!bucket?.size) {
      buckets.delete(timestamp);
      candles.delete(timestamp);
      return;
    }

    let first: Trade | null = null;
    let last: Trade | null = null;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;

    for (const trade of bucket.values()) {
      if (!first || trade.timestamp < first.timestamp || (trade.timestamp === first.timestamp && trade.id < first.id)) {
        first = trade;
      }
      if (!last || trade.timestamp > last.timestamp || (trade.timestamp === last.timestamp && trade.id > last.id)) {
        last = trade;
      }
      high = Math.max(high, trade.price);
      low = Math.min(low, trade.price);
      volume += trade.amount;
    }

    if (first && last) {
      candles.set(timestamp, [timestamp, first.price, last.price, high, low, volume]);
    }
  };

  /**
   * Объединяет сделки по ID, возвращая времена изменившихся свечей
   * История дополняет кэш, а live-события могут исправлять ранее полученную сделку
   */
  const addTrades = (incoming: Trade[], replaceExisting = true): number[] => {
    const changed = new Set<number>();

    incoming.forEach((trade) => {
      const previous = trades.get(trade.id);

      if (
        previous &&
        (!replaceExisting ||
          (previous.timestamp === trade.timestamp &&
            previous.price === trade.price &&
            previous.amount === trade.amount &&
            previous.side === trade.side))
      ) {
        return;
      }

      if (previous) {
        const previousBucket = Math.floor(previous.timestamp / interval) * interval;
        buckets.get(previousBucket)?.delete(previous.id);
        changed.add(previousBucket);
      }

      const timestamp = Math.floor(trade.timestamp / interval) * interval;
      const bucket = buckets.get(timestamp) ?? new Map<number, Trade>();
      bucket.set(trade.id, trade);
      buckets.set(timestamp, bucket);
      trades.set(trade.id, trade);
      firstBucket = Math.min(firstBucket, timestamp);
      changed.add(timestamp);
    });

    changed.forEach(recalculateCandle);

    if (!candles.has(firstBucket)) {
      firstBucket = [...candles.keys()].reduce((first, timestamp) => Math.min(first, timestamp), Infinity);
    }

    return [...changed].sort((a, b) => a - b);
  };

  /**
   * Возвращает свечи по времени; крайний старый интервал скрыт, пока его сделки могут быть неполными
   */
  const getCandles = (includeFirst = false): Candle[] => {
    return [...candles.values()]
      .filter((candle) => includeFirst || candle[0] !== firstBucket)
      .sort((a, b) => a[0] - b[0]);
  };

  /**
   * Возвращает включительный курсор: повторная загрузка граничной миллисекунды не теряет соседние сделки
   */
  const getOldestTimestamp = (): number | null => {
    return trades.size
      ? [...trades.values()].reduce((oldest, trade) => Math.min(oldest, trade.timestamp), Infinity)
      : null;
  };

  return {
    addTrades,
    getCandles,
    getOldestTimestamp,
    getCandle: (timestamp: number) => candles.get(timestamp),
    getFirstBucket: () => firstBucket,
  };
};
