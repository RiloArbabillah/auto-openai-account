package runner

import (
	"context"
	"fmt"
	"math/rand"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/79E/auto-openai-account/internal/codex"
	"github.com/79E/auto-openai-account/internal/domain"
	"github.com/79E/auto-openai-account/internal/legacy"
	"github.com/79E/auto-openai-account/internal/smsbiz"
	"github.com/79E/auto-openai-account/internal/storage"
)

type Runner struct {
	store  *storage.Store
	mu     sync.Mutex
	cancel context.CancelFunc
	subs   map[int64]map[chan domain.RuntimeLog]struct{}
	active map[string]activeLogContext
	otp    map[int64]chan string
}

type activeLogContext struct {
	JobID     int64
	MailboxID int64
	Email     string
	Proxy     string
}

var roundRobinCounter uint64

func New(store *storage.Store) *Runner {
	r := &Runner{store: store, subs: map[int64]map[chan domain.RuntimeLog]struct{}{}, active: map[string]activeLogContext{}, otp: map[int64]chan string{}}
	legacy.LogHook = r.handleLegacyLog
	return r
}

func (r *Runner) Start(count int, flow string, smsConfigName string) (domain.RegisterJob, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	flow, err := normalizeRegisterFlow(flow)
	if err != nil {
		return domain.RegisterJob{}, err
	}
	running, err := r.store.RunningJobExists()
	if err != nil {
		return domain.RegisterJob{}, err
	}
	if running || r.cancel != nil {
		return domain.RegisterJob{}, fmt.Errorf("register job is already running")
	}
	settings, err := r.store.LoadSettings()
	if err != nil {
		return domain.RegisterJob{}, err
	}
	if flow == domain.JobTypeRegisterCodex {
		if _, err := requireSMSConfig(settings, smsConfigName); err != nil {
			return domain.RegisterJob{}, err
		}
	}
	available, err := r.store.CountMailboxesByStatus(domain.MailboxStatusNew)
	if err != nil {
		return domain.RegisterJob{}, err
	}
	if count < 1 {
		return domain.RegisterJob{}, fmt.Errorf("count must be greater than 0")
	}
	if count > available {
		return domain.RegisterJob{}, fmt.Errorf("count exceeds new mailbox count: %d", available)
	}
	items, err := r.store.PickNewMailboxes(count)
	if err != nil {
		return domain.RegisterJob{}, err
	}
	job, err := r.store.CreateTypedJob(flow, count, items)
	if err != nil {
		return domain.RegisterJob{}, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	go r.runRegister(ctx, job.ID, items, flow, smsConfigName)
	return job, nil
}

func (r *Runner) StartLogin(ids []int64, flow string, smsConfigName string) (domain.RegisterJob, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	flow, err := normalizeLoginFlow(flow)
	if err != nil {
		return domain.RegisterJob{}, err
	}
	running, err := r.store.RunningJobExists()
	if err != nil {
		return domain.RegisterJob{}, err
	}
	if running || r.cancel != nil {
		return domain.RegisterJob{}, fmt.Errorf("job is already running")
	}
	if len(ids) == 0 {
		return domain.RegisterJob{}, fmt.Errorf("mailbox_ids is required")
	}
	items, err := r.store.PickMailboxesByIDs(ids)
	if err != nil {
		return domain.RegisterJob{}, err
	}
	if len(items) == 0 {
		return domain.RegisterJob{}, fmt.Errorf("no mailboxes found")
	}
	settings, err := r.store.LoadSettings()
	if err != nil {
		return domain.RegisterJob{}, err
	}
	if flow == domain.JobTypeCodexLogin {
		if _, err := requireSMSConfig(settings, smsConfigName); err != nil {
			return domain.RegisterJob{}, err
		}
	}
	for _, item := range items {
		if mailboxLoginPassword(item) == "" {
			return domain.RegisterJob{}, fmt.Errorf("mailbox %s does not have a password for login", item.Email)
		}
	}
	job, err := r.store.CreateTypedJob(flow, len(items), items)
	if err != nil {
		return domain.RegisterJob{}, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	go r.runLogin(ctx, job.ID, items, flow, smsConfigName)
	return job, nil
}

func (r *Runner) Stop(jobID int64) error {
	r.mu.Lock()
	if r.cancel != nil {
		r.cancel()
	}
	r.mu.Unlock()
	r.log(domain.RuntimeLog{JobID: jobID, Level: "info", Step: "stopped", Message: "Job stopped manually"})
	return r.store.StopJob(jobID)
}

func (r *Runner) Subscribe(jobID int64) (<-chan domain.RuntimeLog, func()) {
	ch := make(chan domain.RuntimeLog, 32)
	r.mu.Lock()
	if r.subs[jobID] == nil {
		r.subs[jobID] = map[chan domain.RuntimeLog]struct{}{}
	}
	r.subs[jobID][ch] = struct{}{}
	r.mu.Unlock()
	return ch, func() {
		r.mu.Lock()
		delete(r.subs[jobID], ch)
		close(ch)
		r.mu.Unlock()
	}
}

func (r *Runner) runRegister(ctx context.Context, jobID int64, items []domain.Mailbox, flow string, smsConfigName string) {
	defer func() {
		r.mu.Lock()
		r.cancel = nil
		r.mu.Unlock()
	}()
	settings, err := r.store.LoadSettings()
	if err != nil {
		_ = r.store.RecalculateJob(jobID, domain.JobStatusFailed)
		return
	}
	concurrency := settings.RegisterConcurrency
	jobs := make(chan domain.Mailbox)
	var wg sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for mailbox := range jobs {
				select {
				case <-ctx.Done():
					return
				default:
				}
				r.runRegisterOne(ctx, jobID, mailbox, settings, flow, smsConfigName)
			}
		}(i)
	}
	for _, mailbox := range items {
		select {
		case <-ctx.Done():
			close(jobs)
			wg.Wait()
			_ = r.store.RecalculateJob(jobID, domain.JobStatusStopped)
			return
		case jobs <- mailbox:
		}
	}
	close(jobs)
	wg.Wait()
	status := domain.JobStatusFinished
	if ctx.Err() != nil {
		status = domain.JobStatusStopped
	}
	_ = r.store.RecalculateJob(jobID, status)
}

