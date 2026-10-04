package setup

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/fastclaw-ai/fastclaw/internal/auth"
	"github.com/fastclaw-ai/fastclaw/internal/store"
	"github.com/fastclaw-ai/fastclaw/internal/users"
)

// Apps are optional tenants of the runtime API: an integrating application
// in one environment (douchat-prod, douchat-dev). Without apps, agents and
// api keys belong to the account directly and an account-level key covers
// every agent. An app narrows a key to the agents created in that app.
// Apps are managed from the console only; api keys can't create or modify
// them.

const maxAppNameLen = 64

// requireAppManager allows console sessions and platform-admin keys.
func (s *Server) requireAppManager(w http.ResponseWriter, r *http.Request) (auth.Identity, bool) {
	ident, ok := auth.FromContext(r.Context())
	if !ok {
		jsonResponse(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return ident, false
	}
	if ident.AuthMethod == "apikey" && !ident.CanAdminPlatform() {
		jsonResponse(w, http.StatusForbidden, map[string]any{"error": "apps are managed from the console"})
		return ident, false
	}
	if ident.Role == users.RoleAppUser || ident.Role == users.RoleChannelUser {
		jsonResponse(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
		return ident, false
	}
	return ident, true
}

// ownedApp loads appID and checks it belongs to the caller's account.
func (s *Server) ownedApp(w http.ResponseWriter, r *http.Request, ident auth.Identity, appID string) *store.AppRecord {
	app, err := s.dataStore.GetApp(r.Context(), appID)
	if err != nil || app == nil || (app.OwnerUserID != ident.EffectiveUserID() && !ident.CanAdminPlatform()) {
		jsonResponse(w, http.StatusNotFound, map[string]any{"error": "app not found"})
		return nil
	}
	return app
}

func validAppName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	return name, name != "" && utf8.RuneCountInString(name) <= maxAppNameLen
}

// GET /api/apps
func (s *Server) handleListApps(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.requireAppManager(w, r)
	if !ok {
		return
	}
	uid := ident.EffectiveUserID()
	ctx := r.Context()
	apps, err := s.dataStore.ListApps(ctx, uid)
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	keyCount := map[string]int{}
	if keys, err := s.dataStore.ListAPIKeys(ctx, uid); err == nil {
		for _, k := range keys {
			keyCount[k.AppID]++
		}
	}
	out := make([]map[string]any, 0, len(apps))
	for _, a := range apps {
		ids, _ := s.dataStore.ListAgentIDsByApp(ctx, a.ID)
		out = append(out, map[string]any{
			"id":         a.ID,
			"name":       a.Name,
			"createdAt":  a.CreatedAt,
			"agentCount": len(ids),
			"keyCount":   keyCount[a.ID],
		})
	}
	jsonResponse(w, http.StatusOK, map[string]any{"apps": out})
}

// POST /api/apps  {"name": "douchat-prod"}
func (s *Server) handleCreateApp(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.requireAppManager(w, r)
	if !ok || !s.requireWritable(w, r) {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResponse(w, http.StatusBadRequest, map[string]any{"error": "invalid request"})
		return
	}
	name, valid := validAppName(req.Name)
	if !valid {
		jsonResponse(w, http.StatusBadRequest, map[string]any{"error": "name is required (max 64 characters)"})
		return
	}
	uid := ident.EffectiveUserID()
	app := &store.AppRecord{OwnerUserID: uid, Name: name}
	if err := s.dataStore.CreateApp(r.Context(), app); err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	jsonResponse(w, http.StatusCreated, map[string]any{"app": app})
}

// PATCH /api/apps/{id}  {"name": "..."}
func (s *Server) handleUpdateApp(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.requireAppManager(w, r)
	if !ok || !s.requireWritable(w, r) {
		return
	}
	app := s.ownedApp(w, r, ident, r.PathValue("id"))
	if app == nil {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResponse(w, http.StatusBadRequest, map[string]any{"error": "invalid request"})
		return
	}
	name, valid := validAppName(req.Name)
	if !valid {
		jsonResponse(w, http.StatusBadRequest, map[string]any{"error": "name is required (max 64 characters)"})
		return
	}
	if err := s.dataStore.RenameApp(r.Context(), app.ID, name); err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	app.Name = name
	jsonResponse(w, http.StatusOK, map[string]any{"app": app})
}

// DELETE /api/apps/{id} — only an app with no agents and no keys left.
func (s *Server) handleDeleteApp(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.requireAppManager(w, r)
	if !ok || !s.requireWritable(w, r) {
		return
	}
	app := s.ownedApp(w, r, ident, r.PathValue("id"))
	if app == nil {
		return
	}
	if err := s.dataStore.DeleteApp(r.Context(), app.ID); err != nil {
		if errors.Is(err, store.ErrAppNotEmpty) {
			jsonResponse(w, http.StatusConflict, map[string]any{"error": "delete the app's agents and api keys first"})
			return
		}
		jsonResponse(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	jsonResponse(w, http.StatusOK, map[string]any{"ok": true})
}

// resolveKeyApp validates the app a new api key for ownerID should act
// for. Empty appID is an account-level key and returns "".
func (s *Server) resolveKeyApp(r *http.Request, ownerID, appID string) (string, error) {
	appID = strings.TrimSpace(appID)
	if appID == "" {
		return "", nil
	}
	app, err := s.dataStore.GetApp(r.Context(), appID)
	if err != nil || app == nil || app.OwnerUserID != ownerID {
		return "", errors.New("app not found")
	}
	return app.ID, nil
}
