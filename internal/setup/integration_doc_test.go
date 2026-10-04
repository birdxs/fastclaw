package setup

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// The served guide is a build-time copy of docs/upstream-api.md; run
// `make bundle-docs` after editing the doc.
func TestIntegrationDocMatchesDocs(t *testing.T) {
	src, err := os.ReadFile("../../docs/upstream-api.md")
	if err != nil {
		t.Fatal(err)
	}
	if string(src) != integrationDoc {
		t.Fatal("internal/setup/apidocs/upstream-api.md is stale: run `make bundle-docs`")
	}
}

func TestIntegrationDocNamesBaseURL(t *testing.T) {
	s := NewServer(0)
	req := httptest.NewRequest(http.MethodGet, "http://internal:18953/integration.md", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "claw.example.com")
	rec := httptest.NewRecorder()
	s.handleIntegrationDoc(rec, req)
	body := rec.Body.String()
	if rec.Code != http.StatusOK || !strings.Contains(body, "base URL `https://claw.example.com`") ||
		!strings.Contains(body, "# FastClaw Upstream App Integration API") {
		t.Fatalf("unexpected doc: %d %.300s", rec.Code, body)
	}
	if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/markdown") {
		t.Fatalf("content type %q", rec.Header().Get("Content-Type"))
	}
}
