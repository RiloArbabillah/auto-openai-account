import { Link } from "react-router-dom";
import { MessageSquareText, PlugZap } from "lucide-react";
import { Badge } from "../../components/Badge/Badge";
import { Card } from "../../components/Card/Card";

export function PluginsPage() {
  const plugins = [
    {
      name: "openai-provider",
      status: "Integrated",
      desc: "Handles OpenAI registration, login, and token exchange flows.",
    },
    {
      name: "mail-outlook",
      status: "Integrated",
      desc: "Handles Outlook mailbox authentication and email retrieval.",
    },
    {
      name: "openai-otp",
      status: "Integrated",
      desc: "Generic OTP parser that extracts OpenAI verification codes from email HTML and plain text.",
    },
    {
      name: "proxy-pool",
      status: "Implemented",
      desc: "Handles proxy storage, testing, and proxy selection for jobs.",
    },
    {
      name: "sms-provider",
      status: "Integrated",
      desc: "Handles phone number acquisition and SMS polling through Hero SMS and SMSBower.",
      action: (
        <Link
          to="/sms"
          className="inline-flex items-center gap-2 rounded-xl border bg-white px-3 py-2 text-sm font-bold"
        >
          <MessageSquareText size={16} />
          SMS Settings
        </Link>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <Card title="Plugin List" icon={<PlugZap size={18} />}>
        <p className="text-sm text-slate-500">Currently integrated functional plugins.</p>
      </Card>
      <div className="grid gap-3 md:grid-cols-2">
        {plugins.map((p) => (
          <Card key={p.name} title={p.name} icon={<PlugZap size={18} />} actions={p.action}>
            <div className="mb-3">
              <Badge status="success" text={p.status} />
            </div>
            <p className="text-sm leading-6 text-slate-500">{p.desc}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
