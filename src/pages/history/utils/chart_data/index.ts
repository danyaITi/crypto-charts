import {CandlestickData, HistogramData, UTCTimestamp} from 'lightweight-charts';
import {ChartSeriesColor} from '@shared/models/enums';
import {Candle} from '@pages/history/models';

/**
 * Проверяет формат свечи до передачи данных REST или WebSocket в график
 */
export const isCandleData = (data: unknown): data is Candle => {
  return (
    Array.isArray(data) &&
    data.length >= 6 &&
    data.slice(0, 6).every((value) => typeof value === 'number' && Number.isFinite(value)) &&
    Number.isSafeInteger(data[0]) &&
    data[0] > 0 &&
    data.slice(1, 5).every((value) => value > 0) &&
    data[5] >= 0
  );
};

/**
 * Объединяет свечи по времени, сохраняя актуальные значения из текущего потока
 */
export const mergeCandles = (current: Candle[], history: Candle[]): Candle[] => {
  return [...new Map([...history, ...current].map((candle) => [candle[0], candle])).values()].sort(
    (a, b) => a[0] - b[0],
  );
};

/**
 * Преобразует свечу Bitfinex [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME] в данные графика
 */
export const getCandleData = (data: number[]): CandlestickData<UTCTimestamp> => ({
  time: (data[0] / 1000) as UTCTimestamp,
  open: data[1],
  close: data[2],
  high: data[3],
  low: data[4],
});

/**
 * Получает объём свечи в базовой валюте и цвет по направлению изменения цены
 */
export const getVolumeData = (data: number[]): HistogramData<UTCTimestamp> => ({
  time: (data[0] / 1000) as UTCTimestamp,
  value: data[5],
  color: data[2] > data[1] ? ChartSeriesColor.UP : ChartSeriesColor.DOWN,
});
