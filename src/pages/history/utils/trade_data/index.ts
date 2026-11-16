import {Trade} from '@pages/history/models';

export const TRADES_LIMIT = 50;

/**
 * Преобразует сделку Bitfinex [ID, MTS, AMOUNT, PRICE], пропуская некорректные данные
 * Положительный AMOUNT означает покупку, отрицательный — продажу со стороны инициатора сделки
 */
export const getTradeData = (data: unknown): Trade | null => {
  if (
    !Array.isArray(data) ||
    data.length < 4 ||
    !data.slice(0, 4).every((value) => typeof value === 'number' && Number.isFinite(value))
  ) {
    return null;
  }

  const [id, timestamp, amount, price] = data as number[];

  if (
    !Number.isSafeInteger(id) ||
    id < 0 ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    timestamp > 8640000000000000 ||
    amount === 0 ||
    price <= 0
  ) {
    return null;
  }

  return {id, timestamp, amount: Math.abs(amount), price, side: amount > 0 ? 'buy' : 'sell'};
};

/**
 * Объединяет историю и обновления по ID: события te и tu могут описывать одну сделку
 * Ограничивает размер ленты, чтобы список не рос при длительном открытии страницы
 */
export const mergeTrades = (current: Trade[], incoming: Trade[]): Trade[] => {
  const trades = new Map(current.map((trade) => [trade.id, trade]));

  incoming.forEach((trade) => trades.set(trade.id, trade));

  return [...trades.values()].sort((a, b) => b.timestamp - a.timestamp || b.id - a.id).slice(0, TRADES_LIMIT);
};
