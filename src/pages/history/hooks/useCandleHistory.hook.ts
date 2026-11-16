import {MutableRefObject, useEffect, useRef, useState} from 'react';
import {IChartApi, ISeriesApi, LogicalRange, SeriesDataItemTypeMap} from 'lightweight-charts';
import {Candle, TimeFrame, Trade} from '@pages/history/models';
import {
  createSecondCandleStore,
  getCandleData,
  getSecondInterval,
  getTradeData,
  getVolumeData,
  isCandleData,
  mergeCandles,
} from '@pages/history/utils';
import {logger} from '@shared/utils';

const url = 'wss://api-pub.bitfinex.com/ws/2';
const HISTORY_PAGE_SIZE = 500;
const HISTORY_THRESHOLD = 50;
const HISTORY_REQUEST_INTERVAL = 2100;
const TRADE_HISTORY_PAGE_SIZE = 5000;
const TRADE_HISTORY_MAX_SIZE = 10000;
const TRADE_HISTORY_REQUEST_INTERVAL = 4100;

type Props = {
  selectedCurrency: CurrencyType;
  selectedTimeFrame: TimeFrame;
  selectedSeries: keyof SeriesDataItemTypeMap;
  chartRef: MutableRefObject<IChartApi | null>;
  mainSeries: MutableRefObject<ISeriesApi<keyof SeriesDataItemTypeMap> | null>;
  volumeSeries: MutableRefObject<ISeriesApi<'Histogram'> | null>;
};

/**
 * Объединяет поток свечей или сделок и подгрузку истории при прокрутке к левому краю графика
 */
