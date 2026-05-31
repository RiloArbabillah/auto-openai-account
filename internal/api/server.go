package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/79E/auto-openai-account/internal/domain"
	"github.com/79E/auto-openai-account/internal/legacy"
	"github.com/79E/auto-openai-account/internal/proxypool"
	"github.com/79E/auto-openai-account/internal/runner"
	"github.com/79E/auto-openai-account/internal/smsbiz"
	"github.com/79E/auto-openai-account/internal/storage"
	"github.com/79E/auto-openai-account/internal/webui"
)

type Server struct {
	store  *storage.Store
	runner *runner.Runner
}

func New(store *storage.Store, runner *runner.Runner) *Server {
	return &Server{store: store, runner: runner}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/settings", s.handleSettings)
	mux.HandleFunc("/api/mailboxes/import", s.handleMailboxImport)
	mux.HandleFunc("/api/mailboxes/", s.handleMailboxByID)
	mux.HandleFunc("/api/mailboxes", s.handleMailboxes)
	mux.HandleFunc("/api/register-jobs/", s.handleRegisterJobByID)
	mux.HandleFunc("/api/register-jobs", s.handleRegisterJobs)
	mux.HandleFunc("/api/login-jobs", s.handleLoginJobs)
	mux.HandleFunc("/api/proxy/import-url", s.handleProxyImportURL)
	mux.HandleFunc("/api/proxy/test", s.handleProxyTest)
	mux.HandleFunc("/api/sms/catalog", s.handleSMSCatalog)
	mux.HandleFunc("/api/stats", s.handleStats)
	mux.Handle("/", webui.Handler())
	return mux
}

func (s *Server) handleSMSCatalog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Platform string `json:"platform"`
		APIKey   string `json:"api_key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid json body"))
		return
	}
	catalog, err := smsbiz.FetchCatalog(r.Context(), body.Platform, body.APIKey)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, catalog)
}

func (s *Server) handleProxyTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Proxy          string   `json:"proxy"`
		Proxies        []string `json:"proxies"`
		TimeoutSeconds int      `json:"timeout_seconds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid json body"))
		return
	}
	timeout := time.Duration(body.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 25 * time.Second
	}
	candidates := body.Proxies
	if body.Proxy != "" {
		candidates = []string{body.Proxy}
	}
	if len(candidates) == 0 {
		writeError(w, http.StatusBadRequest, fmt.Errorf("proxy is required"))
		return
	}
	results := make([]proxypool.TestResult, 0, len(candidates))
	for _, candidate := range candidates {
		results = append(results, proxypool.Test(r.Context(), candidate, timeout))
	}
	persisted := make([]domain.ProxyTestResult, 0, len(results))
	for _, result := range results {
		persisted = append(persisted, domain.ProxyTestResult{
			Proxy:       result.Proxy,
			OK:          result.OK,
			IP:          result.IP,
			Country:     result.Country,
			CountryCode: result.CountryCode,
			LatencyMS:   result.LatencyMS,
			Error:       result.Error,
		})
	}
	if err := s.store.SaveProxyTestResults(persisted); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": results})
}

func (s *Server) handleProxyImportURL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid json body"))
		return
	}
	target := strings.TrimSpace(body.URL)
	if target == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("url is required"))
		return
	}
	parsed, err := url.Parse(target)
	if err != nil || parsed.Host == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid url"))
		return
	}
	if parsed.Scheme != "https" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("only https urls are supported"))
		return
	}
	if !strings.EqualFold(parsed.Hostname(), "api.proxyscrape.com") {
		writeError(w, http.StatusBadRequest, fmt.Errorf("only api.proxyscrape.com is supported"))
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid url"))
		return
	}
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Errorf("fetch proxy url: %w", err))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		writeError(w, http.StatusBadGateway, fmt.Errorf("proxy source returned status %d", resp.StatusCode))
		return
	}
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 5<<20))
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Errorf("read proxy source: %w", err))
		return
	}
	items, err := parseProxyImportPayload(payload)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
}

