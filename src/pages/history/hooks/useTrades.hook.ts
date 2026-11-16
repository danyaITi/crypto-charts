import {useEffect, useState} from 'react';
import {Trade, TradesStatus} from '@pages/history/models';
import {getTradeData, mergeTrades} from '@pages/history/utils';

const url = 'wss://api-pub.bitfinex.com/ws/2';

/**
 * Подписывает ленту на сделки выбранной пары независимо от таймфрейма графика
 */
export const useTrades = (selectedCurrency: CurrencyType) => {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [status, setStatus] = useState<TradesStatus>('connecting');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let ws: WebSocket;
    let isDisposed = false;
    let retryAttempt = 0;
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    let activityTimeout: ReturnType<typeof setTimeout>;

    setTrades([]);
    setStatus('connecting');

    const connect = () => {
      const socket = new WebSocket(url);
      let channelId: number | null = null;
      let hasSubscriptionError = false;
      ws = socket;

      // Сервер присылает heartbeat даже без сделок; отсутствие сообщений означает потерю связи
      const resetActivityTimeout = () => {
        clearTimeout(activityTimeout);
        activityTimeout = setTimeout(() => socket.close(), 45000);
      };

      resetActivityTimeout();

      socket.onopen = () => {
        socket.send(JSON.stringify({event: 'subscribe', channel: 'trades', symbol: selectedCurrency}));
      };

      socket.onmessage = (event) => {
        if (isDisposed || ws !== socket) {
          return;
        }

        resetActivityTimeout();

        let response: unknown;

        try {
          response = JSON.parse(event.data);
        } catch {
          return;
        }

        if (typeof response === 'object' && response !== null && !Array.isArray(response)) {
          const message = response as Record<string, unknown>;

          if (
            message.event === 'subscribed' &&
            message.channel === 'trades' &&
            message.symbol === selectedCurrency &&
            typeof message.chanId === 'number'
          ) {
            channelId = message.chanId;
            retryAttempt = 0;
            setStatus('live');
          } else if (message.event === 'error') {
            hasSubscriptionError = true;
            setStatus('error');
            socket.close();
          } else if (message.event === 'info' && [20051, 20060, 20061].includes(Number(message.code))) {
            // После перезапуска или обслуживания биржи создаёт новую подписку
            socket.close();
          }

          return;
        }

        if (!Array.isArray(response) || channelId === null || response[0] !== channelId) {
          return;
        }

        if (Array.isArray(response[1])) {
          const snapshot = response[1].map(getTradeData).filter((trade): trade is Trade => trade !== null);
          setTrades((current) => mergeTrades(current, snapshot));
        } else if (response[1] === 'te' || response[1] === 'tu') {
          const trade = getTradeData(response[2]);

          if (trade) {
            setTrades((current) => mergeTrades(current, [trade]));
          }
        }
      };

      socket.onerror = () => socket.close();

      socket.onclose = () => {
        clearTimeout(activityTimeout);

        if (isDisposed || hasSubscriptionError) {
          return;
        }

        setStatus('reconnecting');

        // Постепенно увеличивает задержку повторного подключения до 30 секунд
        const delay = Math.min(1000 * 2 ** retryAttempt, 30000);
        retryAttempt += 1;
        reconnectTimeout = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      isDisposed = true;
      clearTimeout(reconnectTimeout);
      clearTimeout(activityTimeout);
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    };
  }, [selectedCurrency, retryKey]);

  return {trades, status, retry: () => setRetryKey((value) => value + 1)};
};