export const useCandleHistory = ({
  selectedCurrency,
  selectedTimeFrame,
  selectedSeries,
  chartRef,
  mainSeries,
  volumeSeries,
}: Props) => {
  const [isLoading, setIsLoading] = useState(true);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [hasHistoryError, setHasHistoryError] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const retryHistoryRef = useRef<(() => void) | null>(null);

  // Создаёт отдельный кэш и подписки для текущей валюты, таймфрейма и типа графика
  useEffect(() => {
    const chart = chartRef.current;
    const series = mainSeries.current;
    const volume = volumeSeries.current;

    if (!chart || !series || !volume) {
      return;
    }

    const timeScale = chart.timeScale();
    const ws = new WebSocket(url);
    const secondInterval = getSecondInterval(selectedTimeFrame);
    const tradeStore = secondInterval === null ? null : createSecondCandleStore(secondInterval);
    const requestInterval = tradeStore ? TRADE_HISTORY_REQUEST_INTERVAL : HISTORY_REQUEST_INTERVAL;
    let tradePageSize = TRADE_HISTORY_PAGE_SIZE;
    let tradeChannelId: number | null = null;
    let candles: Candle[] = [];
    let isDisposed = false;
    let isFetching = false;
    let isApplyingData = false;
    let hasSnapshot = false;
    let canLoadMore = true;
    let historyError = false;
    let lastRequestTime = 0;
    let controller: AbortController | null = null;
    let requestTimeout: ReturnType<typeof setTimeout>;
    let heartbeatInterval: ReturnType<typeof setInterval>;
    let heartbeatTimeout: ReturnType<typeof setTimeout>;

    setIsLoading(true);
    setIsHistoryLoading(false);
    setHasHistoryError(false);
    setHasMoreHistory(true);

    /**
     * Обновляет цену и объём, сохраняя участок и масштаб графика
     * Компенсирует сдвиг индексов общих свечей при подгрузке или исправлении старых сделок
     */
    const applyData = (next: Candle[]) => {
      const range = timeScale.getVisibleLogicalRange();
      const nextIndexes = new Map(next.map((candle, index) => [candle[0], index]));
      // Опирается на свечу рядом с видимой областью: исправления до неё могут удалить любой старый интервал
      const anchorStart = Math.max(0, Math.min(candles.length - 1, Math.floor(range?.from ?? 0)));
      let anchorIndex = anchorStart;

      while (anchorIndex < candles.length && !nextIndexes.has(candles[anchorIndex][0])) {
        anchorIndex += 1;
      }

      if (anchorIndex >= candles.length) {
        anchorIndex = anchorStart - 1;
        while (anchorIndex >= 0 && !nextIndexes.has(candles[anchorIndex][0])) {
          anchorIndex -= 1;
        }
      }

      const shift = anchorIndex < 0 ? 0 : (nextIndexes.get(candles[anchorIndex][0]) ?? anchorIndex) - anchorIndex;
      const hadData = candles.length > 0;
      candles = next;
      isApplyingData = true;

      try {
        series.setData(candles.map(getCandleData));
        volume.setData(candles.map(getVolumeData));

        if (range && hadData) {
          timeScale.setVisibleLogicalRange({from: range.from + shift, to: range.to + shift});
        }
      } finally {
        isApplyingData = false;
      }
    };

    /**
     * Планирует загрузку следующей страницы с учётом ограничения частоты запросов
     * Не допускает параллельных запросов и загрузки после завершения истории
     */
    const loadHistory = () => {
      if (isDisposed || isFetching || !canLoadMore || !hasSnapshot || (!tradeStore && candles.length === 0)) {
        return;
      }

      isFetching = true;
      setIsHistoryLoading(true);

      /**
       * Для обычных интервалов запрашивает свечи раньше самой старой загруженной
       * Для секундных догружает сделки с включительной границей, затем пересчитывает OHLC и объём
       */
      const fetchHistory = async () => {
        const oldestTimestamp = tradeStore ? tradeStore.getOldestTimestamp() : candles[0][0] - 1;
        controller = new AbortController();
        lastRequestTime = Date.now();

        try {
          const params = new URLSearchParams({
            limit: String(tradeStore ? tradePageSize : HISTORY_PAGE_SIZE),
            sort: '-1',
          });

          if (oldestTimestamp !== null) {
            params.set('end', String(oldestTimestamp));
          }

          const endpoint = tradeStore
            ? `trades/${selectedCurrency}/hist`
            : `candles/trade:${selectedTimeFrame}:${selectedCurrency}/hist`;
          // Запрашивает историю через сервер приложения, поскольку Bitfinex не разрешает прямой браузерный fetch
          const response = await fetch(`/api/bitfinex/${endpoint}?${params}`, {signal: controller.signal});

          if (!response.ok) {
            throw new Error(`History request failed: ${response.status}`);
          }

          const data: unknown = await response.json();

          if (isDisposed) {
            return;
          }

          if (!Array.isArray(data)) {
            throw new Error('Invalid candle history response');
          }

          if (tradeStore) {
            const trades = data.map(getTradeData);

            if (!trades.every((trade): trade is Trade => trade !== null)) {
              throw new Error('Invalid trade history response');
            }

            // Сохраняет live-исправления и повторно принимает граничную миллисекунду без дублей ID
            tradeStore.addTrades(
              trades.filter((trade) => oldestTimestamp === null || trade.timestamp <= oldestTimestamp),
              false,
            );

            if (data.length < tradePageSize) {
              canLoadMore = false;
              setHasMoreHistory(false);
            } else if (tradeStore.getOldestTimestamp() === oldestTimestamp) {
              // Очень плотная миллисекунда может целиком занять страницу: увеличивает лимит без пропуска сделок
              if (tradePageSize === TRADE_HISTORY_MAX_SIZE) {
                throw new Error('Too many trades at the history boundary');
              }
              tradePageSize = TRADE_HISTORY_MAX_SIZE;
            }

            applyData(tradeStore.getCandles(!canLoadMore));
            setIsLoading(false);
          } else {
            if (!data.every(isCandleData)) {
              throw new Error('Invalid candle history response');
            }

            const older = data.filter((candle) => candle[0] < candles[0][0]);

            if (older.length === 0) {
              canLoadMore = false;
              setHasMoreHistory(false);
              return;
            }

            // Берёт текущий кэш после ответа, чтобы не потерять WebSocket-обновления за время запроса
            applyData(mergeCandles(candles, older));
          }
          historyError = false;
          setHasHistoryError(false);
        } catch (error) {
          if (!isDisposed && !controller.signal.aborted) {
            historyError = true;
            setHasHistoryError(true);
            logger.warn('Не удалось загрузить историю свечей', error);
          }
        } finally {
          if (!isDisposed) {
            isFetching = false;
            setIsHistoryLoading(false);
            if (tradeStore && candles.length === 0 && canLoadMore && !historyError) {
              loadHistory();
            } else {
              handleVisibleRangeChange(timeScale.getVisibleLogicalRange());
            }
          }
        }
      };

      // Ограничивает частоту REST-запросов при быстром скролле и сильном уменьшении масштаба
      const delay = Math.max(0, requestInterval - (Date.now() - lastRequestTime));

      if (delay > 0) {
        requestTimeout = setTimeout(() => void fetchHistory(), delay);
      } else {
        void fetchHistory();
      }
    };

    /**
     * Подгружает историю, когда слева от видимой области остаётся меньше 50 свечей
     * Пропускает события, вызванные обновлением данных, и ждёт ручного повтора после ошибки
     */
    const handleVisibleRangeChange = (range: LogicalRange | null) => {
      if (range && range.from < HISTORY_THRESHOLD && !isApplyingData && !historyError) {
        loadHistory();
      }
    };

    // Повторяет неудачный запрос с прежнего курсора, сохраняя уже загруженную историю
    retryHistoryRef.current = () => {
      historyError = false;
      setHasHistoryError(false);
      loadHistory();
    };

    timeScale.subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

    /**
     * Отправляет ping только при открытом соединении
     */
    const sendHeartbeat = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({event: 'ping'}));
      }
    };

    /**
     * Применяет уникальную сделку к секундным свечам: текущую обновляет быстро, старые исправления — через общий кэш
     */
    const updateTradeCandles = (trade: Trade) => {
      if (!tradeStore) {
        return;
      }

      const changed = tradeStore.addTrades([trade]);
      const lastTimestamp = candles[candles.length - 1]?.[0];

      if (changed.length === 0) {
        return;
      }

      if (
        lastTimestamp === undefined ||
        changed.some((timestamp) => timestamp < lastTimestamp || !tradeStore.getCandle(timestamp))
      ) {
        applyData(tradeStore.getCandles(!canLoadMore));
        return;
      }

      changed.forEach((timestamp) => {
        const candle = tradeStore.getCandle(timestamp);

        if (!candle || (canLoadMore && timestamp === tradeStore.getFirstBucket())) {
          return;
        }

        series.update(getCandleData(candle));
        volume.update(getVolumeData(candle));

        if (candles[candles.length - 1]?.[0] === timestamp) {
          candles[candles.length - 1] = candle;
        } else {
          candles.push(candle);
        }
      });
    };

    // Подписывается на свечи выбранной пары и запускает проверку связи
    ws.onopen = () => {
      ws.send(
        JSON.stringify(
          tradeStore
            ? {event: 'subscribe', channel: 'trades', symbol: selectedCurrency}
            : {event: 'subscribe', channel: 'candles', key: `trade:${selectedTimeFrame}:${selectedCurrency}`},
        ),
      );
      heartbeatInterval = setInterval(sendHeartbeat, 30000);
    };

    /**
     * Обрабатывает служебные сообщения, снимки свечей или сделок и live-обновления
     * Снимок дополняет кэш, а текущая свеча обновляется без полной перерисовки истории
     */
    ws.onmessage = (event) => {
      if (isDisposed) {
        return;
      }

      let response;

      try {
        response = JSON.parse(event.data);
      } catch {
        return;
      }

      if (response?.event === 'pong') {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = setTimeout(() => ws.close(), 60000);
      }

      if (
        tradeStore &&
        response?.event === 'subscribed' &&
        response.channel === 'trades' &&
        response.symbol === selectedCurrency &&
        typeof response.chanId === 'number'
      ) {
        tradeChannelId = response.chanId;
        return;
      }

      if (tradeStore) {
        if (!Array.isArray(response) || tradeChannelId === null || response[0] !== tradeChannelId) {
          return;
        }

        if (Array.isArray(response[1])) {
          const trades = response[1].map(getTradeData).filter((trade): trade is Trade => trade !== null);
          tradeStore.addTrades(trades, false);
          applyData(tradeStore.getCandles(!canLoadMore));
          const isFirstSnapshot = !hasSnapshot;
          hasSnapshot = true;
          setIsLoading(false);

          // Начальный снимок WebSocket невелик; REST даёт достаточно данных для секундного графика
          if (isFirstSnapshot) {
            loadHistory();
          } else {
            handleVisibleRangeChange(timeScale.getVisibleLogicalRange());
          }
        } else if (response[1] === 'te' || response[1] === 'tu') {
          const trade = getTradeData(response[2]);

          if (trade) {
            updateTradeCandles(trade);
          }
        }

        return;
      }

      if (!Array.isArray(response) || !Array.isArray(response[1])) {
        return;
      }

      if (isCandleData(response[1])) {
        const candle = response[1];
        const last = candles[candles.length - 1];

        // update поддерживает последнюю и новые свечи; старые сообщения не меняют курсор истории
        if (last && candle[0] < last[0]) {
          return;
        }

        try {
          series.update(getCandleData(candle));
          volume.update(getVolumeData(candle));

          if (last?.[0] === candle[0]) {
            candles[candles.length - 1] = candle;
          } else {
            candles.push(candle);
          }
        } catch (error) {
          logger.warn('Не удалось обновить свечу', error);
        }
      } else if (response[1].every(isCandleData)) {
        applyData(mergeCandles(candles, response[1]));
        hasSnapshot = true;
        setIsLoading(false);
        handleVisibleRangeChange(timeScale.getVisibleLogicalRange());
      }
    };

    // Убирает начальный индикатор загрузки при ошибке соединения
    ws.onerror = () => setIsLoading(false);

    // Останавливает проверки связи после закрытия WebSocket
    ws.onclose = () => {
      clearInterval(heartbeatInterval);
      clearTimeout(heartbeatTimeout);
    };

    // Отменяет запросы и подписки, чтобы старые ответы не попали в новый график
    return () => {
      isDisposed = true;
      controller?.abort();
      clearTimeout(requestTimeout);
      clearInterval(heartbeatInterval);
      clearTimeout(heartbeatTimeout);
      timeScale.unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      retryHistoryRef.current = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    };
  }, [selectedCurrency, selectedTimeFrame, selectedSeries, chartRef, mainSeries, volumeSeries]);

  /**
   * Вызывает повтор загрузки для актуальной подписки; после размонтирования ничего не делает
   */
  const retryHistory = () => retryHistoryRef.current?.();

  return {
    isLoading,
    isHistoryLoading,
    hasHistoryError,
    hasMoreHistory,
    retryHistory,
  };
};
