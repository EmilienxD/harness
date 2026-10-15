CREATE TABLE sessions (
 id TEXT PRIMARY KEY, provider_session_id TEXT, cwd TEXT NOT NULL,
 provider TEXT NOT NULL DEFAULT 'claude', execution_mode TEXT NOT NULL DEFAULT 'interactive',
 model TEXT,
 effort TEXT,
 parent_session_id TEXT REFERENCES sessions(id), agent_index INTEGER CHECK(agent_index >= 1),
 hook_sequence INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(provider, provider_session_id), UNIQUE(parent_session_id, agent_index),
 CHECK((parent_session_id IS NULL) = (agent_index IS NULL)), UNIQUE(id, parent_session_id)
);
CREATE TABLE session_delegation (
 parent_session_id TEXT PRIMARY KEY REFERENCES sessions(id), inbox TEXT NOT NULL UNIQUE,
 enabled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, context_epoch INTEGER NOT NULL DEFAULT 0,
 injected_epoch INTEGER, claim_sequence INTEGER, acknowledgement_sequence INTEGER
);
CREATE TABLE requests (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'launch' CHECK(kind IN ('launch','resume')),
 parent_session_id TEXT NOT NULL REFERENCES sessions(id), child_session_id TEXT REFERENCES sessions(id),
 agent_number INTEGER, source_name TEXT, task TEXT, provider TEXT, mode TEXT, prompt_hash TEXT,
 state TEXT NOT NULL CHECK(state IN ('launching','pending','uncertain','succeeded','failed','cancelled')),
 reply TEXT, reason TEXT, delivery_id TEXT UNIQUE, claim_sequence INTEGER, acknowledgement_sequence INTEGER,
 claimed_at TEXT, acknowledged_at TEXT, source_deleted_at TEXT, completed_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(parent_session_id,source_name), UNIQUE(id,child_session_id),
 FOREIGN KEY(child_session_id,parent_session_id) REFERENCES sessions(id,parent_session_id)
);
CREATE UNIQUE INDEX requests_child_active ON requests(child_session_id)
 WHERE state IN ('launching','pending','uncertain');
CREATE INDEX requests_parent_state ON requests(parent_session_id,state,acknowledgement_sequence);
CREATE TABLE executions (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT UNIQUE REFERENCES requests(id),
 backend TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','starting','running','uncertain','exited','failed','cancelled')),
 reservation_pid INTEGER, reservation_birth TEXT,
 supervisor_pid INTEGER, supervisor_birth TEXT, provider_pid INTEGER, provider_birth TEXT,
 aboard_agent_id TEXT, aboard_handle TEXT, exit_code INTEGER,
 fork_of TEXT, superseded_at TEXT, input_execution_id TEXT REFERENCES executions(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, started_at TEXT, exited_at TEXT,
 FOREIGN KEY(request_id,session_id) REFERENCES requests(id,child_session_id)
);
CREATE UNIQUE INDEX executions_session_active ON executions(session_id)
 WHERE state IN ('prepared','starting','running','uncertain') AND superseded_at IS NULL;
CREATE TABLE reply_authorizations (
 request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
 child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id), armed_sequence INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(request_id,child_session_id) REFERENCES requests(id,child_session_id)
);
CREATE TABLE inbox_migrations (
 source TEXT PRIMARY KEY, destination TEXT, reconciled_at TEXT
);
CREATE TABLE loop_sessions (
 session_id TEXT PRIMARY KEY REFERENCES sessions(id), worktree_key TEXT NOT NULL,
 prompt_path TEXT NOT NULL, difficulty TEXT,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 context_usage TEXT, released_at TEXT
);
CREATE UNIQUE INDEX loop_worktree_active ON loop_sessions(worktree_key) WHERE active=1;
CREATE TABLE loop_waits (
 session_id TEXT PRIMARY KEY REFERENCES loop_sessions(session_id), token TEXT NOT NULL,
 state TEXT NOT NULL, pid INTEGER NOT NULL, birth TEXT, heartbeat REAL NOT NULL,
 deadline REAL NOT NULL, feedback TEXT
);
CREATE TABLE loop_messages (
 id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES loop_sessions(session_id),
 source TEXT NOT NULL, message TEXT NOT NULL
);