func parseProxyImportPayload(payload []byte) ([]string, error) {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 {
		return nil, fmt.Errorf("proxy source is empty")
	}
	type proxyImportItem struct {
		Proxy string `json:"proxy"`
	}
	var jsonBody struct {
		Proxies []proxyImportItem `json:"proxies"`
	}
	if err := json.Unmarshal(trimmed, &jsonBody); err == nil && len(jsonBody.Proxies) > 0 {
		items := make([]string, 0, len(jsonBody.Proxies))
		for _, item := range jsonBody.Proxies {
			proxy := strings.TrimSpace(item.Proxy)
			if !isSupportedProxyURL(proxy) {
				continue
			}
			items = append(items, proxy)
		}
		items = uniqueProxyURLsByHost(items)
		if len(items) == 0 {
			return nil, fmt.Errorf("proxy source did not contain any supported proxy urls")
		}
		return items, nil
	}
	lines := strings.Split(string(trimmed), "\n")
	items := make([]string, 0, len(lines))
	for _, line := range lines {
		proxy := strings.TrimSpace(line)
		if proxy == "" {
			continue
		}
		if !isSupportedProxyURL(proxy) {
			continue
		}
		items = append(items, proxy)
	}
	items = uniqueProxyURLsByHost(items)
	if len(items) == 0 {
		return nil, fmt.Errorf("proxy source did not contain any supported proxy urls")
	}
	return items, nil
}

func isSupportedProxyURL(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https", "socks5", "socks5h":
		return true
	default:
		return false
	}
}

func uniqueProxyURLsByHost(items []string) []string {
	seen := make(map[string]struct{}, len(items))
	result := make([]string, 0, len(items))
	for _, item := range items {
		key := proxyURLHostKey(item)
		if key == "" {
			key = item
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, item)
	}
	return result
}

func proxyURLHostKey(value string) string {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	port := parsed.Port()
	family := proxySchemeFamily(parsed.Scheme)
	if host == "" || port == "" || family == "" {
		return ""
	}
	return family + ":" + host + ":" + port
}

func proxySchemeFamily(scheme string) string {
	switch strings.ToLower(strings.TrimSpace(scheme)) {
	case "socks5", "socks5h":
		return "socks"
	case "http", "https":
		return "http"
	default:
		return ""
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "auto-openai-account"})
}

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		settings, err := s.store.LoadSettings()
		if err != nil {
			writeError(w, 500, err)
			return
		}
		writeJSON(w, 200, settings)
	case http.MethodPut, http.MethodPost:
		var settings domain.Settings
		if err := json.NewDecoder(r.Body).Decode(&settings); err != nil {
			writeError(w, 400, fmt.Errorf("invalid json body"))
			return
		}
		if err := s.store.SaveSettings(settings); err != nil {
			writeError(w, 500, err)
			return
		}
		settings, _ = s.store.LoadSettings()
		writeJSON(w, 200, map[string]any{"ok": true, "settings": settings})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleMailboxImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, 400, fmt.Errorf("invalid json body"))
		return
	}
	items, parseErrors := parseMailboxImport(body.Text)
	imported, skipped, rowErrors, err := s.store.ImportMailboxes(items)
	if err != nil {
		writeError(w, 500, err)
		return
	}
	errs := append(parseErrors, rowErrors...)
	writeJSON(w, 200, map[string]any{"imported": imported, "skipped": skipped, "failed": len(errs), "errors": errs})
}

func (s *Server) handleMailboxes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	pageSize, _ := strconv.Atoi(q.Get("page_size"))
	result, err := s.store.ListMailboxes(q.Get("status"), page, pageSize)
	if err != nil {
		writeError(w, 500, err)
		return
	}
	writeJSON(w, 200, result)
}

