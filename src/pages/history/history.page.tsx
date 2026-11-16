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
import {classNames, getDataSessionStorage, sessionStorageKey, setDataSessionStorage} from '@shared/utils';
import {useCandleHistory} from '@pages/history/hooks';

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
  const [isVolumeVisible, setIsVolumeVisible] = useState<boolean>(
    getDataSessionStorage<DataForSave>(sessionStorageKey.chartHistoryPage)?.isVolumeVisible ?? true,
  );

  const {ref, chartRef, mainSeries, volumeSeries, legendRef} = useChart({
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

  const {isLoading, isHistoryLoading, hasHistoryError, hasMoreHistory, retryHistory} = useCandleHistory({
    selectedCurrency,
    selectedTimeFrame,
    selectedSeries,
    chartRef,
    mainSeries,
    volumeSeries,
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

          {(isHistoryLoading || hasHistoryError || !hasMoreHistory) && (
            <span className={styles.historyStatus} role="status">
              {isHistoryLoading && 'Загружаем историю…'}
              {hasHistoryError && (
                <>
                  Не удалось загрузить историю.
                  <Button type="button" className={styles.volumeButton} onClick={retryHistory}>
                    Повторить
                  </Button>
                </>
              )}
              {!hasMoreHistory && 'Вся доступная история загружена'}
            </span>
          )}
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