func (r *Runner) runLogin(ctx context.Context, jobID int64, items []domain.Mailbox, flow string, smsConfigName string) {
	defer func() {
		r.mu.Lock()
		r.cancel = nil
		r.mu.Unlock()
	}()
	settings, err := r.store.LoadSettings()
	if err != nil {
		_ = r.store.RecalculateJob(jobID, domain.JobStatusFailed)
		return
	}
	concurrency := settings.RegisterConcurrency
	jobs := make(chan domain.Mailbox)
	var wg sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for mailbox := range jobs {
				select {
				case <-ctx.Done():
					return
				default:
				}
				if flow == domain.JobTypeCodexLogin {
					r.runCodexLoginOne(ctx, jobID, mailbox, settings, smsConfigName)
					continue
				}
				r.runLoginOne(ctx, jobID, mailbox, settings)
			}
		}()
	}
	for _, mailbox := range items {
		select {
		case <-ctx.Done():
			close(jobs)
			wg.Wait()
			_ = r.store.RecalculateJob(jobID, domain.JobStatusStopped)
			return
		case jobs <- mailbox:
		}
	}
	close(jobs)
	wg.Wait()
	status := domain.JobStatusFinished
	if ctx.Err() != nil {
		status = domain.JobStatusStopped
	}
	_ = r.store.RecalculateJob(jobID, status)
}

