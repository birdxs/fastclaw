package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/fastclaw-ai/fastclaw/internal/agent"
	"github.com/fastclaw-ai/fastclaw/internal/auth"
	"github.com/fastclaw-ai/fastclaw/internal/bus"
)

// chatCompletionRequest mirrors the OpenAI chat completion request.
//
// User is OpenAI's standard "end-user identifier" field. On an api_key
// request it names the app's end-user, exactly like the
// X-Fastclaw-End-User header: the end-user is a data namespace only.
// The agent is still resolved from the app; the end-user decides where
// the session history, USER.md and personal memory live. It never
// changes which agents the request may use.
type chatCompletionRequest struct {
	Model    string        `json:"model"`
	Messages []chatMessage `json:"messages"`
	Stream   *bool         `json:"stream,omitempty"`
	User     string        `json:"user,omitempty"`
	// AgentID is a fastclaw extension: lets the caller pick the agent
	// in the request body instead of (or in addition to) the
	// `x-fastclaw-agent-id` header. Body wins when both are set —
	// matches the pattern used for `user`. Optional.
	AgentID string `json:"agent_id,omitempty"`
	// Params is a fastclaw extension: a freeform structured-parameter
	// blob the calling app submits alongside the chat. Rendered into
	// a per-turn system message so the agent's LLM can honor it when
	// calling tools (e.g. a third-party app's "model selector" +
	// "settings" UI translate to {provider, aspect_ratio, n} here,
	// rather than the user typing those into the prompt). Scope is
	// per-request — params don't persist across turns. OpenAI clients
	// that don't know about this field are unaffected (omitempty).
	Params map[string]any `json:"params,omitempty"`
	// Images is a fastclaw extension: image attachments for the
	// current turn. Each entry is one of:
	//   - HTTPS URL: "https://example.com/photo.jpg" (must be
	//     reachable from the LLM provider; not validated here)
	//   - Data URL:  "data:image/png;base64,iVBORw0KGgo..."
	//
	// Accepted MIME types depend on the LLM model. Anthropic / OpenAI
	// vision models all support png, jpeg, webp; gif is hit-or-miss.
	// Per-image and total-request size limits are also model-side
	// (Anthropic ~5MB/image, OpenAI ~20MB) — fastclaw does not enforce
	// its own ceiling, the upstream provider returns the rejection.
	Images []string `json:"images,omitempty"`
	// ImageURLs is an accepted alias for Images. The web-facing chat
	// endpoint historically calls this field `imageUrls`; allowing it
	// here means a caller writing one client against both endpoints
	// doesn't get silently dropped attachments when they pick the
	// wrong name.
	ImageURLs []string `json:"imageUrls,omitempty"`
	// Attachments is the typed, general-purpose attachment field. Each
	// entry can carry an optional Name which is sanitized and used as
	// the on-disk filename so the LLM sees `report.pdf` instead of
	// `image_3jk7l_0.pdf`. Unlike Images / ImageURLs, entries here are
	// NOT inlined as vision content parts — they only land in
	// /workspace and reach the LLM via the `[Attached: /workspace/X]`
	// breadcrumb. Use Images / ImageURLs (not Attachments) when you
	// want the bytes shown directly to a vision model.
	Attachments []attachmentRequest `json:"attachments,omitempty"`
	// ProjectID optionally files the conversation under one of the
	// agent's projects (in the caller's namespace) so it shares that
	// project's workspace. Omit for a loose chat.
	ProjectID string `json:"project_id,omitempty"`
}

// attachmentRequest is the wire form of a single attachment.
type attachmentRequest struct {
	URL  string `json:"url"`
	Name string `json:"name,omitempty"`
}

// allAttachments flattens the three input shapes (Images, ImageURLs,
// Attachments) into one ordered slice for materialization into
// /workspace. Clients normally pick one; mixing is allowed.
func (r chatCompletionRequest) allAttachments() []agent.Attachment {
	n := len(r.Images) + len(r.ImageURLs) + len(r.Attachments)
	if n == 0 {
		return nil
	}
	out := make([]agent.Attachment, 0, n)
	for _, u := range r.Images {
		out = append(out, agent.Attachment{URL: u})
	}
	for _, u := range r.ImageURLs {
		out = append(out, agent.Attachment{URL: u})
	}
	for _, a := range r.Attachments {
		out = append(out, agent.Attachment{URL: a.URL, Name: a.Name})
	}
	return out
}

