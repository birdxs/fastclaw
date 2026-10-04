package setup

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// The served guide is a build-time copy of skills/agent-integration/SKILL.md;
// run `make bundle-docs` after editing the skill.
func TestIntegrationDocMatchesSkill(t *testing.T) {
	src, err := os.ReadFile("../../skills/agent-integration/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	if string(src) != integrationDoc {
		t.Fatal("internal/setup/apidocs/agent-integration.md is stale: run `make bundle-docs`")
	}
}

func TestIntegrationDocServedVerbatim(t *testing.T) {
	s := NewServer(0)
	rec := httptest.NewRecorder()
	s.handleIntegrationDoc(rec, httptest.NewRequest(http.MethodGet, "/integration.md", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != integrationDoc ||
		!strings.HasPrefix(rec.Header().Get("Content-Type"), "text/markdown") {
		t.Fatalf("unexpected response: %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
}
