package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/fastclaw-ai/fastclaw/internal/agent"
	"github.com/fastclaw-ai/fastclaw/internal/auth"
	"github.com/fastclaw-ai/fastclaw/internal/bus"
	"github.com/fastclaw-ai/fastclaw/internal/config"
	"github.com/fastclaw-ai/fastclaw/internal/provider"
	"github.com/fastclaw-ai/fastclaw/internal/store"
	"github.com/fastclaw-ai/fastclaw/internal/usage"
	"github.com/fastclaw-ai/fastclaw/internal/users"
)

// recordingProvider answers every turn with a fixed reply and keeps the
// system prompt text of the last call.
type recordingProvider struct {
	mu     sync.Mutex
	system string
}

func (p *recordingProvider) record(messages []provider.Message) {
	var b strings.Builder
	for _, m := range messages {
		if m.Role == "system" {
			b.WriteString(m.Content)
			b.WriteString("\n")
		}
	}
	p.mu.Lock()
	p.system = b.String()
	p.mu.Unlock()
}

func (p *recordingProvider) lastSystem() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.system
}

func (p *recordingProvider) Chat(_ context.Context, messages []provider.Message, _ []provider.Tool, _ string, _ int, _ float64) (*provider.Response, error) {
	p.record(messages)
	return &provider.Response{Content: "pong"}, nil
}

func (p *recordingProvider) ChatStream(_ context.Context, messages []provider.Message, _ []provider.Tool, _ string, _ int, _ float64) (*provider.StreamReader, error) {
	p.record(messages)
	ch := make(chan provider.StreamChunk, 1)
	ch <- provider.StreamChunk{Content: "pong", Done: true}
	close(ch)
	return provider.NewStreamReader(ch), nil
}

// fakeRuntime is a UserResolver whose spaces start empty and attach
// agents from the store on EnsureAgent — the shape of an on-demand
// gateway UserSpace.
type fakeRuntime struct {
	t      *testing.T
	st     store.Store
	prov   *recordingProvider
	mb     *bus.MessageBus
	mu     sync.Mutex
	spaces map[string]*agent.Manager
	// ensured records "<namespace user>/<agent>" for every attach.
	ensured []string
}

func (f *fakeRuntime) manager(uid string) *agent.Manager {
	f.mu.Lock()
	defer f.mu.Unlock()
	if m, ok := f.spaces[uid]; ok {
		return m
	}
	m, err := agent.NewManager(nil, f.prov, f.mb, agent.WithUserID(uid))
	if err != nil {
		f.t.Fatalf("NewManager: %v", err)
	}
	f.spaces[uid] = m
	return m
}

func (f *fakeRuntime) UserSpaceFor(uid string) (*UserSpaceView, error) {
	return &UserSpaceView{UserID: uid, Agents: f.manager(uid), Config: &config.Config{}}, nil
}
func (f *fakeRuntime) LocalAgentManager() *agent.Manager { return nil }
func (f *fakeRuntime) IsCloudMode() bool                 { return true }

func (f *fakeRuntime) EnsureAgent(ctx context.Context, uid, agentID string) error {
	mgr := f.manager(uid)
	if mgr.Has(agentID) {
		return nil
	}
	rec, err := f.st.GetAgent(ctx, agentID)
	if err != nil {
		return err
	}
	f.mu.Lock()
	f.ensured = append(f.ensured, uid+"/"+agentID)
	f.mu.Unlock()
	dir := f.t.TempDir()
	return mgr.AddAgent(config.ResolvedAgent{
		ID: rec.ID, Home: dir, Workspace: filepath.Join(dir, "workspace"),
		Model: "test/model", MaxTokens: 256, MaxToolIterations: 2,
	}, f.prov, f.mb)
}

func (f *fakeRuntime) InvalidateUser(string)  {}
func (f *fakeRuntime) InvalidateAgent(string) {}

type v1Harness struct {
	t       *testing.T
	st      *store.DBStore
	rt      *fakeRuntime
	mux     *http.ServeMux
	appA    string
	keyA    string
	appB    string
	keyB    string
	accts   *users.Accounts
	apikeys *users.APIKeys
}