// inlineImageURLs returns just the URLs eligible for vision inline
// (PhotoURLs → image_url content blocks). Only Images and ImageURLs
// qualify — by contract they're caller-asserted images. The general
// Attachments field is excluded: feeding a PDF / zip URL through the
// vision channel returns HTTP 400 from upstream providers and sinks
// the whole turn. Attachments reach the LLM via the
// `[Attached: /workspace/<file>]` breadcrumb instead.
func (r chatCompletionRequest) inlineImageURLs() []string {
	if len(r.Images) == 0 && len(r.ImageURLs) == 0 {
		return nil
	}
	out := make([]string, 0, len(r.Images)+len(r.ImageURLs))
	out = append(out, r.Images...)
	out = append(out, r.ImageURLs...)
	return out
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// chatCompletionChunk is a single SSE chunk in streaming mode.
type chatCompletionChunk struct {
	ID      string        `json:"id"`
	Object  string        `json:"object"`
	Created int64         `json:"created"`
	Model   string        `json:"model"`
	Choices []chunkChoice `json:"choices"`
}

type chunkChoice struct {
	Index        int        `json:"index"`
	Delta        chunkDelta `json:"delta"`
	FinishReason *string    `json:"finish_reason"`
}

type chunkDelta struct {
	Role    string `json:"role,omitempty"`
	Content string `json:"content,omitempty"`
}

// chatCompletionResponse is the non-streaming response.
type chatCompletionResponse struct {
	ID      string             `json:"id"`
	Object  string             `json:"object"`
	Created int64              `json:"created"`
	Model   string             `json:"model"`
	Choices []completionChoice `json:"choices"`
	Usage   completionUsage    `json:"usage"`
}

type completionChoice struct {
	Index        int         `json:"index"`
	Message      chatMessage `json:"message"`
	FinishReason string      `json:"finish_reason"`
}

type completionUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// HandleChatCompletions handles POST /v1/chat/completions.
func (s *Server) HandleChatCompletions(w http.ResponseWriter, r *http.Request) {
	var req chatCompletionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "invalid request body")
		return
	}

	if len(req.Messages) == 0 {
		writeBadRequest(w, "messages is required")
		return
	}

	// OpenAI's `user` body field names the end-user, like the
	// X-Fastclaw-End-User header the auth middleware already applied.
	// The body is more specific to this call, so it wins when both are
	// present. Errors are non-fatal — the request continues in the
	// app's own namespace.
	if req.User != "" && s.authResolver != nil {
		if ident, ok := auth.FromContext(r.Context()); ok {
			if next, swErr := s.authResolver.SwitchToAppUser(r.Context(), ident, req.User); swErr == nil {
				r = r.WithContext(auth.WithIdentity(r.Context(), next))
			}
		}
	}
	ident, ok := auth.FromContext(r.Context())
	if !ok {
		writeUnauth(w, "unauthorized")
		return
	}

	// Body field beats header — same precedence as `user`. Lets app
	// callers send everything in one JSON without juggling headers.
	agentID := strings.TrimSpace(r.Header.Get("x-fastclaw-agent-id"))
	if req.AgentID != "" {
		agentID = strings.TrimSpace(req.AgentID)
	}
	// Strict: a named agent that isn't in this app is a 404 — never a
	// silent fallback to the default agent. Agents outside the api key's
	// ACL get the same 404 so their existence isn't revealed.
	ag, err := s.resolveChatAgent(r, agentID)
	if err != nil {
		if errors.Is(err, errAgentNotFound) {
			writeAgentNotFound(w)
			return
		}
		writeUnauth(w, err.Error())
		return
	}

	// Build session key from header
	sessionKey := r.Header.Get("x-fastclaw-session-key")
	if sessionKey == "" {
		sessionKey = "api-" + fmt.Sprintf("%d", time.Now().UnixNano())
	}

	projectID := strings.TrimSpace(req.ProjectID)
	if projectID != "" {
		if s.store == nil {
			writeAPIError(w, http.StatusNotFound, errTypeNotFound, codeProjectNotFound, "project not found")
			return
		}
		if p, perr := s.store.GetProject(r.Context(), ident.EffectiveUserID(), ag.Name(), projectID); perr != nil || p == nil {
			writeAPIError(w, http.StatusNotFound, errTypeNotFound, codeProjectNotFound, "project not found")
			return
		}
	}

	// Extract the last user message
	var userText string
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role == "user" {
			userText = req.Messages[i].Content
			break
		}
	}
	if userText == "" {
		writeBadRequest(w, "no user message found")
		return
	}

	// Materialize attached images into the agent's session workspace and
	// prepend the same `[Attached: /workspace/<file>]` breadcrumb the web
	// UI uses (web/src/app/agents/[id]/chat/page.tsx:639-645) so the wire
	// shape is identical across web and API entry points. Verbose "do not
	// probe" notes here actively backfire — models reflexively run
	// which/ls/file to "verify" the path when the prompt foregrounds it.
	// PhotoURLs is preserved so vision LLMs still see the image inline.
	// Attachments land in the project's workspace when the request names
	// a project, otherwise in the loose-chat scope.
	atts := req.allAttachments()
	attachmentPaths := ag.WriteSessionAttachments(r.Context(), sessionKey, projectID, atts)
	if len(attachmentPaths) > 0 {
		var b strings.Builder
		for _, p := range attachmentPaths {
			b.WriteString("[Attached: /workspace/")
			b.WriteString(p)
			b.WriteString("]\n")
		}
		b.WriteString(userText)
		userText = b.String()
	}

	// Build inbound message.
	// X-Fastclaw-Channel lets callers override the reply channel so
	// cron jobs created during this turn route through the right
	// adapter (e.g. "pinclaw" → plugin channel.send → Cloud API).
	channel := r.Header.Get("x-fastclaw-channel")
	if channel == "" {
		channel = "api"
	}
	// The chatter decides whose USER.md and personal memory the turn
	// reads and writes. With an end-user it's that end-user's app_user;
	// without one, every call shares the agent's own "api-user" memory.
	chatter := "api-user"
	if ident.EndUser != "" {
		chatter = ident.EffectiveUserID()
	}
	msg := bus.InboundMessage{
		Channel:   channel,
		ChatID:    sessionKey,
		UserID:    chatter,
		Text:      userText,
		PeerKind:  "dm",
		Params:    turnParams(req.Params),
		PhotoURLs: req.inlineImageURLs(),
		ProjectID: projectID,
	}

	slog.Info("chat completion request",
		"agent", ag.Name(),
		"session", sessionKey,
		"end_user", ident.EndUser,
		"stream", req.Stream != nil && *req.Stream,
	)

	model := ag.Model()
	if req.Model != "" {
		model = req.Model
	}
	chatID := fmt.Sprintf("chatcmpl-%d", time.Now().UnixNano())
	now := time.Now().Unix()

	isStream := req.Stream != nil && *req.Stream
	if isStream {
		s.streamResponseFromAgent(w, r, ag, msg, chatID, model, now)
	} else {
		// Get reply from agent
		reply := ag.HandleMessage(r.Context(), msg)
		s.fullResponse(w, reply, chatID, model, now)
	}
}

