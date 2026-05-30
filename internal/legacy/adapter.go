package legacy

import (
	"context"

	"github.com/79E/auto-openai-account/internal/domain"
)

func CompactTokenJSON(tokens map[string]any) string {
	return compactTokenJSON(tokens)
}

func MailboxFromDomain(item domain.Mailbox) Mailbox {
	return Mailbox{
		ID:               item.ID,
		Email:            item.Email,
		Password:         item.Password,
		ClientID:         item.ClientID,
		AccessToken:      item.AccessToken,
		Status:           item.Status,
		StatusText:       item.StatusText,
		RegisterPassword: item.RegisterPassword,
		TokenJSON:        item.TokenJSON,
		Remark:           item.Remark,
		LastError:        item.LastError,
		RegisteredAt:     item.RegisteredAt,
		LastLoginAt:      item.LastLoginAt,
		CreatedAt:        item.CreatedAt,
		UpdatedAt:        item.UpdatedAt,
	}
}

func SettingsFromDomain(settings domain.Settings, proxy string) Settings {
	return Settings{
		Proxy:                  proxy,
		PasswordMode:           settings.PasswordMode,
		FixedPassword:          settings.FixedPassword,
		RegisterConcurrency:    settings.RegisterConcurrency,
		OTPTimeoutSeconds:      settings.OTPTimeoutSeconds,
		OTPPollIntervalSeconds: settings.OTPPollIntervalSeconds,
		IMAPHost:               settings.IMAPHost,
		IMAPPort:               settings.IMAPPort,
		IMAPAuthMode:           settings.IMAPAuthMode,
		Listen:                 settings.Listen,
	}
}

func TestMailboxIMAP(ctx context.Context, mailbox domain.Mailbox, settings domain.Settings, proxy string) error {
	legacyMailbox := MailboxFromDomain(mailbox)
	legacySettings := SettingsFromDomain(settings, proxy)
	return testMailboxIMAP(ctx, legacyMailbox, legacySettings)
}
