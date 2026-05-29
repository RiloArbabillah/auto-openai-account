package legacy

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	codexOAuthClientID    = "app_EMoamEEZ73f0CkXaXp7hrann"
	codexOAuthRedirectURI = "http://localhost:1455/auth/callback"
	codexOAuthScopes      = "openid profile email offline_access api.connectors.read api.connectors.invoke"
)

type CodexSMSActivation struct {
	ID               string
	PhoneNumber      string
	CountryPhoneCode int
}

type CodexSMSProvider interface {
	GetNumber(context.Context) (*CodexSMSActivation, error)
	PollCode(context.Context, string) (string, error)
	Complete(context.Context, string) error
	Cancel(context.Context, string) error
}

type CodexLoginInput struct {
	Email                    string
	Password                 string
	Proxy                    string
	SMSProvider              CodexSMSProvider
	MaxPhoneAttempts         int
	PasswordVerifyRetries    int
	PasswordVerifyRetryDelay time.Duration
	Progress                 func(step string, index int, total int, message string)
}

type CodexLoginResult struct {
	TokenPayload map[string]any
	PhoneNumber  string
}

func CodexLogin(ctx context.Context, input CodexLoginInput) (*CodexLoginResult, error) {
	email := Clean(input.Email)
	password := Clean(input.Password)
	if email == "" || password == "" {
		return nil, fmt.Errorf("email and password are required")
	}

	w, err := newWorkerWithOTP(input.Proxy, email, nil)
	if err != nil {
		return nil, err
	}
	defer w.close()

	progress := input.Progress
	if progress == nil {
		progress = func(string, int, int, string) {}
	}
	attempts := input.MaxPhoneAttempts
	if attempts < 1 {
		attempts = 3
	}
	passwordVerifyRetries := input.PasswordVerifyRetries
	if passwordVerifyRetries < 1 {
		passwordVerifyRetries = 1
	}
	passwordVerifyRetryDelay := input.PasswordVerifyRetryDelay
	if passwordVerifyRetryDelay <= 0 {
		passwordVerifyRetryDelay = 10 * time.Second
	}

	codeVerifier, codeChallenge := generatePKCE()
	state := randomToken()
	progress("codex_authorize", 1, 8, "Creating Codex OAuth authorization session")
	status, payload, err := w.request(ctx, http.MethodGet, codexAuthorizeURL(state, codeChallenge), nil, w.navigateHeaders(authBase+"/"), true)
	if err != nil {
		return nil, fmt.Errorf("codex_authorize_request_failed: %w", err)
	}
	if status >= 400 {
		return nil, fmt.Errorf("codex_authorize_http_%d%s", status, responseDetail(payload))
	}

	progress("submit_email", 2, 8, "Submitting email and confirming login method")
	status, payload, err = w.submitLoginEmail(ctx, email)
	if err != nil {
		return nil, fmt.Errorf("submit_email_failed: %w", err)
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("submit_email_http_%d%s", status, responseDetail(payload))
	}

	continueURL, pageType := pageState(payload)
	progress("submit_email", 2, 8, fmt.Sprintf("Email submitted successfully, next step %s", firstNonEmpty(pageType, continueURL)))

	var phoneNumber string
	if isPasswordStep(continueURL, pageType) {
		for attempt := 1; attempt <= passwordVerifyRetries; attempt++ {
			progress("password_login", 3, 8, "Submitting OpenAI password")
			status, payload, err = w.codexVerifyPassword(ctx, password)
			if err != nil {
				return nil, fmt.Errorf("password_verify_failed: %w", err)
			}
			if status == http.StatusOK {
				break
			}
			if status != http.StatusUnauthorized || attempt == passwordVerifyRetries {
				return nil, fmt.Errorf("password_verify_http_%d%s", status, responseDetail(payload))
			}
			progress("password_login", 3, 8, fmt.Sprintf("Password verification did not pass yet, retrying after %s (%d/%d)", passwordVerifyRetryDelay, attempt+1, passwordVerifyRetries))
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(passwordVerifyRetryDelay):
			}
		}
		continueURL, pageType = pageState(payload)
		progress("password_login", 3, 8, fmt.Sprintf("Password verification passed, next step %s", firstNonEmpty(pageType, continueURL)))
	}

	if isAddPhoneStep(continueURL, pageType) {
		nextURL, nextType, boundPhone, err := w.codexBindPhone(ctx, input.SMSProvider, attempts, progress)
		if err != nil {
			return nil, err
		}
		continueURL, pageType = nextURL, nextType
		phoneNumber = boundPhone
	}

	progress("exchange_token", 8, 8, "Selecting workspace and exchanging Codex token")
	tokenPayload, err := w.exchangeCodexTokensFromContinueURL(ctx, continueURL, codeVerifier)
	if err != nil {
		return nil, err
	}
	tokenPayload["email"] = email
	tokenPayload["password"] = password
	tokenPayload["created_at"] = time.Now().UTC().Format(time.RFC3339Nano)
	if phoneNumber != "" {
		tokenPayload["phone_number"] = phoneNumber
	}
	progress("codex_complete", 8, 8, "Codex auth login flow completed")
	return &CodexLoginResult{TokenPayload: tokenPayload, PhoneNumber: phoneNumber}, nil
}

