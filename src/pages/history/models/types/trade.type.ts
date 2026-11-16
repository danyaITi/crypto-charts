export type Trade = {
  id: number;
  timestamp: number;
  amount: number;
  price: number;
  side: 'buy' | 'sell';
};

export type TradesStatus = 'connecting' | 'live' | 'reconnecting' | 'error';
