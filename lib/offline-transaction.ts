import type { PortfolioState } from '@/lib/portfolio-state-codec';

export type OfflineTransactionOperation =
  | { type: 'upsert'; transactionId: string; transaction: Record<string, unknown> }
  | { type: 'delete'; transactionId: string };

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseOfflineTransactionOperation(value: unknown): OfflineTransactionOperation | null {
  const raw = object(value);
  const operationType = typeof raw?.type === 'string' ? raw.type : '';
  if (!raw || !['upsert', 'delete'].includes(operationType)) return null;
  const transactionId = typeof raw.transactionId === 'string' ? raw.transactionId.trim() : '';
  if (!transactionId || transactionId.length > 160) return null;
  if (operationType === 'delete') return { type: 'delete', transactionId };

  const transaction = object(raw.transaction);
  const storedTransactionId = typeof transaction?.id === 'string' ? transaction.id.trim() : '';
  if (!transaction || storedTransactionId !== transactionId) return null;
  return { type: 'upsert', transactionId, transaction };
}

export function applyOfflineTransactionOperation(
  state: PortfolioState,
  operation: OfflineTransactionOperation,
): { changed: boolean; state: PortfolioState } {
  const transactions = Array.isArray(state.transactions) ? state.transactions : [];
  const index = transactions.findIndex(value => object(value)?.id === operation.transactionId);

  if (operation.type === 'delete') {
    if (index < 0) return { changed: false, state };
    return {
      changed: true,
      state: { ...state, transactions: transactions.filter((_, position) => position !== index) },
    };
  }

  if (index >= 0 && JSON.stringify(transactions[index]) === JSON.stringify(operation.transaction)) {
    return { changed: false, state };
  }
  const nextTransactions = [...transactions];
  if (index >= 0) nextTransactions[index] = operation.transaction;
  else nextTransactions.push(operation.transaction);
  return { changed: true, state: { ...state, transactions: nextTransactions } };
}