func newV1Harness(t *testing.T) *v1Harness {
	t.Helper()
	t.Setenv("FASTCLAW_HOME", t.TempDir())
	st, err := store.NewDBStore("sqlite", "file:"+filepath.Join(t.TempDir(), "v1.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ctx := context.Background()
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	accts, _ := users.NewAccounts(st)
	apikeys, _ := users.NewAPIKeys(st)
	authResolver, err := auth.NewResolver(st)
	if err != nil {
		t.Fatal(err)
	}
	h := &v1Harness{t: t, st: st, accts: accts, apikeys: apikeys}
	h.appA, h.keyA = h.newApp("douchat")
	h.appB, h.keyB = h.newApp("weclaw")

	h.rt = &fakeRuntime{t: t, st: st, prov: &recordingProvider{}, mb: bus.New(), spaces: map[string]*agent.Manager{}}
	srv := NewServer(h.rt, authResolver, nil)
	srv.SetStore(st)
	srv.SetMeter(usage.NewSQLMeter(st.DB(), "sqlite"))
	h.mux = http.NewServeMux()
	srv.RegisterRoutes(h.mux)
	return h
}

func (h *v1Harness) newApp(name string) (string, string) {
	ctx := context.Background()
	acc, err := h.accts.Create(ctx, users.CreateInput{Username: name, Email: name + "@example.com", Password: "password-" + name})
	if err != nil {
		h.t.Fatal(err)
	}
	_, token, err := h.apikeys.Create(ctx, acc.ID, name+"-key", users.APIKeyTypeUser, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	return acc.ID, token
}

func (h *v1Harness) do(method, path, key string, body any, headers ...string) (int, map[string]any) {
	h.t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		blob, _ := json.Marshal(body)
		rdr = bytes.NewReader(blob)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rdr)
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	rec := httptest.NewRecorder()
	h.mux.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func (h *v1Harness) createAgent(key, name string, md map[string]string) string {
	h.t.Helper()
	code, out := h.do("POST", "/v1/agents", key, map[string]any{"name": name, "metadata": md})
	if code != http.StatusOK {
		h.t.Fatalf("create agent: %d %v", code, out)
	}
	return out["agent"].(map[string]any)["id"].(string)
}

func errCode(out map[string]any) string {
	e, _ := out["error"].(map[string]any)
	c, _ := e["code"].(string)
	return c
}

func TestV1AgentLifecycle(t *testing.T) {
	h := newV1Harness(t)
	ctx := context.Background()

	code, out := h.do("POST", "/v1/agents", h.keyA, map[string]any{
		"name":         "周报助手",
		"description":  "每周五汇总团队进展",
		"instructions": "You write weekly reports.",
		"model":        "anthropic/claude-sonnet-5-5",
		"metadata":     map[string]string{"app_user": "douchat-user-123"},
	})
	if code != http.StatusOK {
		t.Fatalf("create: %d %v", code, out)
	}
	ag := out["agent"].(map[string]any)
	id := ag["id"].(string)
	if !strings.HasPrefix(id, "agt_") || ag["display_name"] != "周报助手" || ag["model"] != "anthropic/claude-sonnet-5-5" {
		t.Fatalf("unexpected agent view: %v", ag)
	}
	if md := ag["metadata"].(map[string]any); md["app_user"] != "douchat-user-123" {
		t.Fatalf("metadata = %v", md)
	}
	rec, err := h.st.GetAgent(ctx, id)
	if err != nil || rec.UserID != h.appA {
		t.Fatalf("agent must belong to the app: %+v %v", rec, err)
	}
	if soul, err := h.st.GetAgentFileExact(ctx, id, h.appA, "SOUL.md"); err != nil || string(soul) != "You write weekly reports." {
		t.Fatalf("SOUL.md = %q %v", soul, err)
	}

	other := h.createAgent(h.keyA, "Other", map[string]string{"app_user": "douchat-user-456"})

	// Metadata filter, both spellings.
	for _, q := range []string{"metadata[app_user]=douchat-user-123", "metadata.app_user=douchat-user-123"} {
		code, out = h.do("GET", "/v1/agents?"+q, h.keyA, nil)
		list := out["agents"].([]any)
		if code != http.StatusOK || len(list) != 1 || list[0].(map[string]any)["id"] != id {
			t.Fatalf("filter %s: %d %v", q, code, out)
		}
	}

	// Pagination walks every agent exactly once.
	seen := map[string]bool{}
	cursor := ""
	for page := 0; page < 5; page++ {
		path := "/v1/agents?limit=1"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		_, out = h.do("GET", path, h.keyA, nil)
		for _, a := range out["agents"].([]any) {
			seen[a.(map[string]any)["id"].(string)] = true
		}
		if out["has_more"] != true {
			break
		}
		cursor = out["next_cursor"].(string)
	}
	if len(seen) != 2 || !seen[id] || !seen[other] {
		t.Fatalf("paginated ids = %v", seen)
	}

	// PATCH: rename, drop a metadata key, clear the model.
	code, out = h.do("PATCH", "/v1/agents/"+id, h.keyA, map[string]any{
		"name": "Weekly", "model": "", "metadata": map[string]any{"app_user": nil, "team": "t1"},
	})
	ag = out["agent"].(map[string]any)
	if code != http.StatusOK || ag["display_name"] != "Weekly" || ag["model"] != "" {
		t.Fatalf("patch: %d %v", code, out)
	}
	if md := ag["metadata"].(map[string]any); len(md) != 1 || md["team"] != "t1" {
		t.Fatalf("patched metadata = %v", md)
	}

	code, _ = h.do("PUT", "/v1/agents/"+id+"/system-files/IDENTITY.md", h.keyA, map[string]any{"content": "Name: Weekly"})
	if code != http.StatusOK {
		t.Fatalf("put system file: %d", code)
	}
	if code, out = h.do("PUT", "/v1/agents/"+id+"/system-files/USER.md", h.keyA, map[string]any{"content": "x"}); code != http.StatusBadRequest {
		t.Fatalf("per-user files are not writable through /v1: %d %v", code, out)
	}

	if code, _ = h.do("DELETE", "/v1/agents/"+id, h.keyA, nil); code != http.StatusOK {
		t.Fatalf("delete: %d", code)
	}
	code, out = h.do("GET", "/v1/agents/"+id, h.keyA, nil)
	if code != http.StatusNotFound || errCode(out) != "agent_not_found" {
		t.Fatalf("get deleted: %d %v", code, out)
	}
	code, out = h.do("DELETE", "/v1/agents/"+id, h.keyA, nil)
	if code != http.StatusNotFound || errCode(out) != "agent_not_found" {
		t.Fatalf("second delete: %d %v", code, out)
	}
}

func TestV1AgentMetadataLimits(t *testing.T) {
	h := newV1Harness(t)
	tooMany := map[string]string{}
	for i := 0; i < maxMetadataKeys+1; i++ {
		tooMany[fmt.Sprintf("k%d", i)] = "v"
	}
	for name, md := range map[string]map[string]string{
		"too many keys": tooMany,
		"long key":      {strings.Repeat("k", maxMetadataKeyLen+1): "v"},
		"long value":    {"k": strings.Repeat("v", maxMetadataValueLen+1)},
	} {
		code, out := h.do("POST", "/v1/agents", h.keyA, map[string]any{"name": "x", "metadata": md})
		if code != http.StatusBadRequest || errCode(out) != "invalid_request" {
			t.Fatalf("%s: %d %v", name, code, out)
		}
	}
}

func TestV1AppsAreIsolated(t *testing.T) {
	h := newV1Harness(t)
	id := h.createAgent(h.keyA, "A's agent", nil)

	_, out := h.do("GET", "/v1/agents", h.keyB, nil)
	if list := out["agents"].([]any); len(list) != 0 {
		t.Fatalf("app B sees app A's agents: %v", list)
	}
	for _, c := range []struct{ method, path string }{
		{"GET", "/v1/agents/" + id},
		{"PATCH", "/v1/agents/" + id},
		{"DELETE", "/v1/agents/" + id},
		{"PUT", "/v1/agents/" + id + "/system-files/SOUL.md"},
	} {
		code, out := h.do(c.method, c.path, h.keyB, map[string]any{"name": "pwned", "content": "pwned"})
		if code != http.StatusNotFound || errCode(out) != "agent_not_found" {
			t.Fatalf("%s %s from app B: %d %v", c.method, c.path, code, out)
		}
	}
	code, out := h.do("POST", "/v1/chat/completions", h.keyB, map[string]any{
		"agent_id": id, "messages": []map[string]string{{"role": "user", "content": "hi"}},
	})
	if code != http.StatusNotFound || errCode(out) != "agent_not_found" {
		t.Fatalf("chat with another app's agent: %d %v", code, out)
	}
}

func TestChatStrictAgentID(t *testing.T) {
	h := newV1Harness(t)
	h.createAgent(h.keyA, "Only", nil)

	// An unknown agent_id must 404 — never fall back to another agent —
	// whether it comes in the body or the header.
	code, out := h.do("POST", "/v1/chat/completions", h.keyA, map[string]any{
		"agent_id": "agt_doesnotexist", "messages": []map[string]string{{"role": "user", "content": "hi"}},
	})
	if code != http.StatusNotFound || errCode(out) != "agent_not_found" {
		t.Fatalf("unknown agent_id: %d %v", code, out)
	}
	code, out = h.do("POST", "/v1/chat/completions", h.keyA, map[string]any{
		"messages": []map[string]string{{"role": "user", "content": "hi"}},
	}, "X-Fastclaw-Agent-ID", "agt_doesnotexist")
	if code != http.StatusNotFound || errCode(out) != "agent_not_found" {
		t.Fatalf("unknown agent header: %d %v", code, out)
	}
	if len(h.rt.ensured) != 0 {
		t.Fatalf("no agent may be attached for an unknown id: %v", h.rt.ensured)
	}
}

func TestChatWithEndUserRunsAppAgentInEndUserNamespace(t *testing.T) {
	h := newV1Harness(t)
	id := h.createAgent(h.keyA, "Shared", nil)

	for _, endUser := range []string{"alice", "bob"} {
		code, out := h.do("POST", "/v1/chat/completions", h.keyA, map[string]any{
			"agent_id": id, "messages": []map[string]string{{"role": "user", "content": "hi"}},
		}, "X-Fastclaw-End-User", endUser, "X-Fastclaw-Session-Key", "douchat:dm:"+endUser)
		if code != http.StatusOK {
			t.Fatalf("chat as %s: %d %v", endUser, code, out)
		}
	}
	// Body `user` names the end-user the same way.
	code, out := h.do("POST", "/v1/chat/completions", h.keyA, map[string]any{
		"agent_id": id, "user": "carol", "messages": []map[string]string{{"role": "user", "content": "hi"}},
	})
	if code != http.StatusOK {
		t.Fatalf("chat with body user: %d %v", code, out)
	}

	ctx := context.Background()
	namespaces := map[string]bool{}
	for _, ext := range []string{"alice", "bob", "carol"} {
		u, err := h.st.GetUserByExternal(ctx, h.appA, ext)
		if err != nil {
			t.Fatalf("end-user %s was not minted under the app: %v", ext, err)
		}
		namespaces[u.ID+"/"+id] = true
	}
	if len(h.rt.ensured) != 3 {
		t.Fatalf("ensured = %v", h.rt.ensured)
	}
	for _, e := range h.rt.ensured {
		if !namespaces[e] {
			t.Fatalf("agent attached outside an end-user namespace: %s (want one of %v)", e, namespaces)
		}
	}
}

func TestChatSpeakerIsTurnContextNotClientParam(t *testing.T) {
	h := newV1Harness(t)
	id := h.createAgent(h.keyA, "Group", nil)
	code, out := h.do("POST", "/v1/chat/completions", h.keyA, map[string]any{
		"agent_id": id,
		"messages": []map[string]string{{"role": "user", "content": "summarize"}},
		"params":   map[string]any{"speaker": map[string]any{"id": "douchat-user-456", "name": "Bob"}, "lang": "en"},
	}, "X-Fastclaw-Session-Key", "douchat:group_123:topic_9")
	if code != http.StatusOK {
		t.Fatalf("chat: %d %v", code, out)
	}
	sys := h.rt.prov.lastSystem()
	if !strings.Contains(sys, "## Current Speaker") || !strings.Contains(sys, "Bob") || !strings.Contains(sys, "douchat-user-456") {
		t.Fatalf("speaker missing from turn context:\n%s", sys)
	}
	if strings.Contains(sys, `"speaker"`) || strings.Contains(sys, "__fastclawSpeaker") {
		t.Fatalf("speaker leaked into client parameters:\n%s", sys)
	}
	if !strings.Contains(sys, `"lang": "en"`) {
		t.Fatalf("other params must still reach the agent:\n%s", sys)
	}
}

func TestUsageByEndUserAndApp(t *testing.T) {
	h := newV1Harness(t)
	ctx := context.Background()
	alice, err := h.accts.EnsureAppUser(ctx, h.appA, "alice", "", "")
	if err != nil {
		t.Fatal(err)
	}
	meter := usage.NewSQLMeter(h.st.DB(), "sqlite")
	_ = meter.RecordTokens(ctx, alice.ID, "agt_1", "s1", "", "m", usage.Tokens{Input: 10, Output: 5})
	_ = meter.RecordTokens(ctx, h.appA, "agt_2", "s2", "", "m", usage.Tokens{Input: 100})
	_ = meter.RecordTokens(ctx, h.appB, "agt_3", "s3", "", "m", usage.Tokens{Input: 1000})

	totalIn := func(out map[string]any) float64 {
		return out["totals"].(map[string]any)["inputTokens"].(float64)
	}
	code, out := h.do("GET", "/v1/usage?end_user=alice", h.keyA, nil)
	daily := out["daily"].([]any)
	if code != http.StatusOK || totalIn(out) != 10 || len(daily) != 1 || daily[0].(map[string]any)["endUser"] != "alice" {
		t.Fatalf("end_user usage: %d %v", code, out)
	}
	if _, out = h.do("GET", "/v1/usage?scope=app", h.keyA, nil); totalIn(out) != 110 {
		t.Fatalf("app usage must cover the app and its end-users only: %v", out)
	}
	if _, out = h.do("GET", "/v1/usage?scope=app&agent_id=agt_2", h.keyA, nil); totalIn(out) != 100 {
		t.Fatalf("agent filter: %v", out)
	}
	if _, out = h.do("GET", "/v1/usage", h.keyA, nil); totalIn(out) != 100 {
		t.Fatalf("default usage stays the caller's own namespace: %v", out)
	}
	if _, out = h.do("GET", "/v1/usage?end_user=nobody", h.keyA, nil); totalIn(out) != 0 {
		t.Fatalf("unknown end_user: %v", out)
	}
	if _, err := h.st.GetUserByExternal(ctx, h.appA, "nobody"); err == nil {
		t.Fatal("querying usage must not mint end-users")
	}
	code, out = h.do("GET", "/v1/usage?user_id="+h.appA, h.keyB, nil)
	if code != http.StatusForbidden || errCode(out) != "forbidden" {
		t.Fatalf("app B read app A's usage: %d %v", code, out)
	}
}

func TestV1UnauthorizedUsesUnifiedError(t *testing.T) {
	h := newV1Harness(t)
	code, out := h.do("GET", "/v1/agents", "fc_bogus", nil)
	if code != http.StatusUnauthorized || errCode(out) != "unauthorized" {
		t.Fatalf("bad key: %d %v", code, out)
	}
}
