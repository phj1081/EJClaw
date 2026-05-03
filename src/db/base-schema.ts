import { Database } from 'bun:sqlite';

const ROOM_SKILL_OVERRIDES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS room_skill_overrides (
    chat_jid TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    skill_scope TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chat_jid, agent_type, skill_scope, skill_name),
    FOREIGN KEY (chat_jid) REFERENCES room_settings(chat_jid) ON DELETE CASCADE,
    CHECK (agent_type IN ('claude-code', 'codex')),
    CHECK (enabled IN (0, 1)),
    CHECK (length(skill_scope) > 0),
    CHECK (length(skill_name) > 0)
  );
  CREATE INDEX IF NOT EXISTS idx_room_skill_overrides_room
    ON room_skill_overrides(chat_jid, agent_type);
`;

export function applyBaseSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      seq INTEGER,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      message_source_kind TEXT NOT NULL DEFAULT 'human',
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_jid, timestamp DESC);
    CREATE TABLE IF NOT EXISTS message_sequence (
      id INTEGER PRIMARY KEY AUTOINCREMENT
    );

    CREATE TABLE IF NOT EXISTS work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      service_id TEXT,
      delivery_role TEXT,
      status TEXT NOT NULL DEFAULT 'produced',
      start_seq INTEGER,
      end_seq INTEGER,
      result_payload TEXT NOT NULL,
      attachment_payload TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      delivery_message_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT,
      CHECK (status IN ('produced', 'delivery_retry', 'delivered')),
      CHECK (delivery_role IN ('owner', 'reviewer', 'arbiter') OR delivery_role IS NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_work_items_group_agent ON work_items(chat_jid, agent_type, delivery_role, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_open
      ON work_items(chat_jid, agent_type, IFNULL(delivery_role, ''))
      WHERE status IN ('produced', 'delivery_retry');

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      agent_type TEXT,
      ci_provider TEXT,
      ci_metadata TEXT,
      max_duration_ms INTEGER,
      status_message_id TEXT,
      status_started_at TEXT,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'claude-code',
      session_id TEXT NOT NULL,
      PRIMARY KEY (group_folder, agent_type)
    );
    CREATE TABLE IF NOT EXISTS paired_projects (
      chat_jid TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      canonical_work_dir TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paired_tasks (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      owner_service_id TEXT NOT NULL,
      reviewer_service_id TEXT NOT NULL,
      owner_agent_type TEXT,
      reviewer_agent_type TEXT,
      arbiter_agent_type TEXT,
      title TEXT,
      source_ref TEXT,
      plan_notes TEXT,
      review_requested_at TEXT,
      round_trip_count INTEGER NOT NULL DEFAULT 0,
      owner_failure_count INTEGER NOT NULL DEFAULT 0,
      owner_step_done_streak INTEGER NOT NULL DEFAULT 0,
      finalize_step_done_count INTEGER NOT NULL DEFAULT 0,
      task_done_then_user_reopen_count INTEGER NOT NULL DEFAULT 0,
      empty_step_done_streak INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      arbiter_verdict TEXT,
      arbiter_requested_at TEXT,
      completion_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (status IN ('active', 'review_ready', 'in_review', 'merge_ready', 'completed', 'arbiter_requested', 'in_arbitration')),
      CHECK (owner_agent_type IN ('claude-code', 'codex') OR owner_agent_type IS NULL),
      CHECK (reviewer_agent_type IN ('claude-code', 'codex') OR reviewer_agent_type IS NULL),
      CHECK (arbiter_agent_type IN ('claude-code', 'codex') OR arbiter_agent_type IS NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_paired_tasks_chat_status
      ON paired_tasks(chat_jid, status, updated_at);
    CREATE TABLE IF NOT EXISTS paired_workspaces (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      role TEXT NOT NULL,
      workspace_dir TEXT NOT NULL,
      snapshot_source_dir TEXT,
      snapshot_ref TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      snapshot_refreshed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (role IN ('owner', 'reviewer')),
      CHECK (status IN ('ready', 'stale'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_paired_workspaces_task_role
      ON paired_workspaces(task_id, role);
    CREATE TABLE IF NOT EXISTS paired_turn_outputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      output_text TEXT NOT NULL,
      verdict TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, turn_number, role)
    );
    CREATE INDEX IF NOT EXISTS idx_paired_turn_outputs_task
      ON paired_turn_outputs(task_id, turn_number);
    CREATE TABLE IF NOT EXISTS paired_turn_reservations (
      chat_jid TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_status TEXT NOT NULL,
      round_trip_count INTEGER NOT NULL DEFAULT 0,
      task_updated_at TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      turn_attempt_id TEXT,
      turn_attempt_no INTEGER,
      turn_role TEXT NOT NULL,
      intent_kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      scheduled_run_id TEXT,
      consumed_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      consumed_at TEXT,
      PRIMARY KEY (chat_jid, task_id, task_updated_at, intent_kind),
      FOREIGN KEY (turn_id, turn_attempt_no)
        REFERENCES paired_turn_attempts(turn_id, attempt_no)
        ON DELETE CASCADE,
      CHECK (status IN ('pending', 'completed')),
      CHECK (turn_role IN ('owner', 'reviewer', 'arbiter')),
      CHECK (
        intent_kind IN (
          'owner-turn',
          'reviewer-turn',
          'arbiter-turn',
          'owner-follow-up',
          'finalize-owner-turn'
        )
      )
    );
    CREATE INDEX IF NOT EXISTS idx_paired_turn_reservations_task
      ON paired_turn_reservations(task_id, task_updated_at, status);
    CREATE TABLE IF NOT EXISTS paired_turns (
      turn_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_updated_at TEXT NOT NULL,
      role TEXT NOT NULL,
      intent_kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (role IN ('owner', 'reviewer', 'arbiter')),
      CHECK (
        intent_kind IN (
          'owner-turn',
          'reviewer-turn',
          'arbiter-turn',
          'owner-follow-up',
          'finalize-owner-turn'
        )
      )
    );
    CREATE INDEX IF NOT EXISTS idx_paired_turns_task
      ON paired_turns(task_id, task_updated_at, updated_at);
    CREATE TABLE IF NOT EXISTS paired_turn_attempts (
      attempt_id TEXT NOT NULL PRIMARY KEY,
      parent_attempt_id TEXT,
      parent_handoff_id INTEGER,
      continuation_handoff_id INTEGER,
      turn_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      task_updated_at TEXT NOT NULL,
      role TEXT NOT NULL,
      intent_kind TEXT NOT NULL,
      state TEXT NOT NULL,
      executor_service_id TEXT,
      executor_agent_type TEXT,
      active_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      last_error TEXT,
      UNIQUE (turn_id, attempt_no),
      FOREIGN KEY (parent_attempt_id)
        REFERENCES paired_turn_attempts(attempt_id)
        ON DELETE CASCADE,
      FOREIGN KEY (parent_handoff_id)
        REFERENCES service_handoffs(id)
        ON DELETE SET NULL,
      FOREIGN KEY (continuation_handoff_id)
        REFERENCES service_handoffs(id)
        ON DELETE SET NULL,
      FOREIGN KEY (turn_id) REFERENCES paired_turns(turn_id) ON DELETE CASCADE,
      CHECK (role IN ('owner', 'reviewer', 'arbiter')),
      CHECK (
        intent_kind IN (
          'owner-turn',
          'reviewer-turn',
          'arbiter-turn',
          'owner-follow-up',
          'finalize-owner-turn'
        )
      ),
      CHECK (
        state IN (
          'running',
          'delegated',
          'completed',
          'failed',
          'cancelled'
        )
      ),
      CHECK (executor_agent_type IN ('claude-code', 'codex') OR executor_agent_type IS NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_paired_turn_attempts_turn
      ON paired_turn_attempts(turn_id, attempt_no);
    CREATE INDEX IF NOT EXISTS idx_paired_turn_attempts_task
      ON paired_turn_attempts(task_id, task_updated_at, attempt_no);
    CREATE TABLE IF NOT EXISTS paired_task_execution_leases (
      task_id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      role TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      turn_attempt_id TEXT,
      turn_attempt_no INTEGER,
      intent_kind TEXT NOT NULL,
      claimed_run_id TEXT NOT NULL,
      claimed_service_id TEXT NOT NULL,
      task_status TEXT NOT NULL,
      task_updated_at TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (turn_id, turn_attempt_no)
        REFERENCES paired_turn_attempts(turn_id, attempt_no)
        ON DELETE CASCADE,
      CHECK (role IN ('owner', 'reviewer', 'arbiter')),
      CHECK (
        intent_kind IN (
          'owner-turn',
          'reviewer-turn',
          'arbiter-turn',
          'owner-follow-up',
          'finalize-owner-turn'
        )
      )
    );
    CREATE INDEX IF NOT EXISTS idx_paired_task_execution_leases_expires_at
      ON paired_task_execution_leases(expires_at);
    CREATE TABLE IF NOT EXISTS channel_owner (
      chat_jid TEXT PRIMARY KEY,
      owner_service_id TEXT NOT NULL,
      reviewer_service_id TEXT,
      arbiter_service_id TEXT,
      owner_agent_type TEXT,
      reviewer_agent_type TEXT,
      arbiter_agent_type TEXT,
      activated_at TEXT,
      reason TEXT,
      CHECK (owner_agent_type IN ('claude-code', 'codex') OR owner_agent_type IS NULL),
      CHECK (reviewer_agent_type IN ('claude-code', 'codex') OR reviewer_agent_type IS NULL),
      CHECK (arbiter_agent_type IN ('claude-code', 'codex') OR arbiter_agent_type IS NULL)
    );
    CREATE TABLE IF NOT EXISTS room_settings (
      chat_jid TEXT PRIMARY KEY,
      room_mode TEXT NOT NULL,
      mode_source TEXT NOT NULL DEFAULT 'explicit',
      name TEXT,
      folder TEXT,
      trigger_pattern TEXT,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0,
      owner_agent_type TEXT,
      work_dir TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL,
      CHECK (room_mode IN ('single', 'tribunal')),
      CHECK (owner_agent_type IN ('claude-code', 'codex') OR owner_agent_type IS NULL)
    );
    CREATE TABLE IF NOT EXISTS room_role_overrides (
      chat_jid TEXT NOT NULL,
      role TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      agent_config_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chat_jid, role),
      CHECK (role IN ('owner', 'reviewer', 'arbiter')),
      CHECK (agent_type IN ('claude-code', 'codex'))
    );
    CREATE TABLE IF NOT EXISTS service_handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      source_service_id TEXT NOT NULL,
      target_service_id TEXT NOT NULL,
      paired_task_id TEXT,
      paired_task_updated_at TEXT,
      turn_id TEXT,
      turn_attempt_id TEXT,
      turn_attempt_no INTEGER,
      turn_intent_kind TEXT,
      turn_role TEXT,
      source_role TEXT,
      source_agent_type TEXT,
      target_role TEXT,
      target_agent_type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      start_seq INTEGER,
      end_seq INTEGER,
      reason TEXT,
      intended_role TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_at TEXT,
      completed_at TEXT,
      last_error TEXT,
      FOREIGN KEY (turn_id, turn_attempt_no)
        REFERENCES paired_turn_attempts(turn_id, attempt_no)
        ON DELETE CASCADE,
      CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
      CHECK (intended_role IN ('owner', 'reviewer', 'arbiter') OR intended_role IS NULL),
      CHECK (
        turn_intent_kind IN (
          'owner-turn',
          'reviewer-turn',
          'arbiter-turn',
          'owner-follow-up',
          'finalize-owner-turn'
        ) OR turn_intent_kind IS NULL
      ),
      CHECK (turn_role IN ('owner', 'reviewer', 'arbiter') OR turn_role IS NULL),
      CHECK (source_role IN ('owner', 'reviewer', 'arbiter') OR source_role IS NULL),
      CHECK (target_role IN ('owner', 'reviewer', 'arbiter') OR target_role IS NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_service_handoffs_target
      ON service_handoffs(status, target_role, target_agent_type, created_at);
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY,
      scope_kind TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      content TEXT NOT NULL,
      keywords_json TEXT NOT NULL DEFAULT '[]',
      memory_kind TEXT,
      source_kind TEXT NOT NULL,
      source_ref TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      archived_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope_kind, scope_key);
    CREATE INDEX IF NOT EXISTS idx_memories_active
      ON memories(scope_kind, scope_key, archived_at, created_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      keywords,
      content='',
      tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, keywords)
      VALUES (new.id, new.content, new.keywords_json);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
      VALUES ('delete', old.id, old.content, old.keywords_json);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
      VALUES ('delete', old.id, old.content, old.keywords_json);
      INSERT INTO memories_fts(rowid, content, keywords)
      VALUES (new.id, new.content, new.keywords_json);
    END;
  `);
  database.exec(ROOM_SKILL_OVERRIDES_SCHEMA);
}