func (s *Server) handleMailboxByID(w http.ResponseWriter, r *http.Request) {
	id, suffix, ok := parseIDPath(r.URL.Path, "/api/mailboxes/")
	if !ok {
		http.NotFound(w, r)
		return
	}
	if suffix == "token" {
		s.handleMailboxToken(w, r, id)
		return
	}
	if suffix == "login" {
		s.handleMailboxLogin(w, r, id)
		return
	}
	if suffix == "test" {
		s.handleMailboxTest(w, r, id)
		return
	}
	if suffix == "otp" {
		s.handleMailboxOTP(w, r, id)
		return
	}
	if suffix != "" {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodGet:
		item, found, err := s.store.GetMailbox(id)
		if err != nil {
			writeError(w, 500, err)
			return
		}
		if !found {
			writeError(w, 404, fmt.Errorf("mailbox not found"))
			return
		}
		writeJSON(w, 200, map[string]any{"item": item})
	case http.MethodPut, http.MethodPost:
		updates := map[string]any{}
		if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
			writeError(w, 400, fmt.Errorf("invalid json body"))
			return
		}
		item, found, err := s.store.UpdateMailbox(id, updates)
		if err != nil {
			writeError(w, 500, err)
			return
		}
		if !found {
			writeError(w, 404, fmt.Errorf("mailbox not found"))
			return
		}
		writeJSON(w, 200, map[string]any{"item": item})
	case http.MethodDelete:
		deleted, err := s.store.DeleteMailbox(id)
		if err != nil {
			writeError(w, 500, err)
			return
		}
		if !deleted {
			writeError(w, 404, fmt.Errorf("mailbox not found"))
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleMailboxToken(w http.ResponseWriter, r *http.Request, id int64) {
	item, found, err := s.store.GetMailbox(id)
	if err != nil {
		writeError(w, 500, err)
		return
	}
	if !found {
		writeError(w, 404, fmt.Errorf("mailbox not found"))
		return
	}
	var token any
	if item.TokenJSON != "" {
		_ = json.Unmarshal([]byte(item.TokenJSON), &token)
	}
	writeJSON(w, 200, map[string]any{"email": item.Email, "token_json": token})
}
func (s *Server) handleMailboxLogin(w http.ResponseWriter, r *http.Request, id int64) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	mailbox, found, err := s.store.GetMailbox(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, fmt.Errorf("mailbox not found"))
		return
	}
	job, err := s.runner.StartLogin([]int64{mailbox.ID}, "", "")
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "queued": true, "job": job})
}

func (s *Server) handleMailboxTest(w http.ResponseWriter, r *http.Request, id int64) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	mailbox, found, err := s.store.GetMailbox(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, fmt.Errorf("mailbox not found"))
		return
	}
	settings, err := s.store.LoadSettings()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := legacy.TestMailboxIMAP(r.Context(), mailbox, settings, ""); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("%s", legacy.ExplainError(err.Error())))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "Mailbox IMAP connection succeeded"})
}

func (s *Server) handleMailboxOTP(w http.ResponseWriter, r *http.Request, id int64) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if _, found, err := s.store.GetMailbox(id); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	} else if !found {
		writeError(w, http.StatusNotFound, fmt.Errorf("mailbox not found"))
		return
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid json body"))
		return
	}
	if err := s.runner.SubmitOTP(id, body.Code); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "Verification code submitted"})
}

func (s *Server) handleLoginJobs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		MailboxIDs    []int64 `json:"mailbox_ids"`
		Flow          string  `json:"flow"`
		SMSConfigName string  `json:"sms_config_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid json body"))
		return
	}
	job, err := s.runner.StartLogin(body.MailboxIDs, body.Flow, body.SMSConfigName)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) handleRegisterJobs(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		q := r.URL.Query()
		page, _ := strconv.Atoi(q.Get("page"))
		pageSize, _ := strconv.Atoi(q.Get("page_size"))
		result, err := s.store.ListJobs(page, pageSize)
		if err != nil {
			writeError(w, 500, err)
			return
		}
		writeJSON(w, 200, result)
	case http.MethodPost:
		var body struct {
			Count         int    `json:"count"`
			Flow          string `json:"flow"`
			SMSConfigName string `json:"sms_config_name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, 400, fmt.Errorf("invalid json body"))
			return
		}
		job, err := s.runner.Start(body.Count, body.Flow, body.SMSConfigName)
		if err != nil {
			writeError(w, 400, err)
			return
		}
		writeJSON(w, 200, job)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleRegisterJobByID(w http.ResponseWriter, r *http.Request) {
	id, suffix, ok := parseIDPath(r.URL.Path, "/api/register-jobs/")
	if !ok {
		http.NotFound(w, r)
		return
	}
	switch suffix {
	case "stop":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if err := s.runner.Stop(id); err != nil {
			writeError(w, 500, err)
			return
		}
		job, _ := s.store.GetJob(id, true)
		writeJSON(w, 200, map[string]any{"ok": true, "job": job})
	case "logs":
		logs, err := s.store.ListLogs(id, 0, 300)
		if err != nil {
			writeError(w, 500, err)
			return
		}
		writeJSON(w, 200, map[string]any{"items": logs})
	case "tokens":
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		job, err := s.store.GetJob(id, false)
		if err != nil {
			writeError(w, 404, fmt.Errorf("register job not found"))
			return
		}
		if job.Status != domain.JobStatusFinished && job.Status != domain.JobStatusStopped {
			writeError(w, 400, fmt.Errorf("only finished or stopped jobs can export tokens"))
			return
		}
		items, err := s.store.ListJobTokenExports(id)
		if err != nil {
			writeError(w, 500, err)
			return
		}
		writeJSON(w, 200, map[string]any{"count": len(items), "items": items})
	case "events":
		s.handleJobEvents(w, r, id)
	case "":
		switch r.Method {
		case http.MethodGet:
			job, err := s.store.GetJob(id, true)
			if err != nil {
				writeError(w, 404, fmt.Errorf("register job not found"))
				return
			}
			writeJSON(w, 200, job)
		case http.MethodDelete:
			deleted, err := s.store.DeleteJob(id)
			if err != nil {
				writeError(w, 400, err)
				return
			}
			if !deleted {
				writeError(w, 404, fmt.Errorf("register job not found"))
				return
			}
			writeJSON(w, 200, map[string]any{"ok": true})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) handleJobEvents(w http.ResponseWriter, r *http.Request, jobID int64) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, 500, fmt.Errorf("streaming unsupported"))
		return
	}
	ch, unsubscribe := s.runner.Subscribe(jobID)
	defer unsubscribe()
	for {
		select {
		case <-r.Context().Done():
			return
		case entry := <-ch:
			data, _ := json.Marshal(entry)
			fmt.Fprintf(w, "event: log\ndata: %s\n\n", data)
			flusher.Flush()
		}
	}
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	statuses := []string{domain.MailboxStatusNew, domain.MailboxStatusRegistering, domain.MailboxStatusRegistered, domain.MailboxStatusLogining, domain.MailboxStatusAbnormal}
	mailboxes := map[string]int{}
	for _, status := range statuses {
		count, _ := s.store.CountMailboxesByStatus(status)
		mailboxes[status] = count
	}
	jobs, _ := s.store.ListJobs(1, 100)
	jobStats := map[string]int{"total": jobs.Total}
	for _, job := range jobs.Items {
		jobStats[job.Status]++
	}
	writeJSON(w, 200, map[string]any{"mailboxes": mailboxes, "jobs": jobStats})
}