func (r *Runner) runRegisterOne(ctx context.Context, jobID int64, mailbox domain.Mailbox, settings domain.Settings, flow string, smsConfigName string) {
	started := time.Now()
	proxy := pickProxy(settings)
	_ = r.store.StartJobItem(jobID, mailbox.ID)
	r.setActive(mailbox.Email, activeLogContext{JobID: jobID, MailboxID: mailbox.ID, Email: mailbox.Email, Proxy: proxy})
	defer r.clearActive(mailbox.Email)
	legacyMailbox := legacy.MailboxFromDomain(mailbox)
	legacySettings := legacy.SettingsFromDomain(settings, proxy)
	registerPass := legacyPasswordForSettings(settings)
	skipTokenLogin := flow == domain.JobTypeRegister
	otpFetcher := r.otpFetcher(mailbox.ID, legacySettings, legacyMailbox, started)
	result, err := legacy.RegisterOne(ctx, legacy.RegisterInput{Mailbox: legacyMailbox, Settings: legacySettings, RegisterPass: registerPass, OTPFetcher: otpFetcher, SkipTokenLogin: skipTokenLogin})
	duration := time.Since(started)
	if ctx.Err() != nil {
		_ = r.store.UpdateJobItem(jobID, mailbox.ID, "failed", "Job stopped manually", duration)
		_ = r.store.RecalculateJob(jobID, domain.JobStatusStopped)
		return
	}
	if err != nil {
		message := legacy.ExplainError(err.Error())
		_ = r.store.MarkMailboxAbnormal(mailbox.ID, message)
		_ = r.store.UpdateJobItem(jobID, mailbox.ID, "failed", message, duration)
		_ = r.store.RecalculateJob(jobID, "")
		r.log(domain.RuntimeLog{JobID: jobID, MailboxID: mailbox.ID, Email: mailbox.Email, Level: "error", Step: "failed", Message: message})
		return
	}
	_ = r.store.MarkMailboxRegistered(mailbox.ID, result.Password, legacy.CompactTokenJSON(result.TokenPayload))
	if flow == domain.JobTypeRegisterCodex {
		updated := mailbox
		updated.RegisterPassword = result.Password
		r.runCodexLoginAfterStarted(ctx, jobID, updated, settings, proxy, smsConfigName, started, "register_codex")
		return
	}
	_ = r.store.UpdateJobItem(jobID, mailbox.ID, "success", "", duration)
	_ = r.store.RecalculateJob(jobID, "")
	message := "Registration flow completed"
	if flow == domain.JobTypeRegisterLogin {
		message = "Registration and standard login flow completed"
	}
	r.log(domain.RuntimeLog{JobID: jobID, MailboxID: mailbox.ID, Email: mailbox.Email, Level: "info", Step: "complete", StepIndex: 8, StepTotal: 8, Message: message})
}

func (r *Runner) LoginMailbox(mailbox domain.Mailbox, settings domain.Settings) error {
	if err := r.store.MarkMailboxLogining(mailbox.ID); err != nil {
		return err
	}
	go func() {
		started := time.Now()
		proxy := pickProxy(settings)
		r.setActive(mailbox.Email, activeLogContext{MailboxID: mailbox.ID, Email: mailbox.Email, Proxy: proxy})
		defer r.clearActive(mailbox.Email)
		legacyMailbox := legacy.MailboxFromDomain(mailbox)
		legacySettings := legacy.SettingsFromDomain(settings, proxy)
		otpFetcher := r.otpFetcher(mailbox.ID, legacySettings, legacyMailbox, started)
		tokens, err := legacy.LoginOne(context.Background(), legacyMailbox, legacySettings, otpFetcher)
		if err != nil {
			_ = r.store.MarkMailboxLoginResult(mailbox.ID, "", legacy.ExplainError(err.Error()))
			r.log(domain.RuntimeLog{MailboxID: mailbox.ID, Email: mailbox.Email, Level: "error", Step: "login_failed", Message: legacy.ExplainError(err.Error())})
			return
		}
		_ = r.store.MarkMailboxLoginResult(mailbox.ID, legacy.CompactTokenJSON(tokens), "")
		r.log(domain.RuntimeLog{MailboxID: mailbox.ID, Email: mailbox.Email, Level: "info", Step: "login_complete", Message: "Token refresh login flow completed"})
	}()
	return nil
}