func codexAuthorizeURL(state, codeChallenge string) string {
	params := url.Values{
		"response_type":              {"code"},
		"client_id":                  {codexOAuthClientID},
		"redirect_uri":               {codexOAuthRedirectURI},
		"scope":                      {codexOAuthScopes},
		"state":                      {state},
		"code_challenge":             {codeChallenge},
		"code_challenge_method":      {"S256"},
		"id_token_add_organizations": {"true"},
		"codex_cli_simplified_flow":  {"true"},
	}
	return authBase + "/oauth/authorize?" + params.Encode()
}

func pageState(payload map[string]any) (string, string) {
	page := StringMap(payload["page"])
	return Clean(payload["continue_url"]), Clean(page["type"])
}

func isPasswordStep(continueURL, pageType string) bool {
	return pageType == "login_password" || strings.Contains(continueURL, "/log-in/password")
}

func isAddPhoneStep(continueURL, pageType string) bool {
	return pageType == "add_phone" || strings.Contains(continueURL, "/add-phone")
}

func (w *worker) codexVerifyPassword(ctx context.Context, password string) (int, map[string]any, error) {
	headers := w.jsonHeaders(authBase + "/log-in/password")
	token, err := w.buildSentinelToken(ctx, "password_verify")
	if err != nil {
		return 0, nil, err
	}
	headers["openai-sentinel-token"] = token
	return w.request(ctx, http.MethodPost, authBase+"/api/accounts/password/verify", map[string]any{
		"password": password,
	}, headers, false)
}

func (w *worker) codexBindPhone(ctx context.Context, provider CodexSMSProvider, maxAttempts int, progress func(string, int, int, string)) (string, string, string, error) {
	if provider == nil {
		return "", "", "", fmt.Errorf("sms provider is required for codex phone verification")
	}
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		progress("add_phone", 4, 8, fmt.Sprintf("Acquiring phone number, attempt %d/%d", attempt, maxAttempts))
		activation, err := provider.GetNumber(ctx)
		if err != nil {
			lastErr = err
			progress("add_phone", 4, 8, phoneRetryMessage(attempt, maxAttempts, fmt.Sprintf("Failed to acquire phone number: %v", err)))
			continue
		}
		if activation == nil || Clean(activation.ID) == "" || Clean(activation.PhoneNumber) == "" {
			lastErr = fmt.Errorf("sms provider returned empty activation")
			progress("add_phone", 4, 8, phoneRetryMessage(attempt, maxAttempts, "SMS provider returned an empty phone number or activation ID"))
			continue
		}
		phoneNumber := normalizeCodexPhoneNumber(activation.PhoneNumber, activation.CountryPhoneCode)
		if phoneNumber == "" {
			_ = provider.Cancel(ctx, activation.ID)
			lastErr = fmt.Errorf("sms provider returned invalid phone number")
			progress("add_phone", 4, 8, phoneRetryMessage(attempt, maxAttempts, fmt.Sprintf("SMS provider returned an invalid phone number format: %s", activation.PhoneNumber)))
			continue
		}

		progress("add_phone", 4, 8, fmt.Sprintf("Phone number %s acquired, submitting to OpenAI", phoneNumber))
		status, payload, err := w.codexSubmitPhone(ctx, phoneNumber)
		if err != nil {
			_ = provider.Cancel(ctx, activation.ID)
			lastErr = fmt.Errorf("submit_phone_failed: %w", err)
			progress("add_phone", 4, 8, phoneRetryMessage(attempt, maxAttempts, fmt.Sprintf("Submit phone request failed: %v", err)))
			continue
		}
		if status != http.StatusOK {
			_ = provider.Cancel(ctx, activation.ID)
			lastErr = fmt.Errorf("submit_phone_http_%d%s", status, responseDetail(payload))
			progress("add_phone", 4, 8, phoneRetryMessage(attempt, maxAttempts, "Phone number rejected by OpenAI: "+phoneSubmitFailureReason(status, payload)))
			continue
		}

		progress("phone_verification", 5, 8, "Phone number submitted, waiting for SMS verification code")
		code, err := provider.PollCode(ctx, activation.ID)
		if err != nil {
			_ = provider.Cancel(ctx, activation.ID)
			lastErr = err
			progress("phone_verification", 5, 8, phoneRetryMessage(attempt, maxAttempts, fmt.Sprintf("Failed to fetch SMS verification code: %v", err)))
			continue
		}
		if Clean(code) == "" {
			_ = provider.Cancel(ctx, activation.ID)
			lastErr = fmt.Errorf("sms code is empty")
			progress("phone_verification", 5, 8, phoneRetryMessage(attempt, maxAttempts, "SMS provider returned an empty verification code"))
			continue
		}

		progress("phone_verification", 6, 8, "SMS verification code received, submitting for validation")
		status, payload, err = w.codexSubmitPhoneOTP(ctx, Clean(code))
		if err != nil {
			_ = provider.Cancel(ctx, activation.ID)
			lastErr = err
			progress("phone_verification", 6, 8, phoneRetryMessage(attempt, maxAttempts, fmt.Sprintf("Submit SMS verification code request failed: %v", err)))
			continue
		}
		if status != http.StatusOK {
			_ = provider.Cancel(ctx, activation.ID)
			lastErr = fmt.Errorf("phone_otp_http_%d%s", status, responseDetail(payload))
			progress("phone_verification", 6, 8, phoneRetryMessage(attempt, maxAttempts, fmt.Sprintf("SMS verification code rejected by OpenAI: HTTP %d%s", status, responseDetail(payload))))
			continue
		}
		_ = provider.Complete(ctx, activation.ID)
		nextURL, pageType := pageState(payload)
		progress("phone_verification", 7, 8, "Phone number verified successfully")
		return nextURL, pageType, phoneNumber, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("phone verification failed")
	}
	return "", "", "", fmt.Errorf("failed to verify phone after %d attempts: %w", maxAttempts, lastErr)
}

