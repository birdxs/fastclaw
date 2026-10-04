package agent

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/fastclaw-ai/fastclaw/internal/provider"
)

// DecideGroup runs a tool-free, stateless coordination call with this member's
// configured provider/model. It never reads or appends private/member history.
func (a *Agent) DecideGroup(ctx context.Context, scope, prompt string) (string, error) {
	if a.provider == nil {
		return "", fmt.Errorf("group coordinator has no provider")
	}
	started := time.Now()
	response, err := a.provider.Chat(ctx, []provider.Message{{Role: "user", Content: prompt}}, nil, a.model, 2048, 0)
	if err != nil {
		return "", err
	}
	if response == nil {
		return "", fmt.Errorf("empty coordination response")
	}
	a.meterTokens(ctx, scope, response.Usage, time.Since(started).Milliseconds())
	if len(response.ToolCalls) > 0 {
		return "", fmt.Errorf("coordination must not call tools")
	}
	if len(response.Content) > 16000 {
		return "", fmt.Errorf("coordination response too large")
	}
	return strings.TrimSpace(response.Content), nil
}

// DeliverGroupPrivate creates a separate direct inbox; it does not publish the
// private body to the group's event stream or to other members' sessions.
func (a *Agent) DeliverGroupPrivate(ctx context.Context, sessionID, userID, groupName, content string) {
	sess := a.sessions.Get("web", "", sessionID, "")
	sess.SetChatter(userID)
	sess.Append(provider.Message{Role: "assistant", Content: "来自群聊「" + groupName + "」的私信：\n\n" + content, Timestamp: time.Now().UnixMilli()})
}