func (r *Runner) runLoginOne(ctx context.Context, jobID int64, mailbox domain.Mailbox, settings domain.Settings) {
	started := time.Now()
	proxy := pickProxy(settings)
	_ = r.store.StartJobItem(jobID, mailbox.ID)
	_ = r.store.MarkMailboxLogining(mailbox.ID)
	r.setActive(mailbox.Email, activeLogContext{JobID: jobID, MailboxID: mailbox.ID, Email: mailbox.Email, Proxy: proxy})
	defer r.clearActive(mailbox.Email)
	legacyMailbox := legacy.MailboxFromDomain(mailbox)
	legacySettings := legacy.SettingsFromDomain(settings, proxy)
	otpFetcher := r.otpFetcher(mailbox.ID, legacySettings, legacyMailbox, started)
	tokens, err := legacy.LoginOne(ctx, legacyMailbox, legacySettings, otpFetcher)
	duration := time.Since(started)
	if ctx.Err() != nil {
		_ = r.store.UpdateJobItem(jobID, mailbox.ID, "failed", "Job stopped manually", duration)
		_ = r.store.RecalculateJob(jobID, domain.JobStatusStopped)
		return
	}
	if err != nil {
		message := legacy.ExplainError(err.Error())
		_ = r.store.MarkMailboxLoginResult(mailbox.ID, "", message)
		_ = r.store.UpdateJobItem(jobID, mailbox.ID, "failed", message, duration)
		_ = r.store.RecalculateJob(jobID, "")
		r.log(domain.RuntimeLog{JobID: jobID, MailboxID: mailbox.ID, Email: mailbox.Email, Level: "error", Step: "login_failed", Message: message})
		return
	}
	_ = r.store.MarkMailboxLoginResult(mailbox.ID, legacy.CompactTokenJSON(tokens), "")
	_ = r.store.UpdateJobItem(jobID, mailbox.ID, "success", "", duration)
	_ = r.store.RecalculateJob(jobID, "")
	r.log(domain.RuntimeLog{JobID: jobID, MailboxID: mailbox.ID, Email: mailbox.Email, Level: "info", Step: "login_complete", Message: "Token refresh login flow completed"})
}

func (r *Runner) runCodexLoginOne(ctx context.Context, jobID int64, mailbox domain.Mailbox, settings domain.Settings, smsConfigName string) {
	started := time.Now()
	proxy := pickProxy(settings)
	_ = r.store.StartJobItem(jobID, mailbox.ID)
	_ = r.store.MarkMailboxLogining(mailbox.ID)
	r.setActive(mailbox.Email, activeLogContext{JobID: jobID, MailboxID: mailbox.ID, Email: mailbox.Email, Proxy: proxy})
	defer r.clearActive(mailbox.Email)
	r.log(domain.RuntimeLog{JobID: jobID, MailboxID: mailbox.ID, Email: mailbox.Email, Level: "info", Step: "codex_start", StepIndex: 1, StepTotal: 8, Message: "Codex auth login flow started"})
	r.runCodexLoginAfterStarted(ctx, jobID, mailbox, settings, proxy, smsConfigName, started, "codex")
}

