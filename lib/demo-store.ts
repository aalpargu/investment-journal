import { getCloudStore } from './cloud-store';
import { createDemoState } from './demo-state';
export async function ensureDemoState(userId: string): Promise<void> {
  const db = await getCloudStore();
  // Concurrent first visits cannot overwrite an existing or edited portfolio.
  await db.prepare(`INSERT OR IGNORE INTO portfolio_states
    (user_id, revision, state_json, updated_at) VALUES (?, 1, ?, ?)`)
    .bind(userId, JSON.stringify(createDemoState()), new Date().toISOString()).run();
}