func (s *Server) streamResponseFromAgent(w http.ResponseWriter, r *http.Request, ag *agent.Agent, msg bus.InboundMessage, chatID, model string, created int64) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)

	flusher, ok := w.(http.Flusher)

	sr := ag.HandleMessageStream(r.Context(), msg)

	// Send role chunk
	s.writeSSEChunk(w, chatID, model, created, "assistant", "", nil)
	if ok {
		flusher.Flush()
	}

	// Forward chunks from StreamReader
	for {
		chunk, more := sr.Next()
		if chunk.Content != "" {
			s.writeSSEChunk(w, chatID, model, created, "", chunk.Content, nil)
			if ok {
				flusher.Flush()
			}
		}
		if chunk.Done || !more {
			break
		}
	}

	// Send finish chunk
	done := "stop"
	s.writeSSEChunk(w, chatID, model, created, "", "", &done)
	fmt.Fprint(w, "data: [DONE]\n\n")
	if ok {
		flusher.Flush()
	}
}

func (s *Server) writeSSEChunk(w http.ResponseWriter, id, model string, created int64, role, content string, finishReason *string) {
	chunk := chatCompletionChunk{
		ID:      id,
		Object:  "chat.completion.chunk",
		Created: created,
		Model:   model,
		Choices: []chunkChoice{
			{
				Index: 0,
				Delta: chunkDelta{
					Role:    role,
					Content: content,
				},
				FinishReason: finishReason,
			},
		},
	}
	data, _ := json.Marshal(chunk)
	fmt.Fprintf(w, "data: %s\n\n", data)
}

func (s *Server) fullResponse(w http.ResponseWriter, reply, chatID, model string, created int64) {
	resp := chatCompletionResponse{
		ID:      chatID,
		Object:  "chat.completion",
		Created: created,
		Model:   model,
		Choices: []completionChoice{
			{
				Index:        0,
				Message:      chatMessage{Role: "assistant", Content: reply},
				FinishReason: "stop",
			},
		},
		Usage: completionUsage{
			PromptTokens:     0,
			CompletionTokens: 0,
			TotalTokens:      0,
		},
	}
	writeJSON(w, http.StatusOK, resp)
}

// turnParams prepares the caller's params for the agent turn. A group
// chat's `speaker` ({"id", "name"}) moves to the internal
// __fastclawSpeaker key: the agent renders it as per-turn context so it
// can tell group members apart, it is never persisted, and it isn't
// echoed back as a tool parameter.
func turnParams(params map[string]any) map[string]any {
	speaker, ok := params["speaker"]
	if !ok {
		return params
	}
	out := make(map[string]any, len(params))
	for k, v := range params {
		if k != "speaker" {
			out[k] = v
		}
	}
	out[agent.SpeakerParamKey] = speaker
	return out
}