func (r *Runner) runCodexLoginAfterStarted(ctx context.Context, jobID int64, mailbox domain.Mailbox, settings domain.Settings, proxy string, smsConfigName string, started time.Time, prefix string) {
	duration := time.Since(started)
	if ctx.Err() != nil {
		_ = r.store.UpdateJobItem(jobID, mailbox.ID, "failed", "Job stopped manually", duration)
		_ = r.store.RecalculateJob(jobID, domain.JobStatusStopped)
		return
	}
	smsConfig, err := requireSMSConfig(settings, smsConfigName)
	if err != nil {
		r.failCodexJobItem(jobID, mailbox, prefix, err.Error(), duration)
		return
	}
	provider, err := smsbiz.NewProvider(smsbiz.Config{
		Platform:  smsConfig.Platform,
		APIKey:    smsConfig.APIKey,
		ServiceID: smsConfig.ServiceID,
		CountryID: smsConfig.CountryID,
		MaxPrice:  smsConfig.MaxPrice,
	})
	if err != nil {
		r.failCodexJobItem(jobID, mailbox, prefix, fmt.Sprintf("SMS provider initialization failed: %v", err), duration)
		return
	}
	defer provider.Close()
	progressCh := make(chan codex.LoginProgress, 32)
	progressDone := make(chan struct{})
	go func() {
		defer close(progressDone)
		for progress := range progressCh {
			step := string(progress.Step)
			if step == "" {
				step = prefix + "_progress"
			}
			_ = r.store.MarkMailboxStep(mailbox.ID, domain.MailboxStatusLogining, step, progress.StepIndex, progress.StepTotal, proxy)
			r.log(domain.RuntimeLog{JobID: jobID, MailboxID: mailbox.ID, Email: mailbox.Email, Level: "info", Step: step, StepIndex: progress.StepIndex, StepTotal: progress.StepTotal, Message: progress.Message})
		}
	}()
	loginOpts := codex.LoginOptions{
		Email:                    mailbox.Email,
		Password:                 mailboxLoginPassword(mailbox),
		Proxy:                    proxy,
		SMSProvider:              &codexSMSProvider{provider: provider, config: smsConfig},
		ProgressChan:             progressCh,
		MaxPhoneAttempts:         3,
		PasswordVerifyRetries:    codexPasswordVerifyRetries(prefix),
		PasswordVerifyRetryDelay: 10 * time.Second,
	}
	result, err := codex.LoginWithCodex(ctx, loginOpts)
	close(progressCh)
	<-progressDone
	duration = time.Since(started)
	if ctx.Err() != nil {
		_ = r.store.UpdateJobItem(jobID, mailbox.ID, "failed", "Job stopped manually", duration)
		_ = r.store.RecalculateJob(jobID, domain.JobStatusStopped)
		return
	}
	if err != nil {
		r.failCodexJobItem(jobID, mailbox, prefix, err.Error(), duration)
		return
	}
	if result.PhoneNumber != "" {
		_ = r.store.UpdateMailboxPhoneNumber(mailbox.ID, result.PhoneNumber)
	}
	_ = r.store.MarkMailboxLoginResult(mailbox.ID, result.TokenJSON, "")
	_ = r.store.UpdateJobItem(jobID, mailbox.ID, "success", "", duration)
	_ = r.store.RecalculateJob(jobID, "")
	r.log(domain.RuntimeLog{JobID: jobID, MailboxID: mailbox.ID, Email: mailbox.Email, Level: "info", Step: "codex_complete", StepIndex: 8, StepTotal: 8, Message: "Codex auth login flow completed"})
}

func generateRandomPassword() string {
	length := 16
	upper := "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	lower := "abcdefghijklmnopqrstuvwxyz"
	digits := "0123456789"
	special := "!@#$%"
	all := upper + lower + digits + special
	value := []byte{
		upper[rand.Intn(len(upper))],
		lower[rand.Intn(len(lower))],
		digits[rand.Intn(len(digits))],
		special[rand.Intn(len(special))],
	}
	for len(value) < length {
		value = append(value, all[rand.Intn(len(all))])
	}
	for i := range value {
		j := rand.Intn(i + 1)
		value[i], value[j] = value[j], value[i]
	}
	return string(value)
}

func normalizeRegisterFlow(flow string) (string, error) {
	switch strings.TrimSpace(flow) {
	case "":
		return domain.JobTypeRegisterLogin, nil
	case domain.JobTypeRegister, domain.JobTypeRegisterLogin, domain.JobTypeRegisterCodex:
		return strings.TrimSpace(flow), nil
	default:
		return "", fmt.Errorf("unsupported register flow: %s", flow)
	}
}