var uuidRE = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

func parseMailboxImport(text string) ([]domain.Mailbox, []string) {
	var items []domain.Mailbox
	var errs []string
	for idx, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "----")
		if len(parts) < 2 {
			errs = append(errs, fmt.Sprintf("line %d: invalid format", idx+1))
			continue
		}
		item := domain.Mailbox{Email: strings.TrimSpace(parts[0]), Password: strings.TrimSpace(parts[1])}
		if len(parts) == 3 {
			a := strings.TrimSpace(parts[2])
			if uuidRE.MatchString(a) || strings.HasPrefix(a, "app_") {
				item.ClientID = a
			} else {
				item.AccessToken = a
			}
		}
		if len(parts) >= 4 {
			a, b := strings.TrimSpace(parts[2]), strings.TrimSpace(parts[3])
			item.ClientID, item.AccessToken = resolveOAuthFields(a, b)
		}
		items = append(items, item)
	}
	return items, errs
}

func resolveOAuthFields(a, b string) (clientID, accessToken string) {
	aIsUUID := uuidRE.MatchString(a)
	bIsUUID := uuidRE.MatchString(b)
	aIsApp := strings.HasPrefix(a, "app_")
	bIsApp := strings.HasPrefix(b, "app_")
	aIsToken := len(a) > 40
	bIsToken := len(b) > 40

	if (aIsUUID || aIsApp) && !(bIsUUID || bIsApp) {
		return a, b
	}
	if (bIsUUID || bIsApp) && !(aIsUUID || aIsApp) {
		return b, a
	}
	if aIsToken && !bIsToken {
		return b, a
	}
	if bIsToken && !aIsToken {
		return a, b
	}
	if len(a) < len(b) {
		return a, b
	}
	return b, a
}
func parseIDPath(path, prefix string) (int64, string, bool) {
	if !strings.HasPrefix(path, prefix) {
		return 0, "", false
	}
	rest := strings.Trim(strings.TrimPrefix(path, prefix), "/")
	parts := strings.Split(rest, "/")
	if len(parts) == 0 || parts[0] == "" {
		return 0, "", false
	}
	id, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || id <= 0 {
		return 0, "", false
	}
	suffix := ""
	if len(parts) > 1 {
		suffix = strings.Join(parts[1:], "/")
	}
	return id, suffix, true
}
func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(payload)
}
func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]any{"error": err.Error()})
}
