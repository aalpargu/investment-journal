import type { PortfolioState } from './portfolio-state-codec';

// Invented transactions only. This factory never reads a personal portfolio.
export function createDemoState(now = new Date()): PortfolioState {
  const date = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  return {
    schemaVersion: 5,
    settings: { baseCurrency: 'TRY', fxUsdTry: 38.5, refreshInterval: 30000, includeCash: false, theme: 'dark' },
    isDemo: false, onboardingCompleted: true,
    transactions: [
      { id: 'example_tx_001', type: 'DEPOSIT', date: date(-90), market: 'NAKİT', currency: 'TRY', symbol: '', name: 'Örnek TL yatırma', quantity: 1, price: 40000, fee: 0 },
      { id: 'example_tx_002', type: 'BUY', date: date(-88), market: 'BIST', currency: 'TRY', symbol: 'THYAO.IS', name: 'Türk Hava Yolları', quantity: 25, price: 280, fee: 5 },
      { id: 'example_tx_003', type: 'BUY', date: date(-70), market: 'BIST', currency: 'TRY', symbol: 'ASELS.IS', name: 'Aselsan', quantity: 40, price: 120, fee: 5 },
      { id: 'example_tx_004', type: 'DEPOSIT', date: date(-60), market: 'NAKİT', currency: 'USD', symbol: '', name: 'Örnek USD yatırma', quantity: 1, price: 2000, fee: 0 },
      { id: 'example_tx_005', type: 'BUY', date: date(-55), market: 'ABD', currency: 'USD', symbol: 'AAPL', name: 'Apple', quantity: 3, price: 205, fee: 1 },
      { id: 'example_tx_006', type: 'BUY', date: date(-45), market: 'ABD', currency: 'USD', symbol: 'MSFT', name: 'Microsoft', quantity: 2, price: 410, fee: 1 },
      { id: 'example_tx_007', type: 'SELL', date: date(-10), market: 'ABD', currency: 'USD', symbol: 'AAPL', name: 'Apple', quantity: 1, price: 220, fee: 1 },
      { id: 'example_tx_008', type: 'BUY', date: date(-40), market: 'BIST', currency: 'TRY', symbol: 'TUPRS.IS', name: 'Tüpraş', quantity: 10, price: 145, fee: 3 },
      { id: 'example_tx_009', type: 'SELL', date: date(-5), market: 'BIST', currency: 'TRY', symbol: 'TUPRS.IS', name: 'Tüpraş', quantity: 10, price: 157, fee: 3 },
    ],
    watchlist: [{ id: 'example_watch_001', symbol: 'NVDA', name: 'NVIDIA', market: 'ABD', currency: 'USD', targetPrice: 150 }],
    closedPositions: [],
    journal: [{ id: 'example_journal_001', date: date(-7), title: 'Örnek yatırım günlüğü', body: 'Bu kayıtlar uygulamayı incelemek için oluşturuldu. İşlem ekleyebilir, kayıtları düzenleyebilir ve yedek alabilirsin.' }],
    expenses: [], calendarEvents: [], stockTheses: [],
    investmentBudget: { monthlyIncome: 30000, expectedCardPayment: 3500, fixedObligations: 10000, cashBalance: 60000, bufferMonths: 3, safetyMarginPct: 10, updatedAt: now.getTime() },
    dailySnapshots: [], history: [], technicalAlerts: [], quarantinedTransactions: [],
  };
}
