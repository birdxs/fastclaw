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

// Apps are the tenants of the runtime API: an integrating application in
// one environment (douchat-prod, douchat-dev, weclaw). Each account has a
// default app that holds everything created before apps existed and
// everything the console creates. Apps are managed from the console only;
// api keys can't create or modify them.

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
	if _, err := s.dataStore.EnsureDefaultApp(ctx, uid); err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
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
			"isDefault":  a.IsDefault,
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
	// Make sure the default app exists first so the new one is never
	// mistaken for it.
	if _, err := s.dataStore.EnsureDefaultApp(r.Context(), uid); err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
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

// DELETE /api/apps/{id} — only an empty, non-default app.
func (s *Server) handleDeleteApp(w http.ResponseWriter, r *http.Request) {
	ident, ok := s.requireAppManager(w, r)
	if !ok || !s.requireWritable(w, r) {
		return
	}
	app := s.ownedApp(w, r, ident, r.PathValue("id"))
	if app == nil {
		return
	}
	if app.IsDefault {
		jsonResponse(w, http.StatusBadRequest, map[string]any{"error": "the default app can't be deleted"})
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

// resolveKeyApp picks the app a new api key for ownerID belongs to:
// the requested one (which must be the owner's) or the owner's default.
func (s *Server) resolveKeyApp(r *http.Request, ownerID, appID string) (*store.AppRecord, error) {
	if strings.TrimSpace(appID) == "" {
		return s.dataStore.EnsureDefaultApp(r.Context(), ownerID)
	}
	app, err := s.dataStore.GetApp(r.Context(), appID)
	if err != nil || app == nil || app.OwnerUserID != ownerID {
		return nil, errors.New("app not found")
	}
	return app, nil
}