func normalizeLoginFlow(flow string) (string, error) {
	switch strings.TrimSpace(flow) {
	case "":
		return domain.JobTypeLogin, nil
	case domain.JobTypeLogin, domain.JobTypeCodexLogin:
		return strings.TrimSpace(flow), nil
	default:
		return "", fmt.Errorf("unsupported login flow: %s", flow)
	}
}

func requireSMSConfig(settings domain.Settings, name string) (domain.SMSConfig, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return domain.SMSConfig{}, fmt.Errorf("sms_config_name is required for codex flow")
	}
	for _, cfg := range settings.SMSConfigs {
		if strings.EqualFold(strings.TrimSpace(cfg.Name), name) {
			if strings.TrimSpace(cfg.APIKey) == "" {
				return domain.SMSConfig{}, fmt.Errorf("sms config %q missing api_key", name)
			}
			return cfg, nil
		}
	}
	return domain.SMSConfig{}, fmt.Errorf("sms config %q not found", name)
}

func mailboxLoginPassword(mailbox domain.Mailbox) string {
	if password := strings.TrimSpace(mailbox.RegisterPassword); password != "" {
		return password
	}
	return strings.TrimSpace(mailbox.Password)
}

func codexPasswordVerifyRetries(prefix string) int {
	if prefix == "register_codex" {
		return 3
	}
	return 1
}

func (r *Runner) failCodexJobItem(jobID int64, mailbox domain.Mailbox, prefix string, message string, duration time.Duration) {
	if prefix == "" {
		prefix = "codex"
	}
	_ = r.store.MarkMailboxLoginResult(mailbox.ID, "", message)
	_ = r.store.UpdateJobItem(jobID, mailbox.ID, "failed", message, duration)
	_ = r.store.RecalculateJob(jobID, "")
	r.log(domain.RuntimeLog{JobID: jobID, MailboxID: mailbox.ID, Email: mailbox.Email, Level: "error", Step: prefix + "_failed", Message: message})
}

type codexSMSProvider struct {
	provider smsbiz.Provider
	config   domain.SMSConfig
}

func (p *codexSMSProvider) GetNumber(ctx context.Context) (*codex.SMSActivation, error) {
	activation, err := p.provider.GetNumber(ctx, p.config.ServiceID, p.config.CountryID, p.config.MaxPrice)
	if err != nil {
		return nil, err
	}
	return &codex.SMSActivation{
		ID:               activation.ActivationID,
		PhoneNumber:      activation.PhoneNumber,
		CountryPhoneCode: activation.CountryPhoneCode,
	}, nil
}

func (p *codexSMSProvider) PollCode(ctx context.Context, activationID string) (string, error) {
	return smsbiz.PollForCode(ctx, p.provider, activationID, 150*time.Second, 5*time.Second)
}

func (p *codexSMSProvider) Complete(ctx context.Context, activationID string) error {
	return p.provider.SetStatus(ctx, activationID, 6)
}

func (p *codexSMSProvider) Cancel(ctx context.Context, activationID string) error {
	return p.provider.SetStatus(ctx, activationID, 8)
}

func (r *Runner) log(entry domain.RuntimeLog) {
	entry, err := r.store.AddLog(entry)
	if err != nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for ch := range r.subs[entry.JobID] {
		select {
		case ch <- entry:
		default:
		}
	}
}

func (r *Runner) handleLegacyLog(email, message string) {
	if email == "" {
		return
	}
	r.mu.Lock()
	ctx, ok := r.active[strings.ToLower(email)]
	r.mu.Unlock()
	if !ok {
		return
	}
	stepIndex, stepTotal, step := parseLegacyStep(message)
	if step != "" {
		_ = r.store.MarkMailboxStep(ctx.MailboxID, domain.MailboxStatusRegistering, step, stepIndex, stepTotal, ctx.Proxy)
	}
	r.log(domain.RuntimeLog{JobID: ctx.JobID, MailboxID: ctx.MailboxID, Email: ctx.Email, Level: "info", Step: step, StepIndex: stepIndex, StepTotal: stepTotal, Message: uiLogMessage(message)})

}

