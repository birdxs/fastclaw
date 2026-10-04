package store

import (
	"context"
	"path/filepath"
	"testing"
)

// Rows written before apps existed (app_id = '') are filed under one
// default app per account on the next Migrate, and re-running is a no-op.
func TestMigrateAppsAssignsDefaultApp(t *testing.T) {
	ctx := context.Background()
	st, err := NewDBStore("sqlite", "file:"+filepath.Join(t.TempDir(), "apps.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO agents (id, user_id, name, app_id) VALUES ('agt_old', 'u_owner', 'old', '')`,
		`INSERT INTO apikeys (id, user_id, key_hash, type, app_id) VALUES ('k_old', 'u_owner', 'h', 'user', '')`,
		`INSERT INTO agents (id, user_id, name, app_id) VALUES ('agt_other', 'u_other', 'other', '')`,
	} {
		if _, err := st.DB().ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := st.Migrate(ctx); err != nil {
			t.Fatalf("migrate #%d: %v", i+2, err)
		}
	}
	apps, err := st.ListApps(ctx, "u_owner")
	if err != nil || len(apps) != 1 || !apps[0].IsDefault {
		t.Fatalf("owner apps = %+v %v, want exactly one default app", apps, err)
	}
	ag, _ := st.GetAgent(ctx, "agt_old")
	key, _ := st.GetAPIKey(ctx, "k_old")
	if ag.AppID != apps[0].ID || key.AppID != apps[0].ID {
		t.Fatalf("agent app %q, key app %q, want %q", ag.AppID, key.AppID, apps[0].ID)
	}
	other, _ := st.GetAgent(ctx, "agt_other")
	if other.AppID == "" || other.AppID == apps[0].ID {
		t.Fatalf("each account gets its own default app, got %q", other.AppID)
	}
}

// SaveAgent keeps an agent inside its owner's apps: a record copied from
// another account falls back to the new owner's default app.
func TestSaveAgentRejectsForeignApp(t *testing.T) {
	ctx := context.Background()
	st, err := NewDBStore("sqlite", "file:"+filepath.Join(t.TempDir(), "apps2.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	theirs := &AppRecord{OwnerUserID: "u_a", Name: "prod"}
	if err := st.CreateApp(ctx, theirs); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveAgent(ctx, &AgentRecord{ID: "agt_x", UserID: "u_b", AppID: theirs.ID, Name: "x"}); err != nil {
		t.Fatal(err)
	}
	got, _ := st.GetAgent(ctx, "agt_x")
	def, _ := st.EnsureDefaultApp(ctx, "u_b")
	if got.AppID != def.ID {
		t.Fatalf("app = %q, want u_b's default %q", got.AppID, def.ID)
	}
	if err := st.DeleteApp(ctx, def.ID); err == nil {
		t.Fatal("default app must not be deletable")
	}
	if err := st.DeleteApp(ctx, theirs.ID); err != nil {
		t.Fatalf("empty app should delete: %v", err)
	}
}

// A database created before apps has no app_id columns at all.
func TestMigrateAppsOnLegacySchema(t *testing.T) {
	ctx := context.Background()
	st, err := NewDBStore("sqlite", "file:"+filepath.Join(t.TempDir(), "legacy.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
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
	def, err := st.EnsureDefaultApp(ctx, "u_legacy")
	if err != nil {
		t.Fatal(err)
	}
	ag, err := st.GetAgent(ctx, "agt_legacy")
	if err != nil || ag.AppID != def.ID {
		t.Fatalf("legacy agent = %+v %v, want app %s", ag, err, def.ID)
	}
	if key, err := st.GetAPIKey(ctx, "k_legacy"); err != nil || key.AppID != def.ID {
		t.Fatalf("legacy key = %+v %v", key, err)
	}
}
