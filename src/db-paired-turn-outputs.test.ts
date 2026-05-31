import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'vitest';

import { applyBaseSchema } from './db/base-schema.js';
import {
  getPairedTurnOutputsFromDatabase,
  insertPairedTurnOutputInDatabase,
} from './db/paired-turn-outputs.js';

describe('paired turn output attachments', () => {
  it('preserves attachments for reviewer evidence prompts', () => {
    const database = new Database(':memory:');
    try {
      applyBaseSchema(database);

      insertPairedTurnOutputInDatabase(
        database,
        'paired-task-turn-output-attachments',
        1,
        'owner',
        'TASK_DONE\n새 스크린샷 첨부',
        {
          attachments: [
            {
              path: '/tmp/settings-v0.1.92-deployed-390.png',
              name: 'settings-v0.1.92-deployed-390.png',
              mime: 'image/png',
            },
          ],
        },
      );

      const outputs = getPairedTurnOutputsFromDatabase(
        database,
        'paired-task-turn-output-attachments',
      );

      expect(outputs[0].attachments).toEqual([
        {
          path: '/tmp/settings-v0.1.92-deployed-390.png',
          name: 'settings-v0.1.92-deployed-390.png',
          mime: 'image/png',
        },
      ]);
    } finally {
      database.close();
    }
  });
});