func uiLogMessage(message string) string {
	message = strings.TrimSpace(message)
	switch {
	case strings.HasPrefix(message, "Step 1/8"):
		return "Initializing registration session"
	case strings.HasPrefix(message, "Step 2/8"):
		return "Submitting registration password"
	case strings.HasPrefix(message, "Step 3/8"):
		return "Requesting email verification code"
	case strings.HasPrefix(message, "Step 4/8"):
		return "Waiting for and reading email verification code"
	case strings.HasPrefix(message, "Step 5/8"):
		return "Verification code received, validating it"
	case strings.HasPrefix(message, "Step 6/8"):
		return "Verification passed, creating account profile"
	case strings.HasPrefix(message, "Step 7/8"):
		return "Account created, logging in and exchanging token"
	case strings.HasPrefix(message, "Step 8/8"):
		return "Registration complete, token acquired"
	case strings.HasPrefix(message, "Registration flow started"):
		return "Registration flow started"
	case strings.HasPrefix(message, "Registration flow complete") || strings.HasPrefix(message, "Registration flow completed"):
		return "Registration flow completed"
	case strings.HasPrefix(message, "Token refresh login flow started"):
		return "Token refresh login flow started"
	case strings.Contains(message, "submit email request failed"):
		return "Email submission failed, stopping the current flow"
	case strings.Contains(message, "submit email") || strings.Contains(message, "re-submit email"):
		return "Submitting email and confirming the login method"
	case strings.Contains(message, "send login verification code failed"):
		return "Sending the login verification code failed, falling back to password verification"
	case strings.Contains(message, "send login verification code"):
		return "Sending login verification code"
	case strings.Contains(message, "login verification code received"):
		return "Login verification code received, submitting for validation"
	case strings.Contains(message, "login verification code validation failed"):
		return "Login verification code validation failed, falling back to password verification"
	case strings.Contains(message, "login verification code validation passed"):
		return "Login verification code validation passed"
	case strings.Contains(message, "build password_verify"):
		return "Preparing password verification"
	case strings.Contains(message, "submit password verification"):
		return "Submitting password verification"
	case strings.Contains(message, "password verification request failed"):
		return "Password verification request failed"
	case strings.Contains(message, "password verification passed"):
		return "Password verification passed, finishing authorization"
	case strings.Contains(message, "password verification returned"):
		return "Password verification response received"
	case strings.Contains(message, "Start polling email verification code"):
		return "Connecting to mailbox and reading verification code"
	case strings.Contains(message, "Email verification code poll attempt"):
		return "Checking mailbox verification code"
	case strings.Contains(message, "Email verification code fetched successfully"):
		return "Verification code read from mailbox"
	case strings.Contains(message, "Email verification code poll failed"):
		return "Reading mailbox verification code failed this round, retrying shortly"
	case strings.Contains(message, "No verification code found this round"):
		return "No verification code found yet, waiting before the next check"
	case strings.Contains(message, "Email verification code timeout"):
		return "Timed out while reading mailbox verification code"
	case strings.Contains(message, "Connect IMAP"):
		return "Connecting to mailbox server"
	case strings.Contains(message, "IMAP authenticate"):
		return "Authenticating mailbox"
	case strings.Contains(message, "IMAP select INBOX") || strings.Contains(message, "IMAP search all mail"):
		return "Searching inbox mail"
	case strings.Contains(message, "INBOX has no mail"):
		return "No messages in the inbox"
	case strings.Contains(message, "Preparing to inspect the latest") || strings.Contains(message, "Read email"):
		return "Inspecting recent messages"
	case strings.Contains(message, "skipped:"):
		return "Skipped a non-matching email"
	case strings.Contains(message, "did not contain a visible 6-digit code"):
		return "No verification code matched in the email body"
	case strings.Contains(message, "matched a visible 6-digit code"):
		return "Verification code matched in the email body"
	case strings.Contains(message, "access token refreshed successfully"):
		return "Mailbox access token refreshed"
	case strings.HasPrefix(message, "Token refresh login flow completed"):
		return "Token refresh login flow completed"
	default:
		return stripLogDetails(message)
	}
}

