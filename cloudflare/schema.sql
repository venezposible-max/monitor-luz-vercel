-- Esquema D1 para PowerWatch
CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    alias TEXT,
    chat_id TEXT,
    last_seen INTEGER DEFAULT 0,
    online_since INTEGER DEFAULT 0,
    blackout_notified INTEGER DEFAULT 0,
    blackout_start_time INTEGER,
    last_alert_msg_id INTEGER,
    last_alert_messages TEXT DEFAULT '{}',
    ip TEXT DEFAULT '',
    city TEXT DEFAULT '',
    region TEXT DEFAULT '',
    isp TEXT DEFAULT '',
    unlinked INTEGER DEFAULT 0,
    reset_requested INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS guests (
    device_id TEXT NOT NULL,
    guest_chat_id TEXT NOT NULL,
    guest_name TEXT DEFAULT '',
    PRIMARY KEY (device_id, guest_chat_id)
);

CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    start_time_str TEXT,
    end_time_str TEXT,
    start_date_str TEXT,
    end_date_str TEXT,
    duration_str TEXT,
    duration_ms INTEGER DEFAULT 0,
    event_type TEXT DEFAULT 'power_outage'
);

CREATE TABLE IF NOT EXISTS pending_states (
    chat_id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Índices para optimizar consultas de telemetría y consultas por usuario
CREATE INDEX IF NOT EXISTS idx_devices_chat_id ON devices(chat_id);
CREATE INDEX IF NOT EXISTS idx_guests_device_id ON guests(device_id);
CREATE INDEX IF NOT EXISTS idx_guests_chat_id ON guests(guest_chat_id);
CREATE INDEX IF NOT EXISTS idx_history_device_id ON history(device_id);
CREATE INDEX IF NOT EXISTS idx_history_start ON history(start_time DESC);