func (w *worker) codexSubmitPhone(ctx context.Context, phoneNumber string) (int, map[string]any, error) {
	return w.request(ctx, http.MethodPost, authBase+"/api/accounts/add-phone/send", map[string]any{
		"phone_number": phoneNumber,
	}, w.jsonHeaders(authBase+"/add-phone"), false)
}

func phoneRetryMessage(attempt, maxAttempts int, reason string) string {
	if attempt < maxAttempts {
		return fmt.Sprintf("%s. Cancelled the current phone number and preparing to try another one (%d/%d next)", reason, attempt+1, maxAttempts)
	}
	return fmt.Sprintf("%s. Cancelled the current phone number and reached the maximum phone attempts (%d/%d)", reason, attempt, maxAttempts)
}

func phoneSubmitFailureReason(status int, payload map[string]any) string {
	errPayload := StringMap(payload["error"])
	code := Clean(errPayload["code"])
	message := Clean(errPayload["message"])
	switch {
	case code != "" && message != "":
		return fmt.Sprintf("HTTP %d, %s: %s", status, code, message)
	case code != "":
		return fmt.Sprintf("HTTP %d, %s", status, code)
	case message != "":
		return fmt.Sprintf("HTTP %d, %s", status, message)
	default:
		return fmt.Sprintf("HTTP %d%s", status, responseDetail(payload))
	}
}

func (w *worker) codexSubmitPhoneOTP(ctx context.Context, code string) (int, map[string]any, error) {
	return w.request(ctx, http.MethodPost, authBase+"/api/accounts/phone-otp/validate", map[string]any{
		"code": code,
	}, w.jsonHeaders(authBase+"/phone-verification"), false)
}

func (w *worker) exchangeCodexTokensFromContinueURL(ctx context.Context, continueURL, codeVerifier string) (map[string]any, error) {
	if continueURL == "" {
		continueURL = authBase + "/sign-in-with-chatgpt/codex/consent"
	}
	code, err := w.followConsentForCode(ctx, continueURL)
	if err != nil {
		return nil, err
	}
	if code == "" {
		return nil, fmt.Errorf("codex token exchange callback code not found")
	}
	status, tokenPayload, err := w.requestForm(ctx, authBase+"/oauth/token", url.Values{
		"grant_type":    []string{"authorization_code"},
		"code":          []string{code},
		"redirect_uri":  []string{codexOAuthRedirectURI},
		"client_id":     []string{codexOAuthClientID},
		"code_verifier": []string{codeVerifier},
	})
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("codex_oauth_token_http_%d", status)
	}
	accessToken := Clean(tokenPayload["access_token"])
	refreshToken := Clean(tokenPayload["refresh_token"])
	idToken := Clean(tokenPayload["id_token"])
	if accessToken == "" || refreshToken == "" || idToken == "" {
		return nil, fmt.Errorf("codex token exchange response missing access_token, refresh_token, or id_token")
	}
	return tokenPayload, nil
}

func normalizeCodexPhoneNumber(phone string, countryPhoneCode int) string {
	phone = strings.TrimSpace(phone)
	if phone == "" {
		return ""
	}
	var digits strings.Builder
	for _, r := range phone {
		if r >= '0' && r <= '9' {
			digits.WriteRune(r)
		}
	}
	value := digits.String()
	if value == "" {
		return ""
	}
	if countryPhoneCode > 0 {
		prefix := strconv.Itoa(countryPhoneCode)
		if !strings.HasPrefix(value, prefix) {
			value = prefix + value
		}
	}
	return "+" + value
}
