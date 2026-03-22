/**
 * Data Unification Migration Script
 * Merges codex data into the primary (claude) directories.
 * 
 * Run AFTER stopping both services.
 */
const Database = require('/home/clone-ej/EJClaw/node_modules/better-sqlite3');
const fs = require('fs');
const path = require('path');

const BASE = '/home/clone-ej/EJClaw';
const CLAUDE_DB = path.join(BASE, 'store/messages.db');
const CODEX_DB = path.join(BASE, 'store-codex/messages.db');

console.log('=== EJClaw Data Unification ===\n');

// 1. Open both DBs
const primary = new Database(CLAUDE_DB);
const codex = new Database(CODEX_DB);

primary.pragma('journal_mode = WAL');
primary.pragma('busy_timeout = 5000');

// 2. Merge registered_groups (codex → primary, skip JID conflicts)
console.log('--- Merging registered_groups ---');
const codexGroups = codex.prepare('SELECT * FROM registered_groups').all();
const insertGroup = primary.prepare(`
  INSERT OR IGNORE INTO registered_groups 
  (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, agent_type, work_dir)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let groupsAdded = 0;
let groupsSkipped = 0;
for (const g of codexGroups) {
  // Check if JID already exists with different agent_type
  const existing = primary.prepare('SELECT agent_type FROM registered_groups WHERE jid = ?').get(g.jid);
  if (existing) {
    // Same JID, different bots — both need to be registered
    // Since JID is PK, we can't have duplicates. The group with claude-code type stays,
    // and the codex one is already differentiated by agent_type in the same row.
    // But wait — in the unified DB, the same JID can only appear once.
    // For shared channels (both bots respond), we keep the claude registration
    // and the codex service will also load it IF we adjust the filter.
    // Actually, the codex service filters by agent_type='codex', so it won't see claude-code groups.
    // We need BOTH registrations for shared channels.
    // Solution: codex groups with different folder names get inserted.
    // Same JID + same folder = skip (duplicate)
    // Same JID + different folder = need a unique folder for codex
    if (existing.agent_type !== g.agent_type) {
      // Same JID but different agent types — need both
      // Change JID to make it unique: append agent type suffix
      const codexJid = g.jid + ':codex';
      const existsCodex = primary.prepare('SELECT 1 FROM registered_groups WHERE jid = ?').get(codexJid);
      if (!existsCodex) {
        insertGroup.run(codexJid, g.name, g.folder, g.trigger_pattern, g.added_at, 
          g.container_config, g.requires_trigger, g.is_main, g.agent_type, g.work_dir);
        groupsAdded++;
        console.log(`  + ${g.folder} (codex, jid=${codexJid})`);
      } else {
        groupsSkipped++;
      }
    } else {
      groupsSkipped++;
    }
  } else {
    insertGroup.run(g.jid, g.name, g.folder, g.trigger_pattern, g.added_at,
      g.container_config, g.requires_trigger, g.is_main, g.agent_type, g.work_dir);
    groupsAdded++;
    console.log(`  + ${g.folder} (${g.agent_type})`);
  }
}
console.log(`  Added: ${groupsAdded}, Skipped: ${groupsSkipped}\n`);

// 3. Merge sessions (codex → primary, agent_type='codex')
console.log('--- Merging sessions ---');
const codexSessions = codex.prepare('SELECT * FROM sessions').all();
const insertSession = primary.prepare(
  'INSERT OR IGNORE INTO sessions (group_folder, agent_type, session_id) VALUES (?, ?, ?)'
);
let sessionsAdded = 0;
for (const s of codexSessions) {
  insertSession.run(s.group_folder, s.agent_type, s.session_id);
  sessionsAdded++;
  console.log(`  + ${s.group_folder} [${s.agent_type}]`);
}
console.log(`  Added: ${sessionsAdded}\n`);

// 4. Merge router_state (codex → primary, already prefixed)
console.log('--- Merging router_state ---');
const codexState = codex.prepare('SELECT * FROM router_state').all();
const insertState = primary.prepare(
  'INSERT OR IGNORE INTO router_state (key, value) VALUES (?, ?)'
);
for (const s of codexState) {
  insertState.run(s.key, s.value);
  console.log(`  + ${s.key}`);
}
console.log('');

// 5. Merge messages (codex → primary, skip duplicates by PK)
console.log('--- Merging messages ---');
const codexMsgs = codex.prepare('SELECT * FROM messages').all();
const insertMsg = primary.prepare(`
  INSERT OR IGNORE INTO messages 
  (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
let msgsAdded = 0;
let msgsSkipped = 0;
const batchInsert = primary.transaction((msgs) => {
  for (const m of msgs) {
    const result = insertMsg.run(m.id, m.chat_jid, m.sender, m.sender_name, 
      m.content, m.timestamp, m.is_from_me, m.is_bot_message);
    if (result.changes > 0) msgsAdded++;
    else msgsSkipped++;
  }
});
batchInsert(codexMsgs);
console.log(`  Added: ${msgsAdded}, Skipped (duplicates): ${msgsSkipped}\n`);

// 6. Merge chats (codex → primary, UPSERT with newer timestamp)
console.log('--- Merging chats ---');
const codexChats = codex.prepare('SELECT * FROM chats').all();
const upsertChat = primary.prepare(`
  INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(jid) DO UPDATE SET
    name = COALESCE(excluded.name, name),
    last_message_time = MAX(last_message_time, excluded.last_message_time),
    channel = COALESCE(excluded.channel, channel),
    is_group = COALESCE(excluded.is_group, is_group)
`);
let chatsUpserted = 0;
for (const c of codexChats) {
  upsertChat.run(c.jid, c.name, c.last_message_time, c.channel, c.is_group);
  chatsUpserted++;
}
console.log(`  Upserted: ${chatsUpserted}\n`);

// 7. Merge scheduled_tasks (codex → primary, skip duplicates)
const codexTasks = codex.prepare('SELECT * FROM scheduled_tasks').all();
if (codexTasks.length > 0) {
  console.log('--- Merging scheduled_tasks ---');
  const insertTask = primary.prepare(`
    INSERT OR IGNORE INTO scheduled_tasks 
    (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, last_run, last_result, status, created_at, context_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const t of codexTasks) {
    insertTask.run(t.id, t.group_folder, t.chat_jid, t.prompt, t.schedule_type,
      t.schedule_value, t.next_run, t.last_run, t.last_result, t.status, t.created_at, t.context_mode);
    console.log(`  + ${t.id}`);
  }
  console.log('');
}

// Close DBs
primary.close();
codex.close();

// 8. Merge groups directories
console.log('--- Merging groups-codex/ → groups/ ---');
const codexGroupsDir = path.join(BASE, 'groups-codex');
const claudeGroupsDir = path.join(BASE, 'groups');
if (fs.existsSync(codexGroupsDir)) {
  const entries = fs.readdirSync(codexGroupsDir);
  for (const entry of entries) {
    const src = path.join(codexGroupsDir, entry);
    const dst = path.join(claudeGroupsDir, entry);
    if (fs.existsSync(dst)) {
      // Merge: copy files that don't exist in dst
      if (fs.statSync(src).isDirectory()) {
        const files = fs.readdirSync(src);
        for (const f of files) {
          const srcFile = path.join(src, f);
          const dstFile = path.join(dst, f);
          if (!fs.existsSync(dstFile)) {
            fs.cpSync(srcFile, dstFile, { recursive: true });
            console.log(`  cp ${entry}/${f}`);
          }
        }
      }
    } else {
      fs.cpSync(src, dst, { recursive: true });
      console.log(`  + ${entry}/`);
    }
  }
}
console.log('');

// 9. Merge data-codex/sessions/ → data/sessions/
console.log('--- Merging data-codex/sessions/ → data/sessions/ ---');
const codexDataSessions = path.join(BASE, 'data-codex/sessions');
const claudeDataSessions = path.join(BASE, 'data/sessions');
if (fs.existsSync(codexDataSessions)) {
  const entries = fs.readdirSync(codexDataSessions);
  for (const entry of entries) {
    const src = path.join(codexDataSessions, entry);
    const dst = path.join(claudeDataSessions, entry);
    if (fs.existsSync(dst)) {
      // Both exist — merge .codex/ subdirectory
      const codexSubdir = path.join(src, '.codex');
      const dstCodexSubdir = path.join(dst, '.codex');
      if (fs.existsSync(codexSubdir) && !fs.existsSync(dstCodexSubdir)) {
        fs.cpSync(codexSubdir, dstCodexSubdir, { recursive: true });
        console.log(`  cp ${entry}/.codex/`);
      }
    } else {
      fs.cpSync(src, dst, { recursive: true });
      console.log(`  + ${entry}/`);
    }
  }
}
console.log('');

console.log('=== Migration complete ===');
console.log('Next steps:');
console.log('1. Update .env.codex to remove EJCLAW_STORE_DIR, EJCLAW_DATA_DIR, EJCLAW_GROUPS_DIR');
console.log('2. Restart both services');
console.log('3. Verify, then rename old dirs to .bak');
