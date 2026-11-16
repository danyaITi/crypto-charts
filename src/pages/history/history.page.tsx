import {useChart} from '@shared/hooks';
import styles from './styles.module.scss';
import {
  ChartBackgroundColor,
  ChartBorderColor,
  ChartGridColor,
  ChartSeriesColor,
  ChartTextColor,
} from '@shared/models/enums';
import {useEffect, useState} from 'react';
import {SeriesDataItemTypeMap} from 'lightweight-charts';
import {Button, Legend, Loader} from '@shared/components';

import {MarketArea, MenuSeries, TimeFrames, TradesFeed} from '@pages/history/ui';
import {TimeFrame} from '@pages/history/models';
import {classNames, getDataSessionStorage, logger, sessionStorageKey, setDataSessionStorage} from '@shared/utils';
import {getCandleData, getVolumeData} from '@pages/history/utils';

const url = 'wss://api-pub.bitfinex.com/ws/2';

type DataForSave = {
  selectedTimeFrame: TimeFrame;
  selectedSeries: keyof SeriesDataItemTypeMap;
  selectedCurrency: CurrencyType;
  isVolumeVisible: boolean;
};

/**
 * Страница мониторинга истории курса крипто-валют
 */
export const HistoryPage = () => {
  const [selectedTimeFrame, setSelectedTimeFrame] = useState<TimeFrame>(
    getDataSessionStorage<DataForSave>(sessionStorageKey.chartHistoryPage)?.selectedTimeFrame ?? TimeFrame['1MINUTE'],
  );
  const [selectedSeries, setSelectedSeries] = useState<keyof SeriesDataItemTypeMap>(
    getDataSessionStorage<DataForSave>(sessionStorageKey.chartHistoryPage)?.selectedSeries ?? 'Candlestick',
  );
  const [selectedCurrency, setSelectedCurrency] = useState<CurrencyType>(
    getDataSessionStorage<DataForSave>(sessionStorageKey.chartHistoryPage)?.selectedCurrency ?? 'tBTCUSD',
  );
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isVolumeVisible, setIsVolumeVisible] = useState<boolean>(
    getDataSessionStorage<DataForSave>(sessionStorageKey.chartHistoryPage)?.isVolumeVisible ?? true,
  );

  const {ref, mainSeries, volumeSeries, legendRef} = useChart({
    backgroundColor: ChartBackgroundColor.DARK,
    autoSize: true,
    gridColor: ChartGridColor.SECONDARY,
    textColor: ChartTextColor.LIGHT,
    borderColor: ChartBorderColor.SECONDARY,
    upColor: ChartSeriesColor.UP,
    downColor: ChartSeriesColor.DOWN,
    typeSeries: selectedSeries,
    hasLegend: true,
    additionalLegendText: `${selectedCurrency} ${selectedTimeFrame}`,
    isVolumeVisible,
    volumeUnit: selectedCurrency.slice(1, -3),
  });

  // Сохраняет настройки независимо от состояния соединения
  useEffect(() => {
    setDataSessionStorage(sessionStorageKey.chartHistoryPage, {
      selectedTimeFrame,
      selectedSeries,
      selectedCurrency,
      isVolumeVisible,
    });
  }, [selectedTimeFrame, selectedSeries, selectedCurrency, isVolumeVisible]);

  useEffect(() => {
    const ws = new WebSocket(url);
    let heartbeatInterval: NodeJS.Timeout;
    let heartbeatTimeout: NodeJS.Timeout;

    setIsLoading(true);

    // Отправка ping
    const sendHeartbeat = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({event: 'ping'}));
      }
    };

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          event: 'subscribe',
          channel: 'candles',
          key: `trade:${selectedTimeFrame}:${selectedCurrency}`,
        }),
      );

      // Устанавливает интервал для heartbeat на 30 секунд
      heartbeatInterval = setInterval(sendHeartbeat, 30000);
    };

    ws.onmessage = (msg) => {
      const response = JSON.parse(msg.data);

      // Если сервер отвечает 'pong', сбрасывает тайм-аут
      if (response.event === 'pong') {
        clearTimeout(heartbeatTimeout);

        heartbeatTimeout = setTimeout(() => {
          // Закрывает соединение, если сервер не отвечает на пинг
          ws.close();
        }, 60000); // Ждет 60 секунд ответа
      }

      /**
       * Проверяет наличие данных свечей, пропуская служебные сообщения и 'hb'
       * @example [160000504, 'hb']
       */
      if (Array.isArray(response) && Array.isArray(response[1])) {
        /**
         * Проверяет является ли ответ массивом массивов или масивом чисел
         * @example [[16000400, 99666, 95444, ...], [16000400, 99666, 95444, ...], [16000400, 99666, 95444, ...]]
         * или [16000400, 99666, 95444, ...]
         */
        if (response[1].length > 0 && !Array.isArray(response[1][0])) {
          const newCandle = getCandleData(response[1]);
          const newVolume = getVolumeData(response[1]);

          // Обновляет цену и объём одной свечи, не накапливая повторно её объём
          if (mainSeries.current && volumeSeries.current) {
            try {
              mainSeries.current.update(newCandle);
              volumeSeries.current.update(newVolume);
            } catch (error) {
              logger.warn('', error);
              return;
            }
          }
        } else {
          const candles: number[][] = response[1].sort((a: number[], b: number[]) => a[0] - b[0]);

          // Устанавливает историю цены и объёма в одинаковом порядке времени
          if (mainSeries.current && volumeSeries.current) {
            mainSeries.current.setData(candles.map(getCandleData));
            volumeSeries.current.setData(candles.map(getVolumeData));
            setIsLoading(false);
          }
        }
      }
    };

    ws.onerror = () => {
      setIsLoading(false);
    };

    ws.onclose = () => {
      clearInterval(heartbeatInterval);
      clearTimeout(heartbeatTimeout);
    };

    return () => {
      // Не допускает обновления нового графика сообщениями от прежней подписки
      ws.onmessage = null;
      ws.onopen = null;
      ws.close();
      clearInterval(heartbeatInterval);
      clearTimeout(heartbeatTimeout);
    };
  }, [selectedTimeFrame, selectedSeries, selectedCurrency, mainSeries, volumeSeries]);

  return (
    <div className={styles.container}>
      <div className={styles.marketAreaGridContainer}>
        <MarketArea selectedCurrency={selectedCurrency} setSelectedCurrency={setSelectedCurrency} />
      </div>

      <div className={styles.chartGridContainer}>
        <div className={styles.chartHeader}>
          <TimeFrames selectedTimeFrame={selectedTimeFrame} setSelectedTimeFrame={setSelectedTimeFrame} />

          <span className={styles.hr} />

          <MenuSeries selectedSeries={selectedSeries} setSelectedSeries={setSelectedSeries} />

          <span className={styles.hr} />

          <Button
            type="button"
            aria-pressed={isVolumeVisible}
            className={classNames(styles.volumeButton, {[styles.selected]: isVolumeVisible})}
            onClick={() => setIsVolumeVisible((value) => !value)}>
            Объём
          </Button>
        </div>

        <div className={styles.chartContainer} ref={ref}>
          <Legend ref={legendRef} className={styles.legend} />
          {isLoading && (
            <span className={styles.loader}>
              <Loader />
            </span>
          )}
        </div>
      </div>

      <TradesFeed key={selectedCurrency} selectedCurrency={selectedCurrency} />
    </div>
  );
};
