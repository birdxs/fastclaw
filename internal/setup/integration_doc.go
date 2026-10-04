package setup

import (
	_ "embed"
	"net/http"
	"strings"
)

// integrationDoc is docs/upstream-api.md, the contract for applications
// that use FastClaw as their agent runtime. `make bundle-docs` copies it
// here; TestIntegrationDocMatchesDocs keeps the two in sync.
//
//go:embed apidocs/upstream-api.md
var integrationDoc string

// handleIntegrationDoc serves GET /integration.md: the integration guide
// for the coding agent (or developer) wiring an app to this FastClaw. It is
// public — documentation only, no secrets — so an agent can read it from a
// URL before it has a key. The header names this deployment's base URL so
// the guide is ready to follow as-is.
func (s *Server) handleIntegrationDoc(w http.ResponseWriter, r *http.Request) {
	base := requestBaseURL(r)
	var b strings.Builder
	b.WriteString("<!-- Served by this FastClaw at " + base + "/integration.md -->\n\n")
	b.WriteString("> **This FastClaw:** base URL `" + base + "`. Send `Authorization: Bearer <API key>`;\n")
	b.WriteString("> keys are issued in the console under **API Keys** (" + base + "/console/apikeys/).\n\n")
	b.WriteString(integrationDoc)
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_, _ = w.Write([]byte(b.String()))
}

// requestBaseURL reconstructs the externally visible origin of a request,
// honoring the usual reverse-proxy headers.
func requestBaseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if p := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); p == "http" || p == "https" {
		scheme = p
	}
	host := r.Host
	if h := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0]); h != "" {
		host = h
	}
	return scheme + "://" + host
}
