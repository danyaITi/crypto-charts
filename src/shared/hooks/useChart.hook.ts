import {createChart, ISeriesApi, SeriesDataItemTypeMap, UTCTimestamp} from 'lightweight-charts';
import {MutableRefObject, useEffect, useRef} from 'react';
import {
  ChartBackgroundColor,
  ChartBorderColor,
  ChartGridColor,
  ChartSeriesColor,
  ChartTextColor,
} from '@shared/models/enums';
import {isOhlcData} from '@shared/utils/type_guards';

type State = {
  ref: MutableRefObject<HTMLDivElement | null>;
  mainSeries: MutableRefObject<ISeriesApi<keyof SeriesDataItemTypeMap> | null>;
  volumeSeries: MutableRefObject<ISeriesApi<'Histogram'> | null>;
  legendRef: MutableRefObject<HTMLDivElement | null>;
};

type Props = {
  backgroundColor: ChartBackgroundColor;
  textColor: ChartTextColor;
  autoSize: boolean;
  gridColor: ChartGridColor;
  borderColor: ChartBorderColor;
  upColor: ChartSeriesColor;
  downColor: ChartSeriesColor;
  hasLegend: boolean;
  additionalLegendText?: string;
  isVolumeVisible?: boolean;
  volumeUnit?: string;
  typeSeries?: keyof SeriesDataItemTypeMap;
};

/**
 * Хук для получения графика
 *
 * @param backgroundColor {ChartBackgroundColor} - цвет фона графика
 * @param textColor {ChartTextColor} - цвет текста графика
 * @param autoSize {boolean} - растягивает график на всю площадь контейнера
 * @param gridColor {ChartGridColor} - цвет сетки графика
 * @param borderColor {ChartBackgroundColor} - цвет границ графика
 * @param downColor {ChartBackgroundColor} - цвет снижения графика
 * @param upColor {ChartBackgroundColor} - цвет повышения графика
 * @param hasLegend {boolean} - показывать ли текст обозначение на графике
 * @param [additionalLegendText] {string} - дополнительный текст в legend
 * @param [typeSeries] {ChartAvailableTypes} - тип графика
 * @param [isVolumeVisible] {boolean} - показывать ли объём торгов
 * @param [volumeUnit] {string} - валюта измерения объёма торгов
 * 
 * @example {
    backgroundColor: #000,
    autoSize: true,
    gridColor: #fef,
    textColor: #fff,
    typeSeries: 'Candlestick'
    ...,
  }
 */
