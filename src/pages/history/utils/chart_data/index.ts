import {CandlestickData, HistogramData, UTCTimestamp} from 'lightweight-charts';
import {ChartSeriesColor} from '@shared/models/enums';

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
