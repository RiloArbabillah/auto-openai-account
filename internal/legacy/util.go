package legacy

import (
	"bytes"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func Clean(v any) string {
	return strings.TrimSpace(fmt.Sprint(ValueOr(v, "")))
}

func ValueOr(v any, fallback any) any {
	if v == nil {
		return fallback
	}
	return v
}

func StringMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func CopyMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func AsStringSlice(v any) []string {
	switch x := v.(type) {
	case []string:
		return x
	case []any:
		out := make([]string, 0, len(x))
		for _, item := range x {
			if s := Clean(item); s != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func AsMapSlice(v any) []map[string]any {
	switch x := v.(type) {
	case []map[string]any:
		return x
	case []any:
		out := make([]map[string]any, 0, len(x))
		for _, item := range x {
			if m, ok := item.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	default:
		return nil
	}
}

func ToInt(v any, fallback int) int {
	switch x := v.(type) {
	case int:
		return x
	case int64:
		return int(x)
	case float64:
		return int(x)
	case json.Number:
		n, err := x.Int64()
		if err == nil {
			return int(n)
		}
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(x))
		if err == nil {
			return n
		}
	}
	return fallback
}

func ToBool(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		switch strings.ToLower(strings.TrimSpace(x)) {
		case "1", "true", "yes", "on":
			return true
		}
		return false
	default:
		return v != nil
	}
}

func DecodeJSON(r io.Reader, out any) error {
	dec := json.NewDecoder(r)
	dec.UseNumber()
	return dec.Decode(out)
}

func NewUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func NewHex(n int) string {
	if n <= 0 {
		n = 16
	}
	buf := make([]byte, (n+1)/2)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)[:n]
}

func SHA256Hex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func SHA1Short(text string, n int) string {
	sum := sha1.Sum([]byte(text))
	hexed := hex.EncodeToString(sum[:])
	if n > 0 && n < len(hexed) {
		return hexed[:n]
	}
	return hexed
}

func RandomTokenURL(n int) string {
	if n <= 0 {
		n = 24
	}
	buf := make([]byte, n)
	_, _ = rand.Read(buf)
	return base64.RawURLEncoding.EncodeToString(buf)
}

func B64Encode(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

func B64Decode(text string) ([]byte, error) {
	if idx := strings.Index(text, ","); strings.HasPrefix(text, "data:") && idx >= 0 {
		text = text[idx+1:]
	}
	return base64.StdEncoding.DecodeString(strings.TrimSpace(text))
}

func CompactJSON(v any) string {
	data, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, data); err != nil {
		return string(data)
	}
	return buf.String()
}

func NowLocal() string {
	return time.Now().Format("2006-01-02 15:04:05")
}

func NowISO() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

var LogHook func(email, message string)

func logStep(email, format string, args ...any) {
	message := fmt.Sprintf(format, args...)
	if LogHook != nil {
		LogHook(Clean(email), message)
	}
	if Clean(email) != "" {
		fmt.Printf("[%s] [%s] %s\n", NowLocal(), Clean(email), message)
		return
	}
	fmt.Printf("[%s] %s\n", NowLocal(), message)
}

func shortSecretHash(value string) string {
	value = Clean(value)
	if value == "" {
		return "empty"
	}
	return SHA256Hex(value)[:10]
}

func ExplainError(message string) string {
	message = Clean(message)
	if message == "" {
		return ""
	}
	lower := strings.ToLower(message)
	var reason string
	switch {
	case strings.Contains(lower, "platform_authorize_entered_login_flow") || strings.Contains(lower, "/log-in/password"):
		reason = "Registration failed: OpenAI returned the login password page instead of the new account creation page. This usually means the mailbox was already registered, is tied to a partial account, or was routed to an existing login method. Try a mailbox that has never been registered, or switch to the token refresh login flow."
	case strings.Contains(lower, "otp timeout"):
		reason = "Verification code timed out: no valid 6-digit code was read from the mailbox INBOX within the configured time. Check the IMAP settings, mailbox access_token/password, whether the verification email arrived, whether it landed in spam, or increase the wait time."
	case strings.Contains(lower, "imap command failed") || strings.Contains(lower, "authenticate xoauth2") || strings.Contains(lower, "imap xoauth2 token is empty"):
		reason = "Mailbox login failed: IMAP authentication did not succeed. Check whether the mailbox access_token is valid, or switch IMAP authentication mode to password/auto and confirm the mailbox password works."
	case strings.Contains(lower, "send_otp_http_"):
		reason = "Failed to send the email verification code: the upstream service rejected the request. This may be caused by network issues, proxy issues, anti-abuse checks, or a broken registration session."
	case strings.Contains(lower, "validate_otp_http_"):
		reason = "Verification code validation failed: the code read from email was not accepted upstream. The code may have expired, may be stale, or the current registration session may already be invalid."
	case strings.Contains(lower, "user_register_http_"):
		reason = "Failed to submit the registration password: the upstream service rejected account creation. The mailbox domain, proxy environment, password policy, or anti-abuse checks may be the cause."
	case strings.Contains(lower, "create_account_http_"):
		reason = "Failed to create the account profile: the upstream service rejected the post-verification account creation step. This may be caused by anti-abuse checks, proxy environment, or mailbox domain restrictions."
	case strings.Contains(lower, "password_verify_http_"):
		reason = "Login password verification failed: the account password did not pass upstream validation. Confirm the saved registration password is correct."
	case strings.Contains(lower, "oauth_token_http_") || strings.Contains(lower, "token exchange"):
		reason = "Token exchange failed: upstream authorization succeeded but no token was returned normally. This may be caused by callback issues, proxy issues, or a broken session state."
	default:
		reason = "Operation failed: the program received an upstream or local process error, but no more specific explanation has been identified yet. Check the original error for troubleshooting."
	}
	return reason + "\nOriginal error: " + message
}

func AnonymizeToken(token any) string {
	value := Clean(token)
	if value == "" {
		return "token:empty"
	}
	return "token:" + SHA256Hex(value)[:10]
}

func ParseCommaList(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if item := strings.TrimSpace(part); item != "" {
			out = append(out, item)
		}
	}
	return out
}

func WriteJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(payload)
}
