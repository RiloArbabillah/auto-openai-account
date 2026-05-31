package legacy

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

type RegisterInput struct {
	Mailbox        Mailbox
	Settings       Settings
	ProxyController ProxyController
	RegisterPass   string
	OTPFetcher     func(context.Context) (string, error)
	SkipTokenLogin bool
}

type RegisterResult struct {
	Email        string         `json:"email"`
	Password     string         `json:"password"`
	Name         string         `json:"name"`
	Birthdate    string         `json:"birthdate"`
	TokenPayload map[string]any `json:"token_json,omitempty"`
}

func RegisterOne(ctx context.Context, input RegisterInput) (*RegisterResult, error) {
	email := Clean(input.Mailbox.Email)
	logStep(email, "Registration flow started")
	if email == "" {
		return nil, fmt.Errorf("email is required")
	}
	password := Clean(input.RegisterPass)
	if password == "" {
		password = passwordForSettings(input.Settings)
	}
	w, err := newWorkerWithOTP(input.Settings.Proxy, email, input.OTPFetcher, input.ProxyController)
	if err != nil {
		return nil, err
	}
	defer w.close()

	logStep(email, "Step 1/8 platform authorize")
	if err := w.platformAuthorize(ctx, email); err != nil {
		return nil, err
	}
	logStep(email, "Step 2/8 submit registration password")
	if err := w.registerUser(ctx, email, password); err != nil {
		return nil, err
	}
	logStep(email, "Step 3/8 request email verification code")
	if err := w.sendOTP(ctx); err != nil {
		return nil, err
	}
	logStep(email, "Step 4/8 wait for and read email verification code")
	code, err := input.OTPFetcher(ctx)
	if err != nil {
		return nil, err
	}
	if code == "" {
		return nil, fmt.Errorf("verification code is empty")
	}
	logStep(email, "Step 5/8 verification code received code=%s, submitting", code)
	if err := w.validateOTP(ctx, code); err != nil {
		return nil, err
	}

	name := randomName()
	birthdate := randomBirthdate()
	logStep(email, "Step 6/8 create account profile name=%s birthdate=%s", name, birthdate)
	if err := w.createAccount(ctx, name, birthdate); err != nil {
		return nil, err
	}

	result := &RegisterResult{Email: email, Password: password, Name: name, Birthdate: birthdate}
	if input.SkipTokenLogin {
		logStep(email, "Registration flow complete, skipping token login")
		return result, nil
	}
	logStep(email, "Step 7/8 log in and exchange token")
	tokens, err := w.loginAndExchangeTokens(ctx, email, password)
	if err != nil {
		return nil, err
	}
	tokens["email"] = email
	tokens["password"] = password
	tokens["created_at"] = time.Now().UTC().Format(time.RFC3339Nano)
	result.TokenPayload = tokens
	logStep(email, "Step 8/8 registration complete, token acquired")
	return result, nil
}

func LoginOne(ctx context.Context, mailbox Mailbox, settings Settings, otpFetcher func(context.Context) (string, error), controller ProxyController) (map[string]any, error) {
	email := Clean(mailbox.Email)
	logStep(email, "Token refresh login flow started")
	password := firstNonEmpty(Clean(mailbox.RegisterPassword), Clean(mailbox.Password))
	if email == "" || password == "" {
		return nil, fmt.Errorf("email and password are required")
	}
	w, err := newWorkerWithOTP(settings.Proxy, email, otpFetcher, controller)
	if err != nil {
		return nil, err
	}
	defer w.close()
	tokens, err := w.loginAndExchangeTokens(ctx, email, password)
	if err != nil {
		return nil, err
	}
	tokens["email"] = email
	tokens["password"] = password
	tokens["created_at"] = time.Now().UTC().Format(time.RFC3339Nano)
	logStep(email, "Token refresh login flow completed")
	return tokens, nil
}

func passwordForSettings(settings Settings) string {
	if settings.PasswordMode == "fixed" && Clean(settings.FixedPassword) != "" {
		return Clean(settings.FixedPassword)
	}
	return randomPassword(16)
}

func compactTokenJSON(tokens map[string]any) string {
	if len(tokens) == 0 {
		return ""
	}
	data, err := json.Marshal(tokens)
	if err != nil {
		return ""
	}
	return string(data)
}
