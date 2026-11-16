import {MutableRefObject, useEffect, useRef, useState} from 'react';
import {IChartApi, ISeriesApi, LogicalRange, SeriesDataItemTypeMap} from 'lightweight-charts';
import {Candle, TimeFrame} from '@pages/history/models';
import {getCandleData, getVolumeData, isCandleData, mergeCandles} from '@pages/history/utils';
import {logger} from '@shared/utils';

const url = 'wss://api-pub.bitfinex.com/ws/2';
const HISTORY_PAGE_SIZE = 500;
const HISTORY_THRESHOLD = 50;
const HISTORY_REQUEST_INTERVAL = 2100;

type Props = {
  selectedCurrency: CurrencyType;
  selectedTimeFrame: TimeFrame;
  selectedSeries: keyof SeriesDataItemTypeMap;
  chartRef: MutableRefObject<IChartApi | null>;
  mainSeries: MutableRefObject<ISeriesApi<keyof SeriesDataItemTypeMap> | null>;
  volumeSeries: MutableRefObject<ISeriesApi<'Histogram'> | null>;
};

/**
 * Объединяет поток свечей и подгрузку истории при прокрутке к левому краю графика
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
     * Сдвигает логические индексы на число добавленных слева свечей
     */
    const applyData = (next: Candle[]) => {
      const range = timeScale.getVisibleLogicalRange();
      const firstTimestamp = candles[0]?.[0];
      const addedBefore = firstTimestamp === undefined ? 0 : next.filter((candle) => candle[0] < firstTimestamp).length;
      const hadData = candles.length > 0;
      candles = next;
      isApplyingData = true;

      try {
        series.setData(candles.map(getCandleData));
        volume.setData(candles.map(getVolumeData));

        if (range && hadData) {
          timeScale.setVisibleLogicalRange({from: range.from + addedBefore, to: range.to + addedBefore});
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
      if (isDisposed || isFetching || !canLoadMore || !hasSnapshot || candles.length === 0) {
        return;
      }

      isFetching = true;
      setIsHistoryLoading(true);

      /**
       * Запрашивает свечи строго раньше самой старой загруженной свечи
       * Проверяет ответ и объединяет его с актуальным кэшем без потери live-обновлений
       */
      const fetchHistory = async () => {
        const oldestTimestamp = candles[0][0];
        controller = new AbortController();
        lastRequestTime = Date.now();

        try {
          const params = new URLSearchParams({
            limit: String(HISTORY_PAGE_SIZE),
            sort: '-1',
            end: String(oldestTimestamp - 1),
          });
          // Запрашивает историю через сервер приложения, поскольку Bitfinex не разрешает прямой браузерный fetch
          const response = await fetch(
            `/api/bitfinex/candles/trade:${selectedTimeFrame}:${selectedCurrency}/hist?${params}`,
            {signal: controller.signal},
          );

          if (!response.ok) {
            throw new Error(`History request failed: ${response.status}`);
          }

          const data: unknown = await response.json();

          if (isDisposed) {
            return;
          }

          if (!Array.isArray(data) || !data.every(isCandleData)) {
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
            handleVisibleRangeChange(timeScale.getVisibleLogicalRange());
          }
        }
      };

      // Ограничивает частоту REST-запросов при быстром скролле и сильном уменьшении масштаба
      const delay = Math.max(0, HISTORY_REQUEST_INTERVAL - (Date.now() - lastRequestTime));

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

    // Подписывается на свечи выбранной пары и запускает проверку связи
    ws.onopen = () => {
      ws.send(
        JSON.stringify({event: 'subscribe', channel: 'candles', key: `trade:${selectedTimeFrame}:${selectedCurrency}`}),
      );
      heartbeatInterval = setInterval(sendHeartbeat, 30000);
    };

    /**
     * Обрабатывает служебные сообщения, начальный снимок и обновления отдельных свечей
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