func stripLogDetails(message string) string {
	if idx := strings.Index(message, ": "); idx >= 0 && idx+2 < len(message) {
		prefix := message[:idx]
		if strings.Contains(prefix, "Token refresh login") {
			message = message[idx+2:]
		}
	}
	for _, marker := range []string{" status=", " err=", " code=", " endpoint=", " ids=", " id=", " device_id=", " page_type=", " continue_url=", " password_len=", " token=", " context=", " timeout=", " attempt=", " location="} {
		if idx := strings.Index(message, marker); idx >= 0 {
			return strings.TrimSpace(message[:idx])
		}
	}
	return message
}

func (r *Runner) setActive(email string, ctx activeLogContext) {
	r.mu.Lock()
	r.active[strings.ToLower(email)] = ctx
	r.mu.Unlock()
}

func (r *Runner) clearActive(email string) {
	r.mu.Lock()
	delete(r.active, strings.ToLower(email))
	r.mu.Unlock()
}

func (r *Runner) otpFetcher(mailboxID int64, settings legacy.Settings, mailbox legacy.Mailbox, started time.Time) func(context.Context) (string, error) {
	return func(ctx context.Context) (string, error) {
		provider := legacy.OTPProvider{Settings: settings, Mailbox: mailbox, Since: started}
		manual := make(chan string, 1)
		r.mu.Lock()
		r.otp[mailboxID] = manual
		r.mu.Unlock()
		defer func() {
			r.mu.Lock()
			delete(r.otp, mailboxID)
			r.mu.Unlock()
		}()

		fetchCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		type result struct {
			code string
			err  error
		}
		results := make(chan result, 1)
		go func() {
			code, err := provider.Fetch(fetchCtx)
			results <- result{code: code, err: err}
		}()

		for {
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case code := <-manual:
				code = strings.TrimSpace(code)
				if code == "" {
					continue
				}
				cancel()
				return code, nil
			case result := <-results:
				return result.code, result.err
			}
		}
	}
}

func (r *Runner) SubmitOTP(mailboxID int64, code string) error {
	code = strings.TrimSpace(code)
	if code == "" {
		return fmt.Errorf("code is required")
	}
	r.mu.Lock()
	ch := r.otp[mailboxID]
	r.mu.Unlock()
	if ch == nil {
		return fmt.Errorf("mailbox is not waiting for a verification code")
	}
	select {
	case ch <- code:
		return nil
	default:
		return fmt.Errorf("mailbox is already processing a verification code")
	}
}

func parseLegacyStep(message string) (int, int, string) {
	if !strings.HasPrefix(message, "Step ") {
		return 0, 0, ""
	}
	fields := strings.Fields(message)
	if len(fields) < 2 {
		return 0, 0, ""
	}
	parts := strings.Split(fields[1], "/")
	if len(parts) != 2 {
		return 0, 0, ""
	}
	idx, _ := strconv.Atoi(parts[0])
	total, _ := strconv.Atoi(parts[1])
	step := "step_" + parts[0]
	if len(fields) > 2 {
		step = strings.ToLower(strings.ReplaceAll(fields[2], "-", "_"))
	}
	return idx, total, step
}

func legacyPasswordForSettings(settings domain.Settings) string {
	if settings.PasswordMode == "fixed" && settings.FixedPassword != "" {
		return settings.FixedPassword
	}
	return ""
}

func pickProxy(settings domain.Settings) string {
	if settings.ProxyMode == "local" {
		return ""
	}
	if len(settings.Proxies) == 0 {
		return ""
	}
	if settings.ProxyMode == "single" {
		return settings.Proxies[0]
	}
	if settings.ProxyMode == "round_robin" {
		idx := atomic.AddUint64(&roundRobinCounter, 1)
		return settings.Proxies[int(idx-1)%len(settings.Proxies)]
	}
	return settings.Proxies[rand.Intn(len(settings.Proxies))]
}
