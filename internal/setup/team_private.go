package setup

import (
	"fmt"
	"golang.org/x/text/unicode/norm"
	"regexp"
	"strings"
	"time"
)

type teamPrivateMessage struct {
	ID        string `json:"id"`
	Sender    string `json:"sender"`
	Recipient string `json:"recipient"`
	Content   string `json:"content,omitempty"`
	Timestamp int64  `json:"timestamp"`
}
type privateBlock struct{ to, content string }

// Withhold even an incomplete opening marker. Neither unknown destinations nor
// malformed/private-only replies may leak into public streaming or history.
func parseTeamPrivate(text string) (string, []privateBlock, bool) {
	lower := strings.ToLower(text)
	const open = "[[private:"
	const close = "[[/private]]"
	var public strings.Builder
	var blocks []privateBlock
	valid := true
	for cursor := 0; cursor < len(text); {
		relative := strings.Index(lower[cursor:], "[[private")
		if relative < 0 {
			tail := text[cursor:]
			held := 0
			for size := 1; size < len(open); size++ {
				if strings.HasSuffix(strings.ToLower(tail), open[:size]) {
					held = size
				}
			}
			public.WriteString(tail[:len(tail)-held])
			if held > 0 {
				valid = false
			}
			break
		}
		start := cursor + relative
		public.WriteString(text[cursor:start])
		h := strings.Index(lower[start:], "]]")
		if h < 0 {
			valid = false
			break
		}
		h += start
		e := strings.Index(lower[h+2:], close)
		if e < 0 {
			valid = false
			break
		}
		e += h + 2
		content := strings.TrimSpace(text[h+2 : e])
		if !strings.HasPrefix(lower[start:], open) || content == "" || strings.Contains(strings.ToLower(content), "[[private") || len([]rune(content)) > 12000 || len(blocks) >= 20 {
			valid = false
		} else {
			blocks = append(blocks, privateBlock{strings.TrimSpace(text[start+len(open) : h]), content})
		}
		cursor = e + len(close)
	}
	return public.String(), blocks, valid
}
func resolveTeamPrivate(text string, sender resolvedTeamMember, members []resolvedTeamMember, id string) ([]teamPrivateMessage, error) {
	_, blocks, valid := parseTeamPrivate(text)
	if !valid {
		return nil, fmt.Errorf("私信格式不完整，未发送")
	}
	var result []teamPrivateMessage
	for i, b := range blocks {
		recipient := ""
		if b.to == "human" {
			recipient = "human"
		} else {
			for _, m := range members {
				if b.to == m.AgentID || strings.EqualFold(norm.NFKC.String(b.to), norm.NFKC.String(m.Name)) {
					if recipient != "" {
						return nil, fmt.Errorf("私信收件人不唯一")
					}
					recipient = m.AgentID
				}
			}
		}
		if recipient == "" || recipient == sender.AgentID {
			return nil, fmt.Errorf("私信收件人无效，未发送")
		}
		result = append(result, teamPrivateMessage{ID: fmt.Sprintf("%s-private-%d", id, i), Sender: sender.AgentID, Recipient: recipient, Content: b.content, Timestamp: time.Now().UnixMilli()})
	}
	return result, nil
}

var teamReplyTokens = regexp.MustCompile("`+|<\\|split\\|>")

// Message separators may appear anywhere in prose, but code is literal text.
func splitTeamReply(text string) []string {
	return splitTeamReplyText(text, false)
}

func splitTeamReplyText(text string, streaming bool) []string {
	parts := []string{}
	lines := []string{}
	fence := ""
	inlineCode := ""
	flush := func() {
		if value := strings.TrimSpace(strings.Join(lines, "\n")); value != "" {
			parts = append(parts, value)
		}
		lines = nil
	}
	input := strings.Split(text, "\n")
	for i, line := range input {
		if match := teamFence.FindStringSubmatch(line); len(match) > 0 {
			marker := match[1]
			if fence == "" {
				fence = marker
			} else if marker[0] == fence[0] && len(marker) >= len(fence) {
				fence = ""
			}
			lines = append(lines, line)
			continue
		}
		if fence != "" {
			lines = append(lines, line)
			continue
		}
		start := 0
		for _, loc := range teamReplyTokens.FindAllStringIndex(line, -1) {
			token := line[loc[0]:loc[1]]
			if token[0] == '`' {
				if inlineCode == "" {
					inlineCode = token
				} else if inlineCode == token {
					inlineCode = ""
				}
			} else if inlineCode == "" {
				lines = append(lines, line[start:loc[0]])
				flush()
				start = loc[1]
			}
		}
		tail := line[start:]
		if streaming && inlineCode == "" && i == len(input)-1 {
			// Withhold a delimiter split across deltas, including an inline one.
			const separator = "<|split|>"
			for n := len(separator) - 1; n > 0; n-- {
				if strings.HasSuffix(tail, separator[:n]) {
					tail = tail[:len(tail)-n]
					break
				}
			}
		}
		lines = append(lines, tail)
	}
	flush()
	return parts
}