export const useChart = ({
  backgroundColor,
  textColor,
  autoSize,
  gridColor,
  borderColor,
  downColor,
  upColor,
  typeSeries = 'Candlestick',
  hasLegend,
  additionalLegendText,
  isVolumeVisible = false,
  volumeUnit = '',
}: Props): State => {
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);
  const mainSeries = useRef<ISeriesApi<keyof SeriesDataItemTypeMap> | null>(null);
  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);

  useEffect(() => {
    const handleResize = () => {
      chart.applyOptions({width: chartContainerRef.current?.clientWidth});
    };

    const chart = createChart(chartContainerRef.current as HTMLElement, {
      layout: {
        background: {color: backgroundColor},
        textColor,
        attributionLogo: false,
      },
      grid: {
        vertLines: {color: gridColor},
        horzLines: {color: gridColor},
      },
      autoSize,
    });
    chart.timeScale().scrollToPosition(5, true);
    chart.timeScale().fitContent();

    const currentLocale = window.navigator.languages[0];

    const myPriceFormatter = Intl.NumberFormat(currentLocale, {
      style: 'currency',
      currency: 'USD',
    }).format;

    chart.applyOptions({
      localization: {
        priceFormatter: myPriceFormatter,
        timeFormatter: (businessDayOrTimestamp: UTCTimestamp) => {
          const date = new Date(businessDayOrTimestamp * 1000);

          const options: Intl.DateTimeFormatOptions = {
            day: '2-digit',
            month: 'short',
            year: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          };

          return new Intl.DateTimeFormat(navigator.language, options).format(date);
        },
      },
    });

    chart.timeScale().applyOptions({
      borderColor,
    });

    let series: ISeriesApi<keyof SeriesDataItemTypeMap> | null = null;

    if (typeSeries === 'Candlestick') {
      series = chart.addCandlestickSeries({
        upColor: upColor,
        downColor: downColor,
        borderVisible: false,
        wickUpColor: upColor,
        wickDownColor: downColor,
      });
    } else if (typeSeries === 'Bar') {
      series = chart.addBarSeries({
        upColor: upColor,
        downColor: downColor,
      });
    }

    mainSeries.current = series;

    // Объём использует общую шкалу времени и отдельную шкалу значений
    const volume = chart.addHistogramSeries({
      priceScaleId: 'volume',
      priceFormat: {type: 'volume'},
      priceLineVisible: false,
      lastValueVisible: false,
    });

    volume.priceScale().applyOptions({
      scaleMargins: {top: 0.8, bottom: 0},
    });
    volumeSeries.current = volume;

    const volumeFormatter = Intl.NumberFormat(currentLocale, {maximumFractionDigits: 8});

    // Сбрасывает легенду при смене валюты, таймфрейма или типа графика
    legendRef.current?.replaceChildren();

    // Текст обозначение при наведении на график
    if (hasLegend) {
      chart.subscribeCrosshairMove((param) => {
        let priceOpen = '';
        let priceMax = '';
        let priceMin = '';
        let priceClose = '';

        if (!param.point) {
          return;
        }

        if (param.time && series) {
          const data = param.seriesData.get(series);
          const volumeData = param.seriesData.get(volume);

          if (legendRef.current && isOhlcData(data)) {
            const isGreen = data?.close > data.open;

            priceOpen = data.open.toFixed(2);
            priceMax = data.high.toFixed(2);
            priceMin = data.low.toFixed(2);
            priceClose = data.close.toFixed(2);

            const volumeLegend =
              volumeData && 'value' in volumeData
                ? `<div data-volume ${volume.options().visible ? '' : 'hidden'}><span>ОБЪЁМ</span> <span>${volumeFormatter.format(volumeData.value)} ${volumeUnit}</span></div>`
                : '';

            legendRef.current.style.color = isGreen ? upColor : downColor;

            legendRef.current.innerHTML = `
            <div><span id='legend'>${additionalLegendText}</span></div>
            <div><span id='legend'>ОТКР</span> <span>${priceOpen}</span></div>
            <div><span id='legend'>МАКС</span> <span>${priceMax}</span></div>
            <div><span id='legend'>МИН</span> <span>${priceMin}</span></div>
            <div><span id='legend'>ЗАКР</span> <span>${priceClose}</span></div>
            ${volumeLegend}
          `;
          }
        }
      });
    }

    window.addEventListener('resize', handleResize);

    return () => {
      chart.remove();
      mainSeries.current = null;
      volumeSeries.current = null;

      window.removeEventListener('resize', handleResize);
    };
  }, [
    backgroundColor,
    textColor,
    autoSize,
    gridColor,
    borderColor,
    downColor,
    upColor,
    typeSeries,
    hasLegend,
    additionalLegendText,
    volumeUnit,
  ]);

  // Переключает объём без пересоздания графика и потери загруженных данных
  useEffect(() => {
    volumeSeries.current?.applyOptions({visible: isVolumeVisible});
    mainSeries.current?.priceScale().applyOptions({
      scaleMargins: {top: 0.1, bottom: isVolumeVisible ? 0.25 : 0.1},
    });

    const volumeLegend = legendRef.current?.querySelector<HTMLElement>('[data-volume]');

    if (volumeLegend) {
      volumeLegend.hidden = !isVolumeVisible;
    }
  }, [
    isVolumeVisible,
    backgroundColor,
    textColor,
    autoSize,
    gridColor,
    borderColor,
    downColor,
    upColor,
    typeSeries,
    hasLegend,
    additionalLegendText,
    volumeUnit,
  ]);

  return {
    ref: chartContainerRef,
    mainSeries,
    volumeSeries,
    legendRef,
  };
};
