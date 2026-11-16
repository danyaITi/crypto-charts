import {useMemo} from 'react';
import {Button} from '@shared/components';
import {classNames} from '@shared/utils';
import {useTrades} from '@pages/history/hooks';
import {TradesStatus} from '@pages/history/models';
import styles from './styles.module.scss';

const STATUS_LABELS: Record<TradesStatus, string> = {
  connecting: 'Подключение…',
  live: 'Онлайн',
  reconnecting: 'Переподключение…',
  error: 'Ошибка подключения',
};

type Props = {
  selectedCurrency: CurrencyType;
};

/**
 * Лента последних сделок: новые сверху, объём в базовой валюте, время местное
 */
export const TradesFeed = ({selectedCurrency}: Props) => {
  const {trades, status, retry} = useTrades(selectedCurrency);
  const currency = selectedCurrency.slice(1, -3);
  const formatters = useMemo(
    () => ({
      price: new Intl.NumberFormat(navigator.language, {minimumFractionDigits: 2, maximumFractionDigits: 2}),
      amount: new Intl.NumberFormat(navigator.language, {maximumFractionDigits: 8}),
      time: new Intl.DateTimeFormat(navigator.language, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }),
      date: new Intl.DateTimeFormat(navigator.language, {dateStyle: 'short', timeStyle: 'medium'}),
    }),
    [],
  );

  return (
    <aside className={styles.panel} aria-label="Последние сделки">
      <div className={styles.header}>
        <h2 className={styles.title}>Последние сделки</h2>
        <span className={styles.pair}>Bitfinex · {currency}/USD</span>
        <span role="status" className={classNames(styles.status, {[styles.live]: status === 'live'})}>
          {STATUS_LABELS[status]}
        </span>
      </div>

      <div className={styles.tableContainer} tabIndex={0} role="region" aria-label="Список последних сделок">
        <table className={styles.table} aria-label={`Сделки ${currency}/USD`}>
          <thead>
            <tr>
              <th scope="col">Цена, USD</th>
              <th scope="col">Объём, {currency}</th>
              <th scope="col">Сторона</th>
              <th scope="col">Время</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade) => (
              <tr key={trade.id}>
                <td className={styles[trade.side]} title={formatters.price.format(trade.price)}>
                  {formatters.price.format(trade.price)}
                </td>
                <td title={formatters.amount.format(trade.amount)}>{formatters.amount.format(trade.amount)}</td>
                <td className={styles[trade.side]}>{trade.side === 'buy' ? 'Покупка' : 'Продажа'}</td>
                <td>
                  <time
                    dateTime={new Date(trade.timestamp).toISOString()}
                    title={formatters.date.format(trade.timestamp)}>
                    {formatters.time.format(trade.timestamp)}
                  </time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {trades.length === 0 && (
          <p className={styles.empty}>
            {status === 'live' ? 'Сделок пока нет. Ожидаем новые…' : 'Ожидаем данные о сделках…'}
          </p>
        )}
      </div>

      {status === 'error' && (
        <div className={styles.error}>
          <p>Не удалось подписаться на сделки.</p>
          <Button type="button" className={styles.retryButton} onClick={retry}>
            Повторить
          </Button>
        </div>
      )}

      <p className={styles.footer}>Новые сделки сверху · время местное</p>
    </aside>
  );
};
