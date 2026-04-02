// Supabase Edge Function: notify-expiring-plates
// Runs daily via cron. Emails residents whose plates expire within 72 hours.
// Requires RESEND_API_KEY env var and SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "noreply@lotlogic.com";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

interface ResidentPlate {
  id: string;
  plate_text: string;
  holder_name: string;
  unit_number: string;
  email: string;
  plate_expiration: string;
  property_id: string;
}

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY) {
    console.log(`[DRY RUN] Would email ${to}: ${subject}`);
    return true;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`Failed to send email to ${to}: ${err}`);
    return false;
  }
  return true;
}

function buildEmailHtml(resident: ResidentPlate, propertyName: string): string {
  const expDate = new Date(resident.plate_expiration).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 32px 24px; background: #f9fafb; border-radius: 12px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="display: inline-block; background: linear-gradient(135deg, #3b82f6, #1d4ed8); color: #fff; font-weight: 900; font-size: 18px; width: 48px; height: 48px; line-height: 48px; border-radius: 12px;">LL</div>
        <h1 style="font-size: 20px; color: #1a1a2e; margin: 8px 0 0;">LotLogic</h1>
      </div>
      <h2 style="font-size: 18px; color: #1a1a2e; text-align: center;">Vehicle Registration Expiring Soon</h2>
      <p style="font-size: 14px; color: #4b5563; line-height: 1.6;">
        Hi ${resident.holder_name},
      </p>
      <p style="font-size: 14px; color: #4b5563; line-height: 1.6;">
        Your vehicle registration for plate <strong style="color: #1a1a2e; font-family: monospace; letter-spacing: 0.05em;">${resident.plate_text}</strong>
        at <strong>${propertyName}</strong> (Unit ${resident.unit_number}) is expiring on:
      </p>
      <div style="text-align: center; margin: 20px 0;">
        <div style="display: inline-block; background: rgba(251,191,36,0.15); border: 1px solid rgba(251,191,36,0.3); color: #92400e; padding: 12px 24px; border-radius: 10px; font-size: 16px; font-weight: 700;">
          ${expDate}
        </div>
      </div>
      <p style="font-size: 14px; color: #4b5563; line-height: 1.6;">
        You have <strong>72 hours</strong> to update your vehicle registration to avoid potential enforcement action.
        Please contact your leasing office or update your registration as soon as possible.
      </p>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
      <p style="font-size: 12px; color: #9ca3af; text-align: center;">
        This is an automated notification from LotLogic parking management.
      </p>
    </div>
  `;
}

Deno.serve(async (_req: Request) => {
  try {
    const now = new Date();
    const in72h = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    const todayStr = now.toISOString().split("T")[0];
    const in72hStr = in72h.toISOString().split("T")[0];

    // Find active residents with plates expiring within 72 hours who haven't been notified
    const { data: expiring, error: fetchErr } = await supabase
      .from("resident_plates")
      .select("id, plate_text, holder_name, unit_number, email, plate_expiration, property_id")
      .eq("active", true)
      .not("email", "is", null)
      .gte("plate_expiration", todayStr)
      .lte("plate_expiration", in72hStr)
      .is("expiry_notified_at", null);

    if (fetchErr) {
      console.error("Fetch error:", fetchErr);
      return new Response(JSON.stringify({ error: fetchErr.message }), { status: 500 });
    }

    if (!expiring || expiring.length === 0) {
      return new Response(JSON.stringify({ message: "No expiring plates to notify", count: 0 }));
    }

    // Load property names for the email body
    const propertyIds = [...new Set(expiring.map((r: ResidentPlate) => r.property_id))];
    const { data: properties } = await supabase
      .from("properties")
      .select("id, name")
      .in("id", propertyIds);

    const propMap: Record<string, string> = {};
    (properties || []).forEach((p: { id: string; name: string }) => {
      propMap[p.id] = p.name;
    });

    let sentCount = 0;
    for (const resident of expiring as ResidentPlate[]) {
      const propertyName = propMap[resident.property_id] || "your property";
      const html = buildEmailHtml(resident, propertyName);
      const sent = await sendEmail(
        resident.email,
        "Your vehicle registration expires soon - action required",
        html
      );

      if (sent) {
        await supabase
          .from("resident_plates")
          .update({ expiry_notified_at: now.toISOString() })
          .eq("id", resident.id);
        sentCount++;
      }
    }

    return new Response(
      JSON.stringify({ message: `Notified ${sentCount} resident(s)`, count: sentCount }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
