package store

import (
	"context"
	"path/filepath"
	"testing"
)

func openAppsTestStore(t *testing.T, name string) *DBStore {
	t.Helper()
	st, err := NewDBStore("sqlite", "file:"+filepath.Join(t.TempDir(), name))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

// Apps are optional: rows without one stay account-level, and agents or
// keys may only join an app of their own account.
func TestAppsAreOptional(t *testing.T) {
	ctx := context.Background()
	st := openAppsTestStore(t, "apps.db")
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveAgent(ctx, &AgentRecord{ID: "agt_plain", UserID: "u_a", Name: "plain"}); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.GetAgent(ctx, "agt_plain"); got.AppID != "" {
		t.Fatalf("agent without an app must stay account-level, got %q", got.AppID)
	}
	if apps, _ := st.ListApps(ctx, "u_a"); len(apps) != 0 {
		t.Fatalf("no app may be created implicitly: %+v", apps)
	}

	theirs := &AppRecord{OwnerUserID: "u_a", Name: "prod"}
	if err := st.CreateApp(ctx, theirs); err != nil {
		t.Fatal(err)
	}
	// A record copied to another account drops the foreign app.
	if err := st.SaveAgent(ctx, &AgentRecord{ID: "agt_x", UserID: "u_b", AppID: theirs.ID, Name: "x"}); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.GetAgent(ctx, "agt_x"); got.AppID != "" {
		t.Fatalf("foreign app must be dropped, got %q", got.AppID)
	}
	if err := st.CreateAPIKey(ctx, &APIKeyRecord{ID: "k_x", UserID: "u_b", AppID: theirs.ID, KeyHash: "h"}); err == nil {
		t.Fatal("a key must not join another account's app")
	}

	if err := st.SaveAgent(ctx, &AgentRecord{ID: "agt_in", UserID: "u_a", AppID: theirs.ID, Name: "in"}); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteApp(ctx, theirs.ID); err != ErrAppNotEmpty {
		t.Fatalf("delete non-empty app: %v", err)
	}
	if err := st.DeleteAgent(ctx, "agt_in"); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteApp(ctx, theirs.ID); err != nil {
		t.Fatalf("empty app should delete: %v", err)
	}
}

// A database created before apps has no app_id columns; existing rows
// become account-level.
func TestMigrateAppsOnLegacySchema(t *testing.T) {
	ctx := context.Background()
	st := openAppsTestStore(t, "legacy.db")
	for _, q := range []string{
		`CREATE TABLE agents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
			config TEXT NOT NULL DEFAULT '{}', is_public BOOLEAN NOT NULL DEFAULT FALSE,
			created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE apikeys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
			key_hash TEXT NOT NULL, key_prefix TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'agent',
			created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`INSERT INTO agents (id, user_id, name) VALUES ('agt_legacy', 'u_legacy', 'legacy')`,
		`INSERT INTO apikeys (id, user_id, key_hash, type) VALUES ('k_legacy', 'u_legacy', 'h', 'user')`,
	} {
		if _, err := st.DB().ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if ag, err := st.GetAgent(ctx, "agt_legacy"); err != nil || ag.AppID != "" {
		t.Fatalf("legacy agent = %+v %v", ag, err)
	}
	if key, err := st.GetAPIKey(ctx, "k_legacy"); err != nil || key.AppID != "" {
		t.Fatalf("legacy key = %+v %v", key, err)
	}
}

// Databases that ran the short-lived default-app migration get their
// default-app rows moved back to account level.
func TestMigrateAppsUndoesDefaultApps(t *testing.T) {
	ctx := context.Background()
	st := openAppsTestStore(t, "undo.db")
	for _, q := range []string{
		`CREATE TABLE agents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
			config TEXT NOT NULL DEFAULT '{}', is_public BOOLEAN NOT NULL DEFAULT FALSE,
			app_id TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE apikeys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
			key_hash TEXT NOT NULL, key_prefix TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'agent',
			app_id TEXT NOT NULL DEFAULT '', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE apps (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
			is_default BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE UNIQUE INDEX idx_apps_one_default ON apps (owner_user_id) WHERE is_default = TRUE`,
		`INSERT INTO apps (id, owner_user_id, name, is_default) VALUES ('app_def', 'u_a', 'default', TRUE)`,
		`INSERT INTO apps (id, owner_user_id, name, is_default) VALUES ('app_prod', 'u_a', 'prod', FALSE)`,
		`INSERT INTO agents (id, user_id, name, app_id) VALUES ('agt_def', 'u_a', 'd', 'app_def')`,
		`INSERT INTO agents (id, user_id, name, app_id) VALUES ('agt_prod', 'u_a', 'p', 'app_prod')`,
		`INSERT INTO apikeys (id, user_id, key_hash, type, app_id) VALUES ('k_def', 'u_a', 'h', 'user', 'app_def')`,
	} {
		if _, err := st.DB().ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ { // idempotent
		if err := st.Migrate(ctx); err != nil {
			t.Fatalf("migrate #%d: %v", i+1, err)
		}
	}
	if ag, _ := st.GetAgent(ctx, "agt_def"); ag.AppID != "" {
		t.Fatalf("default-app agent must become account-level, got %q", ag.AppID)
	}
	if key, _ := st.GetAPIKey(ctx, "k_def"); key.AppID != "" {
		t.Fatalf("default-app key must become account-level, got %q", key.AppID)
	}
	if ag, _ := st.GetAgent(ctx, "agt_prod"); ag.AppID != "app_prod" {
		t.Fatalf("real app assignment must survive, got %q", ag.AppID)
	}
	apps, _ := st.ListApps(ctx, "u_a")
	if len(apps) != 1 || apps[0].ID != "app_prod" {
		t.Fatalf("apps after undo = %+v", apps)
	}
}
