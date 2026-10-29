// Emails any unsent alerts to each company's alert_email via Resend.
// Needs secrets: RESEND_API_KEY and (optional) MAIL_FROM. Without a key it does nothing.
import { createClient } from "npm:@supabase/supabase-js@2";
Deno.serve(async () => {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return new Response("RESEND_API_KEY not set", { status: 200 });
  const from = Deno.env.get("MAIL_FROM") ?? "Kovi <onboarding@resend.dev>";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: alerts } = await db.from("alerts").select("id, message, kind, created_at, company_id, companies(name, alert_email)").eq("emailed", false).limit(50);
  let sent = 0;
  for (const a of alerts ?? []) {
    const co = (a as any).companies;
    if (!co?.alert_email) { await db.from("alerts").update({ emailed: true }).eq("id", a.id); continue; }
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [co.alert_email], subject: `Kovi alert: ${a.kind === "defect" ? "defect reported" : "check not verified"}`,
        text: `${a.message}\n\n${co.name} · ${new Date(a.created_at).toLocaleString("en-GB")}\nOpen Kovi to see the check.` }),
    });
    if (r.ok) { await db.from("alerts").update({ emailed: true }).eq("id", a.id); sent++; } else console.error(await r.text());
  }
  return new Response(`sent ${sent}`);
});
