package setup

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/fastclaw-ai/fastclaw/internal/auth"
	"github.com/fastclaw-ai/fastclaw/internal/store"
	"github.com/fastclaw-ai/fastclaw/internal/users"
)

// The first message of a new chat uploads before the chat request creates
// the session; the upload must land where that chat will look, without
// letting a caller write into a session someone else already has.
func TestNewChatUploadScope(t *testing.T) {
	ctx := context.Background()
	st, err := store.NewDBStore("sqlite", "file:"+filepath.Join(t.TempDir(), "s.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveSession(ctx, "u_bob", "agt_1", "s-1700000000000-taken", &store.SessionRecord{Channel: "web", ChatID: "s-1700000000000-taken"}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveProject(ctx, &store.ProjectRecord{UserID: "u_alice", AgentID: "agt_1", ID: "p_mine", Name: "mine"}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveProject(ctx, &store.ProjectRecord{UserID: "u_bob", AgentID: "agt_1", ID: "p_bobs", Name: "bob's"}); err != nil {
		t.Fatal(err)
	}
	s := &Server{dataStore: st}
	alice := httptest.NewRequest(http.MethodPost, "/", nil)
	alice = alice.WithContext(auth.WithIdentity(alice.Context(), auth.Identity{UserID: "u_alice", Role: users.RoleUser, AuthMethod: "session"}))

	cases := []struct {
		name, key, project, wantSession, wantProject string
	}{
		{"new loose chat", "s-1700000000001-abc123", "", "s-1700000000001-abc123", ""},
		{"new chat in own project", "s-1700000000001-abc123", "p_mine", "", "p_mine"},
		{"someone else's project", "s-1700000000001-abc123", "p_bobs", "", ""},
		{"key already in use", "s-1700000000000-taken", "", "", ""},
		{"not a web session key", "../../etc", "", "", ""},
		{"empty key", "", "", "", ""},
	}
	for _, c := range cases {
		sid, pid := s.newChatUploadScope(alice, "agt_1", c.key, c.project)
		if sid != c.wantSession || pid != c.wantProject {
			t.Errorf("%s: got (%q, %q), want (%q, %q)", c.name, sid, pid, c.wantSession, c.wantProject)
		}
	}
}
